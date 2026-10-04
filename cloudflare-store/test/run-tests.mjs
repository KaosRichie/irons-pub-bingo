// Runs the Worker module under Node with an in-memory stand-in for Durable Object storage.
// No Cloudflare account, no network: node build.mjs && node test/run-tests.mjs
import worker, { BingoEvent } from '../src/worker.js';
import { sha256 } from '../src/sha256.js';
import { createHash } from 'node:crypto';

const A = 'aaaaaaaaaaaaaa01';
const B = 'bbbbbbbbbbbbbb02';
const KEY_A = 'a'.repeat(64);
const TOKEN = 'test-admin-token';

/** Durable Object storage: the async KV calls the Worker uses, over one Map. */
class FakeStorage
{
	constructor(map)
	{
		this.map = map;
	}

	async get(key)
	{
		return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
	}

	async put(entries)
	{
		for (const key of Object.keys(entries))
		{
			this.map.set(key, structuredClone(entries[key]));
		}
	}

	async delete(keys)
	{
		for (const key of keys)
		{
			this.map.delete(key);
		}
	}

	async list()
	{
		const out = new Map();
		for (const key of [...this.map.keys()].sort())
		{
			out.set(key, structuredClone(this.map.get(key)));
		}
		return out;
	}
}

/**
 * A fake Workers runtime. Each event code maps to one object instance, like a real
 * namespace; restart() throws the instances away so the next request reloads from storage.
 */
function createRuntime()
{
	const storage = new Map(); // event code -> Map
	let instances = new Map();
	const webhooks = [];
	const env = {
		ADMIN_TOKEN: TOKEN,
		BINGO_EVENT: {
			idFromName: name => name,
			get: id => ({
				fetch: request =>
				{
					if (!instances.has(id))
					{
						if (!storage.has(id))
						{
							storage.set(id, new Map());
						}
						const state = { storage: new FakeStorage(storage.get(id)), waitUntil() {} };
						instances.set(id, new BingoEvent(state, env));
					}
					return instances.get(id).fetch(request);
				}
			})
		}
	};
	globalThis.fetch = async (url, init) =>
	{
		webhooks.push({ url: String(url), body: init && init.body });
		return new Response(null, { status: 204 });
	};
	return {
		env,
		webhooks,
		storage,
		restart()
		{
			instances = new Map();
		},
		async request(path, init)
		{
			return worker.fetch(new Request('https://store.test' + path, init), env);
		},
		async post(code, body)
		{
			// Signed like the plugin: with the acting member's own key.
			const actor = body.rejoin || (body.remove && body.remove[0]);
			if (body.memberKey === undefined && actor)
			{
				body = Object.assign({ memberKey: createHash('sha256').update('key:' + actor).digest('hex') }, body);
			}
			const response = await this.request('/e/' + code, { method: 'POST', body: JSON.stringify(body) });
			return response.json();
		},
		async admin(code, body, token)
		{
			const response = await this.request('/e/' + code + '/admin/api', {
				method: 'POST',
				headers: { authorization: 'Bearer ' + (token === undefined ? TOKEN : token) },
				body: JSON.stringify(body)
			});
			return { status: response.status, body: await response.json() };
		}
	};
}

async function setupEvent(rt, code, webhook)
{
	await rt.admin(code, { action: 'saveTeams', teams: [{ code: 'Red', name: 'Red Team', webhook: webhook || '' }, { code: 'Blue', name: '' }] });
}

function member(name, tiles)
{
	return { name, tiles };
}

function tile(ts, counts)
{
	return { goals: counts.map(n => ({ n })), manual: false, ts };
}

// ---------------------------------------------------------------- tiny test kit

const failures = [];
let current = '';

function is(actual, expected, what)
{
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e)
	{
		failures.push(current + ': ' + what + ' - expected ' + e + ', got ' + a);
	}
}

function ok(condition, what)
{
	if (!condition)
	{
		failures.push(current + ': ' + what);
	}
}

async function test(name, body)
{
	current = name;
	try
	{
		await body();
	}
	catch (err)
	{
		failures.push(name + ': threw ' + (err && err.stack || err));
	}
}

// ---------------------------------------------------------------- scenarios

await test('the synchronous SHA-256 matches Node', () =>
{
	for (const text of ['', 'abc', 'x'.repeat(1000), 'ünïcode ✓ board'])
	{
		is(Buffer.from(sha256(text)).toString('hex'), createHash('sha256').update(text, 'utf8').digest('hex'), text.slice(0, 10));
	}
});

