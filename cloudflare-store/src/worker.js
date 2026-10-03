// Irons Pub Bingo team store on Cloudflare: one Durable Object per event.
//
// Routes (event code = 3 to 40 of a-z, 0-9, -):
//   POST /e/<code>              the plugin's sync, exactly as the Apps Script /exec URL takes it
//   GET  /e/<code>              the player portal
//   GET  /e/<code>/data         the portal's live data (JSON)
//   POST /e/<code>/rpc          the portal's request form
//   GET  /e/<code>/admin        the admin page
//   POST /e/<code>/admin/api    admin actions (Authorization: Bearer <ADMIN_TOKEN>)
//   GET  /assets/logo.png, /assets/icon.png
//
// The Durable Object runs the Apps Script store unchanged (built into a module by build.mjs)
// against stand-ins for the Google services. A Durable Object handles one request at a time,
// which is what the script's lock pretended to do: concurrent syncs simply queue for a few
// milliseconds instead of waiting on a lock for seconds.
import { loadStore } from './generated/store-script.js';
import { Sheet, Spreadsheet, createGoogle } from './google.js';
import { adminPage } from './admin-page.js';
import { portalPage } from './portal-page.js';
import { eventData, summarizeBoard } from './data.js';
import { LOGO_PNG, ICON_PNG } from './generated/assets.js';

const EVENT_CODE = /^[a-z0-9-]{3,40}$/;
const ASSETS = { '/assets/logo.png': LOGO_PNG, '/assets/icon.png': ICON_PNG };
// Days of request counts kept for the admin page's Usage view.
const USAGE_DAYS = 14;
// Admin actions that map onto the store's own menu functions.
const TAB_EDIT_ACTIONS = ['Teams', 'Board code', 'Settings', 'Adjustments', 'Requests'];

export default {
	async fetch(request, env)
	{
		const url = new URL(request.url);
		if (ASSETS[url.pathname])
		{
			const bytes = Uint8Array.from(atob(ASSETS[url.pathname]), c => c.charCodeAt(0));
			return new Response(bytes, { headers: { 'content-type': 'image/png',
				'cache-control': 'public, max-age=604800' } });
		}
		const match = url.pathname.match(/^\/e\/([^/]+)(\/.*)?$/);
		if (!match)
		{
			return new Response('Irons Pub Bingo team store. Event URLs look like /e/<event-code>.',
				{ headers: { 'content-type': 'text/plain; charset=utf-8' } });
		}
		const code = match[1].toLowerCase();
		if (!EVENT_CODE.test(code))
		{
			return new Response('Unknown event', { status: 404 });
		}
		const stub = env.BINGO_EVENT.get(env.BINGO_EVENT.idFromName(code));
		return stub.fetch(request);
	}
};

export class BingoEvent
{
	constructor(state, env)
	{
		this.state = state;
		this.env = env;
		this.ready = null;
	}

	async fetch(request)
	{
		this.ready = this.ready || this.load();
		await this.ready;
		this.countRequest();
		const url = new URL(request.url);
		const rest = (url.pathname.match(/^\/e\/[^/]+(\/.*)?$/) || [])[1] || '';
		try
		{
			if (rest === '' || rest === '/')
			{
				if (request.method === 'POST')
				{
					const contents = await request.text();
					return await this.run(() => this.store.doPost({ postData: { contents } }),
						out => json(out.getContent()));
				}
				const params = Object.fromEntries(url.searchParams);
				if (params.board)
				{
					return await this.run(() => this.store.doGet({ parameter: params }), out => json(out.getContent()));
				}
				return html(portalPage());
			}
			if (rest === '/data')
			{
				return await this.run(() => eventData(this.store, this.spreadsheet, false),
					out => json(JSON.stringify(out), 200, { 'cache-control': 'no-store' }));
			}
			if (rest === '/rpc' && request.method === 'POST')
			{
				return await this.rpc(await request.json());
			}
			if (rest === '/admin')
			{
				return html(adminPage());
			}
			if (rest === '/admin/api' && request.method === 'POST')
			{
				// Read the body first: the runtime complains about an unread one.
				const text = await request.text();
				if (!this.authorized(request))
				{
					return json(JSON.stringify({ error: 'Wrong admin token' }), 401);
				}
				return await this.admin(JSON.parse(text || '{}'));
			}
			return new Response('Not found', { status: 404 });
		}
		catch (err)
		{
			console.error('Store request failed', err);
			return json(JSON.stringify({ error: 'Store error' }), 500);
		}
	}

