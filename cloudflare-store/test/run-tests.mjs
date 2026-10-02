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
		this.puts = 0;
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
			this.puts++;
		}
	}

	async delete(keys)
	{
		for (const key of keys)
		{
			this.map.delete(key);
		}
	}

	async list({ prefix })
	{
		const out = new Map();
		for (const [key, value] of this.map)
		{
			if (key.startsWith(prefix))
			{
				out.set(key, structuredClone(value));
			}
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

async function setupEvent(rt, code)
{
	await rt.admin(code, { action: 'tabs' });
	await rt.admin(code, { action: 'setTab', name: 'Teams', rows: [['Code', 'Name', 'Webhook'], ['Red', 'Red Team', ''], ['Blue', '', '']] });
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

await test('a plugin sync round-trips like the Apps Script store', async () =>
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
	ok(page.includes('Summer board'), 'board embedded in the portal');
	ok(page.includes('window.google='), 'form bridge injected');
	const rpc = await (await rt.request('/e/summer/rpc', { method: 'POST',
		body: JSON.stringify({ fn: 'submitFormRequest', args: [{ board: 'b_red', player: 'Mobile Mo', tile: 1, add: 2, note: 'phone' }] }) })).json();
	ok(!rpc.error && /sent/i.test(rpc.result), 'form answered: ' + JSON.stringify(rpc));
	const requests = (await rt.admin('summer', { action: 'getTab', name: 'Requests' })).body.result;
	is(requests[1][2], 'Mobile Mo', 'the request landed on the Requests tab');
	const bad = await (await rt.request('/e/summer/rpc', { method: 'POST', body: JSON.stringify({ fn: 'resetStoreData' }) })).json();
	ok(!!bad.error, 'no other function is reachable from the portal');
});

await test('admin edits run the store logic: approving a request credits and announces', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	const teams = (await rt.admin('summer', { action: 'getTab', name: 'Teams' })).body.result;
	teams[1][2] = 'https://discord.com/api/webhooks/1/x';
	await rt.admin('summer', { action: 'setTab', name: 'Teams', rows: teams });
	await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A,
		meta: { name: 'B', size: 1, tiles: [{ label: 'Ten kills', goals: [{ label: 'Kills', target: 10 }] }] },
		members: { [A]: member('Alice', { 0: tile(1000, [3]) }) },
		request: { member: A, player: 'Alice', tile: 1, goal: 1, add: 4, note: 'missed' } });
	const requests = (await rt.admin('summer', { action: 'getTab', name: 'Requests' })).body.result;
	requests[1][9] = 'Done';
	await rt.admin('summer', { action: 'setTab', name: 'Requests', rows: requests });
	const r = await rt.post('summer', { board: 'b_red', rejoin: A, memberKey: KEY_A, members: {} });
	is(r.members['admin:alice'].tiles['0'].goals[0].n, 4, 'the approval credits Alice');
	ok(rt.webhooks.some(w => w.url.includes('discord.com') && /Credit approved/.test(w.body)), 'and is announced on Discord');
});

await test('admin calls need the token', async () =>
{
	const rt = createRuntime();
	const wrong = await rt.admin('summer', { action: 'tabs' }, 'nope');
	is(wrong.status, 401, 'refused');
	const none = await rt.admin('summer', { action: 'tabs' }, '');
	is(none.status, 401, 'refused without a token');
});

await test('menu actions report what they did', async () =>
{
	const rt = createRuntime();
	await setupEvent(rt, 'summer');
	const code = '{"name":"Ev","id":"ev","size":1,"tiles":[{"label":"x","goals":[{"type":"KILL","npcs":["Man"],"count":2}]}]}';
	await rt.admin('summer', { action: 'setTab', name: 'Board code', rows: [['Paste the board code below'], [code]] });
	const applied = await rt.admin('summer', { action: 'applyBoardUpdate' });
	ok(applied.body.alerts.some(a => /Board recorded|unchanged/.test(a)), 'apply reports: ' + applied.body.alerts);
	const fetched = await rt.post('summer', { fetchBoard: true });
	is(fetched.boardJson, code, 'players can fetch the pasted board');
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