await test('a plugin sync round-trips', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	let r = await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A,
		members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	ok(!r.error, 'accepted: ' + r.error);
	is(r.members[A].tiles['0'].goals[0].n, 3, 'own progress echoed back');
	is(r.teams.map(t => t.code), ['red', 'blue'], 'host teams listed');
	r = await rt.post('summer', { board: 'b_nope', rejoin: A, members: {} });
	ok(!!r.error, 'unlisted team rejected');
});

await test('progress survives the object being evicted and reloaded', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A, members: { [A]: member('Alice', { 0: tile(1000, [7]) }) } });
	rt.restart();
	const r = await rt.post('summer', { board: 'b_red', rejoin: B, members: { [B]: member('Bob', {}) } });
	is(r.members[A].tiles['0'].goals[0].n, 7, 'Alice reloaded from storage');
	rt.restart();
	const again = await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: 'f'.repeat(64),
		members: { [A]: member('Alice', { 0: tile(9000, []) }) } });
	is(again.error, 'Key mismatch - ask your host', 'member keys survive a reload too');
});

await test('an idle sync writes almost nothing', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	const body = { board: 'b_red', rejoin: A, memberKey: KEY_A, members: { [A]: member('Alice', { 0: tile(1000, [7]) }) } };
	await rt.post('summer', body);
	await rt.post('summer', body);
	const before = [...rt.storage.get('summer').keys()].length;
	const storage = rt.storage.get('summer');
	const snapshot = JSON.stringify([...storage.entries()]);
	await rt.post('summer', body);
	ok(JSON.stringify([...storage.entries()]) === snapshot, 'an unchanged sync changes no stored rows');
	ok(before > 0, 'there was something stored');
});

await test('events are isolated from each other', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A, members: { [A]: member('Alice', { 0: tile(1000, [7]) }) } });
	const other = await rt.post('winter', { board: 'b_red', rejoin: A, members: {} });
	ok(!!other.error, 'a different event has no teams, so it accepts nothing');
});

await test('the portal renders and its request form files a request', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A,
		meta: { name: 'Summer board', size: 1, tiles: [{ label: 'Ten kills', goals: [{ label: 'Kills', target: 10 }] }] },
		members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	const page = await (await rt.request('/e/summer')).text();
	ok(page.includes('Irons Pub Bingo') && page.includes('/data'), 'the portal page loads its data live');
	const data = await (await rt.request('/e/summer/data')).json();
	is(data.event.name, 'Summer board', 'the portal data names the board');
	const red = data.teams.find(t => t.code === 'red');
	is(red.board.tiles[0].goals[0].total, 3, 'and carries the tile progress');
	is(red.board.tiles[0].goals[0].contributors, [{ name: 'Alice', amount: 3 }], 'with contributors');
	const form = player => rt.request('/e/summer/rpc', { method: 'POST',
		body: JSON.stringify({ fn: 'submitFormRequest', args: [{ board: 'b_red', player, tile: 1, add: 2, note: 'phone' }] }) })
		.then(r => r.json());
	const stranger = await form('Mobile Mo');
	ok(/Pick your name/.test(stranger.error), 'a name nobody synced is refused: ' + JSON.stringify(stranger));
	const rpc = await form('alice');
	ok(!rpc.error && /sent/i.test(rpc.result), 'a team member is accepted, in any case: ' + JSON.stringify(rpc));
	const view = (await rt.admin('summer', { action: 'overview' })).body.result;
	is(view.requests[0].player, 'alice', 'the request is filed');
	const bad = await (await rt.request('/e/summer/rpc', { method: 'POST', body: JSON.stringify({ fn: 'resetStoreData' }) })).json();
	ok(!!bad.error, 'no other function is reachable from the portal');
});

await test('approving a request credits and announces', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer', 'https://discord.com/api/webhooks/1/x');
	await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A,
		meta: { name: 'B', size: 1, tiles: [{ label: 'Ten kills', goals: [{ label: 'Kills', target: 10 }] }] },
		members: { [A]: member('Alice', { 0: tile(1000, [3]) }) },
		request: { member: A, player: 'Alice', tile: 1, goal: 1, add: 4, note: 'missed' } });
	const request = (await rt.admin('summer', { action: 'overview' })).body.result.requests[0];
	await rt.admin('summer', { action: 'setRequestStatus', id: request.id, status: 'Done' });
	const r = await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A, members: {} });
	is(r.members['admin:alice'].tiles['0'].goals[0].n, 4, 'the approval credits Alice');
	ok(rt.webhooks.some(w => w.url.includes('discord.com') && /Credit approved/.test(w.body)), 'and is announced on Discord');
});