	// ------------------------------------------------------------------ store plumbing

	/**
	 * Counts requests per UTC day for the admin page. Saved along with other changes, or
	 * every 25 requests, so counting never costs a storage write per request.
	 */
	countRequest()
	{
		const day = new Date().toISOString().slice(0, 10);
		this.usage.days[day] = (this.usage.days[day] || 0) + 1;
		const keep = Object.keys(this.usage.days).sort().slice(-USAGE_DAYS);
		for (const old of Object.keys(this.usage.days))
		{
			if (keep.indexOf(old) < 0)
			{
				delete this.usage.days[old];
			}
		}
		this.unsavedRequests++;
	}

	/** Restores the event's tabs and properties from storage into memory. */
	async load()
	{
		this.spreadsheet = new Spreadsheet();
		this.properties = new Map();
		this.cache = new Map();
		this.persisted = new Map(); // tab -> JSON string per row, as last written
		const tabs = (await this.state.storage.get('tabs')) || [];
		const rows = await this.state.storage.list({ prefix: 'row:' });
		for (const tab of tabs)
		{
			const data = [];
			const stored = [];
			for (let i = 0; i < tab.rows; i++)
			{
				const text = rows.get('row:' + tab.name + ':' + i) || '[]';
				stored.push(text);
				data.push(JSON.parse(text));
			}
			this.spreadsheet.sheets.set(tab.name, new Sheet(tab.name, data, tab.hidden));
			this.persisted.set(tab.name, stored);
		}
		this.usage = (await this.state.storage.get('usage')) || { days: {} };
		this.usageSaved = JSON.stringify(this.usage);
		this.unsavedRequests = 0;
		const props = (await this.state.storage.get('props')) || {};
		for (const key of Object.keys(props))
		{
			this.properties.set(key, props[key]);
		}
		this.propsText = JSON.stringify(props);
		this.google = createGoogle(this.spreadsheet, this.properties, this.cache);
		this.store = loadStore(this.google);
	}

	/**
	 * Runs one store call, saves whatever it changed, sends the Discord posts it queued,
	 * and turns its output into a response.
	 */
	async run(call, respond)
	{
		this.google.alerts.length = 0;
		const output = call();
		// The script's doPost renders Board tabs after its "lock" and flushes the webhook
		// queue itself; here everything ran synchronously, so just persist and send.
		await this.persist();
		this.sendOutbox();
		return respond(output);
	}

	/** Writes the rows that changed since the last write, and deletes the ones that went. */
	async persist()
	{
		const puts = {};
		const deletes = [];
		const tabs = [];
		for (const sheet of this.spreadsheet.getSheets())
		{
			const before = this.persisted.get(sheet.name) || [];
			const after = sheet.data.map(row => JSON.stringify(row || []));
			for (let i = 0; i < after.length; i++)
			{
				if (after[i] !== before[i])
				{
					puts['row:' + sheet.name + ':' + i] = after[i];
				}
			}
			for (let i = after.length; i < before.length; i++)
			{
				deletes.push('row:' + sheet.name + ':' + i);
			}
			this.persisted.set(sheet.name, after);
			tabs.push({ name: sheet.name, rows: after.length, hidden: !!sheet.hidden });
		}
		for (const [name, before] of this.persisted)
		{
			if (!this.spreadsheet.sheets.has(name))
			{
				before.forEach((_, i) => deletes.push('row:' + name + ':' + i));
				this.persisted.delete(name);
			}
		}
		const tabsText = JSON.stringify(tabs);
		if (tabsText !== this.tabsText)
		{
			puts.tabs = tabs;
			this.tabsText = tabsText;
		}
		const props = Object.fromEntries(this.properties);
		const propsText = JSON.stringify(props);
		if (propsText !== this.propsText)
		{
			puts.props = props;
			this.propsText = propsText;
		}
		if (this.unsavedRequests && (Object.keys(puts).length || deletes.length || this.unsavedRequests >= 25))
		{
			puts.usage = this.usage;
			this.unsavedRequests = 0;
		}
		const keys = Object.keys(puts);
		for (let i = 0; i < keys.length; i += 128)
		{
			const batch = {};
			keys.slice(i, i + 128).forEach(key => (batch[key] = puts[key]));
			await this.state.storage.put(batch);
		}
		for (let i = 0; i < deletes.length; i += 128)
		{
			await this.state.storage.delete(deletes.slice(i, i + 128));
		}
	}

