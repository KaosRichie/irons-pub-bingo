// Irons Pub Bingo team store on Cloudflare: one Durable Object per event.
//
// Routes (event code = 3 to 40 of a-z, 0-9, -):
//   POST /e/<code>              the plugin's sync
//   GET  /e/<code>              the player portal
//   GET  /e/<code>/data         the portal's live data (JSON)
//   POST /e/<code>/rpc          the portal's request form
//   GET  /e/<code>/admin        the admin page
//   POST /e/<code>/admin/api    admin actions (Authorization: Bearer <ADMIN_TOKEN>)
//   GET  /admin                 the top-level admin page: every event
//   POST /admin/api             its list of events (Authorization: Bearer <ADMIN_TOKEN>)
//   GET  /assets/logo.png, /assets/icon.png
//
// A Durable Object handles one request at a time, so concurrent syncs simply queue for a
// few milliseconds. The event's rules live in store.js, which works on records in memory;
// this file loads those records once and saves the ones a request changed.
import { EventStore } from './store.js';
import { adminPage } from './admin-page.js';
import { topAdminPage } from './top-admin-page.js';
import { portalPage } from './portal-page.js';
import { eventData, summarizeBoard } from './data.js';
import { LOGO_PNG, ICON_PNG } from './generated/assets.js';

export { EventRegistry } from './registry.js';