await test('admin calls need the token', async () =>
{
	const rt = createRuntime();
	const wrong = await rt.admin('summer', { action: 'overview' }, 'nope');
	is(wrong.status, 401, 'refused');
	const none = await rt.admin('summer', { action: 'overview' }, '');
	is(none.status, 401, 'refused without a token');
});

await test('saving a board code reports what it did', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	const code = '{"name":"Ev","id":"ev","size":1,"tiles":[{"label":"x","goals":[{"type":"KILL","npcs":["Man"],"count":2}]}]}';
	const saved = await rt.admin('summer', { action: 'saveBoardCode', code });
	ok(saved.body.alerts.some(a => /Board recorded/.test(a)), 'save reports: ' + saved.body.alerts);
	const fetched = await rt.post('summer', { fetchBoard: true });
	is(fetched.boardJson, code, 'players can fetch the pasted board');
});

await test('the admin page actions work from names, not row numbers', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	const meta = { name: 'B', size: 1, tiles: [{ label: 'Ten kills', goals: [{ label: 'Kills', target: 10 }] }] };
	await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A, meta,
		members: { [A]: member('Alice', { 0: tile(1000, [3]) }) },
		request: { member: A, player: 'Alice', tile: 1, goal: 1, add: 4, note: 'missed', links: 'https://imgur.com/x' } });
	let view = (await rt.admin('summer', { action: 'overview' })).body.result;
	const request = view.requests[0];
	is(request.tileLabel, 'Ten kills', 'requests carry the tile name');
	is(request.links, ['https://imgur.com/x'], 'and their proof links');
	is((await rt.admin('summer', { action: 'setRequestStatus', id: request.id, status: 'Done' })).body.result, { ok: true }, 'approved by id');
	view = (await rt.admin('summer', { action: 'overview' })).body.result;
	is(view.requests[0].status, 'Done', 'shown as approved');
	is(view.teams.find(t => t.code === 'red').board.tiles[0].goals[0].total, 7, 'and the credit counts');

	let r = (await rt.admin('summer', { action: 'addAdjustment', team: 'red', tile: 1, goal: 1, player: 'Bob', add: 3, note: 'screenshot' })).body.result;
	is(r, { ok: true }, 'credit added from the form');
	r = (await rt.admin('summer', { action: 'addAdjustment', team: 'red', tile: 9, goal: 1, player: 'Bob', add: 3 })).body.result;
	ok(r.error && /does not exist/.test(r.error), 'a tile outside the board is refused: ' + JSON.stringify(r));
	view = (await rt.admin('summer', { action: 'overview' })).body.result;
	const bob = view.adjustments.find(a => a.player === 'Bob');
	is(bob.tileLabel, 'Ten kills', 'the ledger shows tile names');
	r = (await rt.admin('summer', { action: 'deleteAdjustment', id: 'nothing' })).body.result;
	ok(r.error, 'credit that is gone is reported');
	r = (await rt.admin('summer', { action: 'deleteAdjustment', id: bob.id })).body.result;
	is(r, { ok: true }, 'the credit the admin saw is removed');

	r = (await rt.admin('summer', { action: 'saveTeams', teams: [{ code: 'Red', name: 'Red' }, { code: 'red', name: 'Again' }] })).body.result;
	ok(r.error, 'duplicate team codes are refused');
	r = (await rt.admin('summer', { action: 'saveTeams', teams: [{ code: 'Red Team!', name: 'Red' }, { code: 'blue', name: 'Blue' }] })).body.result;
	is(r, { ok: true, teams: 2 }, 'teams saved');
	view = (await rt.admin('summer', { action: 'overview' })).body.result;
	is(view.teamRows.map(t => t.code), ['red-team', 'blue'], 'codes are normalized like the plugin does');

	r = (await rt.admin('summer', { action: 'saveBoardCode', code: '{not json' })).body.result;
	ok(r.error, 'a broken board code is refused');
	r = (await rt.admin('summer', { action: 'saveSettings', pollSeconds: 20 })).body.result;
	ok(r.error, 'a poll interval below 60 is refused');
	r = (await rt.admin('summer', { action: 'saveSettings', pollSeconds: 300 })).body.result;
	is(r, { ok: true }, 'a valid poll interval is saved');
	const sync = await rt.post('summer', { board: 'b_red-team', rejoin: B, members: {} });
	is(sync.pollSeconds, 300, 'and players get it on their next sync');
	view = (await rt.admin('summer', { action: 'overview' })).body.result;
	ok(Object.values(view.usage.days)[0] > 10, 'requests are counted for the usage view');
});