	/** Sends queued Discord posts in the background; the reply does not wait for them. */
	sendOutbox()
	{
		const outbox = this.google.outbox.splice(0);
		for (const message of outbox)
		{
			const send = fetch(message.url, {
				method: (message.options.method || 'post').toUpperCase(),
				headers: { 'content-type': message.options.contentType || 'application/json' },
				body: message.options.payload
			}).catch(err => console.error('Webhook post failed', err));
			if (this.state.waitUntil)
			{
				this.state.waitUntil(send);
			}
		}
	}

	// ------------------------------------------------------------------ portal form

	/** The portal's request form, which on Apps Script went through google.script.run. */
	async rpc(body)
	{
		if (!body || body.fn !== 'submitFormRequest')
		{
			return json(JSON.stringify({ error: 'Unknown call' }), 400);
		}
		let result;
		let error;
		await this.run(() =>
		{
			try
			{
				result = this.store.submitFormRequest((body.args || [])[0]);
			}
			catch (err)
			{
				error = err && err.message ? err.message : String(err);
			}
		}, () => null);
		return json(JSON.stringify(error ? { error } : { result }));
	}

	// ------------------------------------------------------------------ admin

	authorized(request)
	{
		const expected = String(this.env.ADMIN_TOKEN || '');
		const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
		if (!expected || given.length !== expected.length)
		{
			return false;
		}
		let diff = 0;
		for (let i = 0; i < expected.length; i++)
		{
			diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
		}
		return diff === 0;
	}

	/**
	 * Admin actions. Tabs are edited whole, then handed to the store's own onEdit for
	 * every changed row, exactly as a hand edit in the sheet would be: a Status change
	 * approves or rejects, a config edit clears the config cache, a ledger row is stamped.
	 */
	async admin(body)
	{
		const action = body && body.action;
		let result = null;
		const response = await this.run(() =>
		{
			const store = this.store;
			switch (action)
			{
				case 'tabs':
					store.onOpen(); // makes sure the tabs admins type into exist
					result = this.spreadsheet.getSheets().map(s => ({ name: s.name, hidden: !!s.hidden, rows: s.data.length }));
					break;
				case 'getTab':
				{
					const sheet = this.spreadsheet.getSheetByName(String(body.name || ''));
					result = sheet ? sheet.data : null;
					break;
				}
				case 'setTab':
					result = this.editTab(String(body.name || ''), body.rows);
					break;
				case 'applyBoardUpdate':
					store.applyBoardUpdate();
					break;
				case 'refreshViews':
					store.refreshAllViews();
					break;
				case 'resetTile':
					this.google.alerts.push(store.lockedTileReset(String(body.team || '').toLowerCase(),
						parseInt(body.tile, 10)));
					break;
				case 'resetStore':
					store.resetStoreData();
					break;
				case 'overview':
					store.onOpen();
					result = eventData(store, this.spreadsheet, true);
					result.usage = this.usage;
					break;
				case 'setRequestStatus':
					result = this.setRequestStatus(String(body.id || ''), String(body.status || ''));
					break;
				case 'addAdjustment':
					result = this.addAdjustment(body);
					break;
				case 'deleteAdjustment':
					result = this.deleteAdjustment(parseInt(body.row, 10), String(body.fingerprint || ''));
					break;
				case 'saveTeams':
					result = this.saveTeams(body.teams);
					break;
				case 'saveBoardCode':
					result = this.saveBoardCode(String(body.code || ''));
					break;
				case 'saveSettings':
					result = this.saveSettings(body);
					break;
				default:
					result = { error: 'Unknown action' };
			}
		}, () => null);
		return json(JSON.stringify({ result, alerts: this.google.alerts.slice() }));
	}

	/** Approves, rejects or reopens a request found by its id, so a moved row can't mislead. */
	setRequestStatus(id, status)
	{
		if (['Pending', 'Done', 'Rejected'].indexOf(status) < 0)
		{
			return { error: 'Unknown status' };
		}
		const rows = this.spreadsheet.getSheetByName('Requests');
		if (rows)
		{
			for (let i = 1; i < rows.data.length; i++)
			{
				const row = rows.data[i] || [];
				if (String(row[11] || '') === id || (!row[11] && id === '#' + (i + 1)))
				{
					this.store.setRequestStatus(i + 1, status);
					return { ok: true };
				}
			}
		}
		return { error: 'That request no longer exists. Reload the page.' };
	}

