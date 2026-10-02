// Drives a running Worker (npx wrangler dev, or a deployed one) through a small event.
// Usage: node test/live-check.mjs http://127.0.0.1:8787 <admin token> [event code]
import { createHash, randomBytes } from 'node:crypto';

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = process.argv[3] || '';
const event = process.argv[4] || 'live-' + randomBytes(3).toString('hex');
const url = base + '/e/' + event;
const results = [];

function check(what, condition, detail)
{
	results.push((condition ? 'PASS ' : 'FAIL ') + what + (condition || detail === undefined ? '' : '  (' + detail + ')'));
}

async function admin(body)
{
	const r = await fetch(url + '/admin/api', { method: 'POST',
		headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
	return { status: r.status, body: await r.json() };
}

async function sync(body)
{
	const started = performance.now();
	const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
	return { ms: performance.now() - started, body: await r.json() };
}

const memberId = i => i.toString(16).padStart(16, '0');
const keyFor = i => createHash('sha256').update('key' + i).digest('hex');
const code = JSON.stringify({ name: 'Live check board', id: 'live', version: 1, size: 1,
	tiles: [{ label: 'Ten kills', mode: 'ANY', goals: [{ type: 'KILL', npcs: ['Man'], count: 10 }] }] });
const hash = createHash('sha256').update(code, 'utf8').digest('hex');

// -- admin setup, through the admin API the admin page uses
check('admin page served', (await (await fetch(url + '/admin')).text()).includes('Irons Pub Bingo admin'));
check('wrong token refused', (await fetch(url + '/admin/api', { method: 'POST', body: '{}' })).status === 401);
const tabs = await admin({ action: 'tabs' });
check('tabs listed', tabs.status === 200 && tabs.body.result.some(t => t.name === 'Teams'), JSON.stringify(tabs.body));
await admin({ action: 'setTab', name: 'Teams', rows: [['Code', 'Name', 'Webhook'], ['Red', 'Red Team', ''], ['Blue', 'Blue Team', '']] });
await admin({ action: 'setTab', name: 'Board code', rows: [['Paste the board code below'], [code]] });
const applied = await admin({ action: 'applyBoardUpdate' });
check('board update applied', (applied.body.alerts || []).length > 0, JSON.stringify(applied.body));

// -- the plugin's calls
const fetched = (await sync({ fetchBoard: true })).body;
check('players fetch the pasted board', fetched.boardJson === code, JSON.stringify(fetched).slice(0, 120));
const teams = (await sync({ teamsOnly: true, board: 'id_live' })).body;
check('choose team lists the teams', JSON.stringify(teams.teams.map(t => t.code)) === '["red","blue"]', JSON.stringify(teams));

const first = await sync({ board: 'id_live_red', rejoin: memberId(1), memberKey: keyFor(1), boardHash: hash, boardVersion: 1,
	members: { [memberId(1)]: { name: 'Alice', tiles: { 0: { goals: [{ n: 3 }], manual: false, ts: Date.now() } } } } });
check('first sync accepted', !first.body.error, first.body.error);
check('first sync answer time ' + first.ms.toFixed(0) + ' ms', first.ms < 2000);
const tampered = await sync({ board: 'id_live_red', rejoin: memberId(1), memberKey: keyFor(1), boardHash: 'deadbeef',
	boardVersion: 1, members: {} });
check('an edited board is rejected', /Wrong board/.test(tampered.body.error || ''), tampered.body.error);

// -- 60 players syncing at the same moment
const burst = await Promise.all(Array.from({ length: 60 }, (_, i) => sync({
	board: i % 2 ? 'id_live_blue' : 'id_live_red', rejoin: memberId(100 + i), memberKey: keyFor(100 + i),
	boardHash: hash, boardVersion: 1,
	members: { [memberId(100 + i)]: { name: 'Player' + i, tiles: { 0: { goals: [{ n: 1 }], manual: false, ts: Date.now() } } } } })));
const errors = burst.filter(r => r.body.error);
const times = burst.map(r => r.ms).sort((a, b) => a - b);
check('60 simultaneous syncs all accepted', errors.length === 0, errors.length + ' errors, e.g. ' + (errors[0] && errors[0].body.error));
check('burst times: median ' + times[30].toFixed(0) + ' ms, slowest ' + times[59].toFixed(0) + ' ms', times[59] < 10000);
const red = (await sync({ board: 'id_live_red', rejoin: memberId(1), memberKey: keyFor(1), boardHash: hash, boardVersion: 1,
	members: {} })).body;
check('team red sees its 31 members', Object.keys(red.members).length === 31, Object.keys(red.members).length);
check('team red total is 33 kills', Object.values(red.members).reduce((s, m) => s + ((m.tiles['0'] || { goals: [{ n: 0 }] }).goals[0] || { n: 0 }).n, 0) === 33);

// -- portal and its request form
const portal = await (await fetch(url)).text();
check('portal shows the board', portal.includes('Live check board'));
const form = await (await fetch(url + '/rpc', { method: 'POST', body: JSON.stringify({ fn: 'submitFormRequest',
	args: [{ board: 'id_live_red', player: 'Mobile Mo', tile: 1, add: 2, note: 'from my phone' }] }) })).json();
check('portal form files a request', !form.error, form.error);

// -- approving it from the admin page credits the team
const requests = (await admin({ action: 'getTab', name: 'Requests' })).body.result;
const row = requests.findIndex(r => r[2] === 'Mobile Mo');
requests[row][9] = 'Done';
await admin({ action: 'setTab', name: 'Requests', rows: requests });
const after = (await sync({ board: 'id_live_red', rejoin: memberId(1), memberKey: keyFor(1), boardHash: hash, boardVersion: 1,
	members: {} })).body;
check('approved credit reaches the plugin', after.members['admin:mobile mo'] && after.members['admin:mobile mo'].tiles['0'].goals[0].n === 2,
	JSON.stringify(after.members['admin:mobile mo']));
const views = (await admin({ action: 'tabs' })).body.result.map(t => t.name);
check('board views rendered per team', views.includes('Board red') && views.includes('Board blue'), views.join(', '));

console.log('Event: ' + event);
console.log(results.join('\n'));
process.exitCode = results.some(r => r.startsWith('FAIL')) ? 1 : 0;