await test('credit from the admin page is announced on Discord, and so is taking it back', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	await rt.admin('summer', { action: 'saveTeams', teams: [{ code: 'red', name: 'Red Team', webhook: 'https://discord.com/api/webhooks/1/x' }] });
	const meta = { name: 'Board', size: 1, tiles: [{ label: 'Ten kills', goals: [{ label: 'Kills', target: 10 }] }] };
	await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A, meta, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	rt.webhooks.length = 0;
	await rt.admin('summer', { action: 'addAdjustment', team: 'red', tile: 1, goal: 1, player: 'Bob', add: 2, note: 'screenshot in chat' });
	ok(rt.webhooks.length === 1 && /Credit approved/.test(rt.webhooks[0].body) && /Bob/.test(rt.webhooks[0].body)
		&& /screenshot in chat/.test(rt.webhooks[0].body), 'plain credit announced: ' + JSON.stringify(rt.webhooks));
	await rt.admin('summer', { action: 'addAdjustment', team: 'red', tile: 1, goal: 1, player: 'Bob', add: 5 });
	ok(/completed \*\*Ten kills\*\*/.test(rt.webhooks[1].body), 'credit that finishes the tile is the completion post: ' + rt.webhooks[1].body);
	const view = (await rt.admin('summer', { action: 'overview' })).body.result;
	const row = view.adjustments.find(a => a.add === 5);
	await rt.admin('summer', { action: 'deleteAdjustment', id: row.id });
	ok(/withdrawn/.test(rt.webhooks[2].body), 'removing credit is announced: ' + rt.webhooks[2].body);
});

await test('a made-up event code shows nothing until an admin saves to it', async () =>
{
	const rt = createRuntime();
	is((await rt.request('/e/made-up')).status, 404, 'portal of an unknown event');
	is((await rt.request('/e/made-up/data')).status, 404, 'data of an unknown event');
	is((await rt.request('/e/made-up', { method: 'POST', body: '{}' })).status, 404, 'sync to an unknown event');
	is((await rt.request('/e/made-up/admin')).status, 200, 'its admin page still answers');
	is((await rt.admin('made-up', { action: 'overview' }, 'wrong')).status, 401, 'wrong password refused');
	const preview = await rt.admin('made-up', { action: 'overview' });
	ok(preview.status === 200 && preview.body.result.isNew, 'admin can look at the new event');
	is(rt.storage.has('made-up') ? rt.storage.get('made-up').size : 0, 0, 'looking stored nothing');
	await rt.admin('made-up', { action: 'saveTeams', teams: [{ code: 'red', name: 'Red Team', webhook: '' }] });
	rt.restart();
	is((await rt.request('/e/made-up')).status, 200, 'saving brought the event into existence, and it lasts');
});

await test('Bingo Forge may call the admin API from its own pages only', async () =>
{
	const rt = createRuntime();
	const forge = 'https://kaosrichie.github.io';
	const pre = await rt.request('/e/summer/admin/api', { method: 'OPTIONS', headers: { origin: forge } });
	is(pre.status, 204, 'preflight from Forge accepted');
	is(pre.headers.get('access-control-allow-origin'), forge, 'and names Forge');
	is((await rt.request('/e/summer/admin/api', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403,
		'preflight from elsewhere refused');
	const post = await rt.request('/e/summer/admin/api', { method: 'POST',
		headers: { origin: forge, authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ action: 'overview' }) });
	is(post.headers.get('access-control-allow-origin'), forge, 'admin answers carry the header for Forge');
	const portal = await rt.request('/e/summer/data', { headers: { origin: forge } });
	is(portal.headers.get('access-control-allow-origin'), null, 'other routes stay same-origin');
});

// ---------------------------------------------------------------- report

if (failures.length)
{
	console.error('\nWORKER TESTS FAILED (' + failures.length + '):');
	for (const failure of failures)
	{
		console.error('  x ' + failure);
	}
	process.exitCode = 1;
}
else
{
	console.log('Worker tests: all scenarios passed.');
}