	/** A credit ledger row, checked the way the store reads it before it is written. */
	addAdjustment(body)
	{
		const team = String(body.team || '').trim().toLowerCase();
		const scope = this.store.latestBoardForTeam(team);
		const row = [team, String(parseInt(body.tile, 10) || ''), body.goal === '' || body.goal == null ? '' : String(parseInt(body.goal, 10)),
			this.store.cleanPlayerName(body.player), body.add === '' || body.add == null ? '' : Number(body.add),
			body.complete ? 'yes' : '', String(body.note || '').slice(0, 200), 'admin page', new Date().toISOString()];
		const issues = this.store.parseAdjustmentRow(row, scope ? scope.meta : null).issues.filter(Boolean);
		if (!scope || issues.length)
		{
			return { error: scope ? issues.join('. ') : 'That team has no board yet.' };
		}
		this.store.onOpen();
		this.spreadsheet.getSheetByName('Adjustments').appendRow(row);
		return { ok: true };
	}

	/** Removes a ledger row, but only if it is still the row the admin was looking at. */
	deleteAdjustment(rowNumber, fingerprint)
	{
		const sheet = this.spreadsheet.getSheetByName('Adjustments');
		if (!sheet || !(rowNumber >= 2) || JSON.stringify(sheet.data[rowNumber - 1]) !== fingerprint)
		{
			return { error: 'The ledger changed meanwhile. Reload the page and try again.' };
		}
		sheet.deleteRow(rowNumber);
		return { ok: true };
	}

	saveTeams(teams)
	{
		if (!Array.isArray(teams))
		{
			return { error: 'No teams sent' };
		}
		this.store.onOpen();
		const sheet = this.spreadsheet.getSheetByName('Teams');
		const header = sheet.data[0] || ['Code', 'Name', 'Webhook'];
		const seen = {};
		const rows = [];
		for (const team of teams)
		{
			const code = String(team.code || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-+|-+$)/g, '');
			if (!code)
			{
				continue;
			}
			if (seen[code])
			{
				return { error: 'Two teams use the code "' + code + '". Codes must be unique.' };
			}
			seen[code] = true;
			rows.push([code, String(team.name || '').trim().slice(0, 60), String(team.webhook || '').trim()]);
		}
		sheet.data = [header].concat(rows);
		this.store.clearConfigCache();
		return { ok: true, teams: rows.length };
	}

	saveBoardCode(code)
	{
		const summary = summarizeBoard(code);
		if (!summary.ok)
		{
			return { error: summary.message };
		}
		const sheet = this.store.ensureBoardCodeSheet();
		sheet.data = [sheet.data[0] || ['Paste the board code below'], [code]];
		this.store.clearConfigCache();
		this.google.alerts.push(this.store.reconcileBoardCode(code, this.store.sha256Hex(code)));
		return { ok: true };
	}

	saveSettings(body)
	{
		const seconds = Math.round(Number(body.pollSeconds));
		if (!(seconds >= 60 && seconds <= 900))
		{
			return { error: 'Pick a value from 60 to 900 seconds.' };
		}
		this.store.onOpen();
		const sheet = this.spreadsheet.getSheetByName('Settings');
		const row = sheet.data.findIndex((r, i) => i > 0 && String((r || [])[0] || '').toLowerCase().indexOf('poll') >= 0);
		if (row > 0)
		{
			sheet.data[row][1] = seconds;
		}
		else
		{
			sheet.appendRow(['Poll interval (seconds)', seconds, '']);
		}
		this.store.clearConfigCache();
		return { ok: true };
	}

	editTab(name, rows)
	{
		if (TAB_EDIT_ACTIONS.indexOf(name) < 0 || !Array.isArray(rows))
		{
			return { error: 'That tab is not editable here' };
		}
		const sheet = this.spreadsheet.getSheetByName(name) || this.spreadsheet.insertSheet(name);
		const before = sheet.data.map(row => JSON.stringify(row || []));
		sheet.data = rows.map(row => (Array.isArray(row) ? row.map(v => (v == null ? '' : v)) : []));
		let changed = 0;
		for (let i = 0; i < sheet.data.length; i++)
		{
			if (JSON.stringify(sheet.data[i]) !== before[i])
			{
				changed++;
				const width = Math.max(1, sheet.data[i].length);
				this.store.onEdit({ range: sheet.getRange(i + 1, 1, 1, width), value: undefined });
			}
		}
		if (sheet.data.length !== before.length && name !== 'Requests' && name !== 'Adjustments')
		{
			this.store.onEdit({ range: sheet.getRange(1, 1, 1, 1) });
		}
		return { changed };
	}
}

function json(text, status, extra)
{
	return new Response(text, { status: status || 200,
		headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {}) });
}

function html(text)
{
	return new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