const EVENT_CODE = /^[a-z0-9-]{3,40}$/;
// Pages allowed to call the admin API from a browser: Bingo Forge's "Send to store" on
// GitHub Pages, and a local copy of Forge. The password still guards every call.
const FORGE_ORIGINS = /^(https:\/\/kaosrichie\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?|null)$/;
const ASSETS = { '/assets/logo.png': LOGO_PNG, '/assets/icon.png': ICON_PNG };
// Days of request counts kept for the admin page's Usage view.
const USAGE_DAYS = 14;
// Storage keys the Durable Object keeps for itself, next to the store's records.
const OWN_KEYS = ['created', 'usage'];
// An event in use reports its numbers to the registry at most this often.
const REPORT_MS = 5 * 60 * 1000;

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
		if (url.pathname === '/admin' || url.pathname === '/admin/')
		{
			return html(topAdminPage());
		}
		if (url.pathname === '/admin/api' && request.method === 'POST')
		{
			await request.text();
			if (!authorized(request, env))
			{
				return json({ error: 'Wrong admin password' }, 401);
			}
			const list = await registry(env).fetch('https://registry/list');
			return json({ result: await list.json() });
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
		const origin = request.headers.get('origin') || '';
		const cors = match[2] === '/admin/api' && FORGE_ORIGINS.test(origin) ? {
			'access-control-allow-origin': origin,
			'access-control-allow-methods': 'POST',
			'access-control-allow-headers': 'authorization, content-type',
			'access-control-max-age': '86400',
			vary: 'origin'
		} : null;
		if (request.method === 'OPTIONS')
		{
			return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
		}
		const stub = env.BINGO_EVENT.get(env.BINGO_EVENT.idFromName(code));
		const response = await stub.fetch(request);
		if (!cors)
		{
			return response;
		}
		const headers = new Headers(response.headers);
		Object.keys(cors).forEach(k => headers.set(k, cors[k]));
		return new Response(response.body, { status: response.status, headers });
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
		const url = new URL(request.url);
		const parts = url.pathname.match(/^\/e\/([^/]+)(\/.*)?$/) || [];
		this.code = String(parts[1] || '').toLowerCase();
		const rest = parts[2] || '';
		// An event exists once an admin has saved something to it. Until then only its
		// admin page answers, so a made-up code shows nothing and stores nothing.
		if (!this.created && rest !== '/admin' && rest !== '/admin/api')
		{
			return notFound(request.method === 'GET' && (rest === '' || rest === '/'));
		}
		this.countRequest();
		try
		{
			if (rest === '' || rest === '/')
			{
				if (request.method === 'POST')
				{
					const text = await request.text();
					return await this.answer(() => this.store.sync(text));
				}
				return html(portalPage());
			}
			if (rest === '/data')
			{
				return await this.answer(() => eventData(this.store, false), { 'cache-control': 'no-store' });
			}
			if (rest === '/rpc' && request.method === 'POST')
			{
				const body = await request.json();
				if (!body || body.fn !== 'submitFormRequest')
				{
					return json({ error: 'Unknown call' }, 400);
				}
				return await this.answer(() =>
				{
					try
					{
						return { result: this.store.submitPortalRequest((body.args || [])[0]) };
					}
					catch (err)
					{
						return { error: err && err.message ? err.message : String(err) };
					}
				});
			}
			if (rest === '/admin')
			{
				return html(adminPage());
			}
			if (rest === '/admin/api' && request.method === 'POST')
			{
				// Read the body first: the runtime complains about an unread one.
				const text = await request.text();
				if (!authorized(request, this.env))
				{
					return json({ error: 'Wrong admin password' }, 401);
				}
				return await this.admin(JSON.parse(text || '{}'));
			}
			return new Response('Not found', { status: 404 });
		}
		catch (err)
		{
			console.error('Store request failed', err);
			return json({ error: 'Store error' }, 500);
		}
	}

	/** Loads every stored record of the event into memory. */
	async load()
	{
		const stored = await this.state.storage.list();
		this.created = !!stored.get('created');
		this.usage = stored.get('usage') || { days: {} };
		this.unsavedRequests = 0;
		this.store = new EventStore([...stored].filter(([key]) => OWN_KEYS.indexOf(key) < 0));
	}

	/** Runs a store call, saves what it changed, sends its Discord posts, answers in JSON. */
	async answer(call, headers)
	{
		let result;
		try
		{
			result = call();
		}
		catch (err)
		{
			// The call may have changed the store halfway. Throw all of it away: the next
			// request reloads the event from storage.
			this.ready = null;
			throw err;
		}
		await this.save();
		this.sendOutbox();
		this.report(false);
		return json(result, 200, headers);
	}

	/**
	 * Tells the registry this event's numbers for the top-level admin page: right away when
	 * forced (created, changed by an admin, deleted), otherwise at most every REPORT_MS.
	 */
	report(force, deleted)
	{
		const now = Date.now();
		if (!deleted && (!this.created || (!force && now - (this.lastReport || 0) < REPORT_MS)))
		{
			return;
		}
		this.lastReport = now;
		const store = this.store;
		const official = store.officialBoard();
		const firstMeta = [...store.metas.values()].find(entry => entry.meta && entry.meta.name);
		const players = new Set();
		for (const row of store.members.values())
		{
			if (!store.departures.has(row.board + '|' + row.member))
			{
				players.add(row.member);
			}
		}
		const summary = {
			name: (official && official.name) || (firstMeta && firstMeta.meta.name) || null,
			teams: store.config.teams.length,
			players: players.size,
			pending: [...store.requests.values()].filter(r => r.status === 'Pending').length,
			requestsToday: this.usage.days[new Date().toISOString().slice(0, 10)] || 0,
			lastActivity: new Date(now).toISOString()
		};
		const send = registry(this.env).fetch('https://registry/report', { method: 'POST',
			body: JSON.stringify(deleted ? { code: this.code, deleted: true } : { code: this.code, summary }) })
			.catch(err => console.error('Registry report failed', err));
		if (this.state.waitUntil)
		{
			this.state.waitUntil(send);
		}
	}

	/**
	 * Writes what the store changed. The request counter is saved along with other changes,
	 * or every 25 requests, so counting never costs a storage write per request.
	 */
	async save()
	{
		const puts = {};
		const deletes = [];
		for (const [key, value] of this.store.takeChanges())
		{
			if (value === undefined)
			{
				deletes.push(key);
			}
			else
			{
				puts[key] = value;
			}
		}
		if (this.created && this.unsavedRequests && (Object.keys(puts).length || deletes.length || this.unsavedRequests >= 25))
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
		for (const message of this.store.takeOutbox())
		{
			const send = fetch(message.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: message.body })
				.catch(err => console.error('Webhook post failed', err));
			if (this.state.waitUntil)
			{
				this.state.waitUntil(send);
			}
		}
	}

	/** Requests per UTC day, for the admin page's Usage view. */
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

	// ------------------------------------------------------------------ admin

	/** Admin actions. Answers { result, alerts }: alerts are messages for the admin. */
	async admin(body)
	{
		const action = body && body.action;
		if (action === 'overview' && !this.created)
		{
			// Looking at a new event's admin page must not store anything yet.
			const result = eventData(new EventStore([]), true);
			result.usage = { days: {} };
			result.isNew = true;
			return json({ result, alerts: [] });
		}
		if (action === 'deleteEvent')
		{
			await this.state.storage.deleteAll();
			this.created = false;
			this.usage = { days: {} };
			this.store = new EventStore([]);
			this.report(true, true);
			return json({ result: { ok: true }, alerts: [] });
		}
		const store = this.store;
		const alerts = [];
		const response = await this.answer(() =>
		{
			switch (action)
			{
				case 'overview':
				{
					const result = eventData(store, true);
					result.usage = this.usage;
					return result;
				}
				case 'setRequestStatus':
					return store.setRequestStatus(String(body.id || ''), String(body.status || ''));
				case 'addAdjustment':
				{
					const added = store.addCredit(body);
					(added.alerts || []).forEach(a => alerts.push(a));
					delete added.alerts;
					return added;
				}
				case 'deleteAdjustment':
					return store.removeCredit(String(body.id || ''));
				case 'saveTeams':
					return store.saveTeams(body.teams);
				case 'saveBoardCode':
				{
					const summary = summarizeBoard(String(body.code || ''));
					if (!summary.ok)
					{
						return { error: summary.message };
					}
					alerts.push(store.saveBoardCode(String(body.code)));
					return { ok: true };
				}
				case 'saveSettings':
					return store.savePollInterval(body.pollSeconds);
				case 'resetTile':
					alerts.push(store.resetTile(String(body.team || ''), parseInt(body.tile, 10)));
					return null;
				case 'resetStore':
					store.resetEvent();
					return null;
				default:
					return { error: 'Unknown action' };
			}
		});
		const result = await response.json();
		// Only an action that worked brings a new event into existence.
		const creating = !this.created && !(result && result.error);
		if (creating)
		{
			this.created = true;
			await this.state.storage.put({ created: true });
		}
		if (creating || ['saveTeams', 'saveBoardCode', 'resetStore', 'setRequestStatus', 'addAdjustment', 'deleteAdjustment'].indexOf(action) >= 0)
		{
			this.report(true);
		}
		return json({ result, alerts });
	}
}

/** The one registry of events (see registry.js). */
function registry(env)
{
	return env.EVENT_REGISTRY.get(env.EVENT_REGISTRY.idFromName('registry'));
}

/** Whether the request carries the admin password, compared in constant time. */
function authorized(request, env)
{
	const expected = String(env.ADMIN_TOKEN || '');
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

function json(value, status, extra)
{
	return new Response(JSON.stringify(value), { status: status || 200,
		headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {}) });
}

/** The answer for an event code nobody has set up: a short page for people, JSON for the rest. */
function notFound(asPage)
{
	if (!asPage)
	{
		return json({ error: 'No event with this code' }, 404);
	}
	return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
		+ '<title>No event here</title><body style="margin:0;background:#17130f;color:#e8dcc4;font:16px system-ui,sans-serif;'
		+ 'display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center">'
		+ '<div><img src="/assets/logo.png" alt="" width="120"><h1 style="color:#e2ad48;font-size:22px">No event here</h1>'
		+ '<p>Check the link with your event host.</p></div>',
		{ status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function html(text)
{
	return new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
