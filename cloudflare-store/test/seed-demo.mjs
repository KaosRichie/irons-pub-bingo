// Fills an event with realistic demo data, for looking at the portal and admin page.
// Usage: node test/seed-demo.mjs http://127.0.0.1:8787 <admin token> [event code]
import { createHash } from 'node:crypto';

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = process.argv[3] || '';
const event = process.argv[4] || 'demo';
const url = base + '/e/' + event;

const tiles = [
	['Uncut onyx from Zulrah', 'Uncut onyx', [{ type: 'DROP', items: ['Uncut onyx'], sources: ['Zulrah'], count: 1 }]],
	['Any pet', 'Pet snakeling', [{ type: 'PET', count: 1 }]],
	['500 Brutus kills', 'Cowhide', [{ type: 'KC', npcs: ['Brutus'], count: 500 }]],
	['Barrows chest pieces (3 distinct)', "Dharok's helm", [{ type: 'DROP', items: ['Dharok*', 'Ahrim*', 'Karil*'], count: 3, distinct: true }]],
	['1M Thieving XP', 'Coin pouch', [{ type: 'XP', skill: 'THIEVING', amount: 1000000 }]],
	['Tormented demon unique', 'Tormented synapse', [{ type: 'DROP', items: ['Tormented synapse', 'Burning claw'], count: 1 }]],
	['50 Seers laps', 'Mark of grace', [{ type: 'LAP', course: 'SEERS', count: 50 }]],
	['CoX purple or ToA purple, whichever comes first', 'Twisted bow', [{ type: 'RAID_PURPLE', raids: ['COX'], count: 1 }, { type: 'RAID_PURPLE', raids: ['TOA'], count: 1 }], 'ANY'],
	['Zenyte shard', 'Zenyte shard', [{ type: 'DROP', items: ['Zenyte shard'], count: 1 }]],
	['Sub-7 Corrupted Gauntlet', 'Crystal shard', [{ type: 'CHAT', pattern: 'Corrupted challenge duration: [0-6]:[0-5][0-9]', count: 1 }]],
	['Dragon warhammer', 'Dragon warhammer', [{ type: 'DROP', items: ['Dragon warhammer'], count: 1 }]],
	['Fire cape', 'Fire cape', [{ type: 'MANUAL' }]],
	['Free space', 'Coins', [{ type: 'MANUAL' }]],
	['10 clue caskets (elite)', 'Reward casket (elite)', [{ type: 'DROP', items: ['Reward casket (elite)'], count: 10 }]],
	['Big drop worth 5M+', 'Coins', [{ type: 'VALUE', amount: 5000000, count: 1 }]],
	['Vorkath head', "Vorkath's head", [{ type: 'DROP', items: ["Vorkath's head"], count: 1 }]],
	['Sailing XP 500k', 'Rope', [{ type: 'XP', skill: 'SAILING', amount: 500000 }]],
	['Hydra leather', 'Hydra leather', [{ type: 'DROP', items: ['Hydra leather'], count: 1 }]],
	['Nightmare unique', 'Inquisitor\'s mace', [{ type: 'DROP', items: ['Inquisitor*', 'Nightmare staff'], count: 1 }]],
	['Kill 1000 men', 'Bones', [{ type: 'KILL', npcs: ['Man'], count: 1000 }]],
	['Abyssal whip', 'Abyssal whip', [{ type: 'DROP', items: ['Abyssal whip'], count: 1 }]],
	['Champion scrolls (2 distinct)', 'Goblin champion scroll', [{ type: 'DROP', items: ['*champion scroll'], count: 2, distinct: true }]],
	['GWD hilt', 'Armadyl hilt', [{ type: 'DROP', items: ['* hilt'], count: 1 }]],
	['Wintertodt 20 crates', 'Supply crate', [{ type: 'CHAT', pattern: 'Your subdued Wintertodt count is', count: 20 }]],
	['Jar of anything', 'Jar of souls', [{ type: 'DROP', items: ['Jar of *'], count: 1 }]]
];
const board = { name: 'Irons Pub Autumn Bingo', id: 'autumn-2026', version: 2, size: 5, diagonals: true, linePoints: 10, blackoutPoints: 50,
	tiles: tiles.map(([label, icon, goals, mode], i) => ({ label, icon, points: 5 + (i % 3) * 5, mode: mode || 'ALL',
		description: i === 7 ? 'Either raid counts. Purples from your own team only, shared kills count once.' : undefined, goals })) };
const code = JSON.stringify(board);
const hash = createHash('sha256').update(code, 'utf8').digest('hex');

async function admin(body)
{
	const r = await fetch(url + '/admin/api', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
	return r.json();
}

const id = i => (0x1000 + i).toString(16).padStart(16, '0');
const key = i => createHash('sha256').update('demo' + i).digest('hex');
async function sync(team, i, name, tileValues, extra)
{
	const tilesOut = {};
	for (const [t, values] of Object.entries(tileValues))
	{
		tilesOut[t] = { goals: values.map(v => (Array.isArray(v) ? { n: 0, matched: v } : { n: v })), manual: false, ts: Date.now() };
	}
	const r = await fetch(url, { method: 'POST', body: JSON.stringify(Object.assign({ board: 'id_autumn-2026_' + team, rejoin: id(i),
		memberKey: key(i), boardHash: hash, boardVersion: 2, members: { [id(i)]: { name, tiles: tilesOut } } }, extra || {})) });
	return r.json();
}

await admin({ action: 'overview' });
await admin({ action: 'saveTeams', teams: [{ code: 'red', name: 'The Red Dragons' }, { code: 'blue', name: 'Blue Moon Brigade' }, { code: 'green', name: 'Green Goblins' }] });
await admin({ action: 'saveBoardCode', code });

// Red: two lines (top row and left column), lots of partial progress.
await sync('red', 1, 'KaosRichie', { 0: [1], 1: [1], 2: [512], 3: [['Dharok\'s helm', 'Ahrim\'s robetop', 'Karil\'s coif']], 4: [1000000], 5: [1], 10: [1], 15: [1], 20: [1], 6: [31], 13: [4] }, { teamPoints: 85 });
await sync('red', 2, 'Enza Denino', { 2: [140], 19: [612], 16: [260000], 7: [0, 0] });
await sync('red', 3, 'Iron Man Steve', { 13: [3], 21: [['Goblin champion scroll']], 23: [12] });
// Blue and Green: a little progress each.
await sync('blue', 11, 'Blue Wizard', { 0: [1], 6: [50], 19: [300] }, { teamPoints: 25 });
await sync('blue', 12, 'Moonlight', { 2: [90], 14: [1] });
await sync('green', 21, 'Gobbo', { 19: [1000], 18: [1] }, { teamPoints: 20 });

// Requests: one short, one with a long note and several links, one approved, one rejected.
await sync('red', 2, 'Enza Denino', {}, { request: { member: id(2), player: 'Enza Denino', tile: 12, add: '', complete: true,
	note: 'Got my fire cape on mobile last night, so the plugin missed it.', links: 'https://imgur.com/a/firecape123' } });
await sync('red', 3, 'Iron Man Steve', {}, { request: { member: id(3), player: 'Iron Man Steve', tile: 14, goal: 1, add: 2,
	note: 'Opened two elite caskets while my RuneLite was crashed after the update on Wednesday. Both are in my collection log (screenshot 1) and you can see the casket count go from 4 to 6 in the second screenshot. The third link is the Discord message where I posted them live. Sorry for the long note!',
	links: 'https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/caskets-before-and-after-really-long-file-name.png https://imgur.com/gallery/elite-caskets-proof https://discord.com/channels/111/222/333' } });
await sync('blue', 12, 'Moonlight', {}, { request: { member: id(12), player: 'Moonlight', tile: 7, goal: 1, add: 10, note: 'Laps on mobile.', links: 'https://imgur.com/laps' } });
await sync('green', 21, 'Gobbo', {}, { request: { member: id(21), player: 'Gobbo', tile: 25, add: 1, note: 'jar', links: '' } });

let view = (await admin({ action: 'overview' })).result;
const approve = view.requests.find(r => r.player === 'Moonlight');
await admin({ action: 'setRequestStatus', id: approve.id, status: 'Done' });
const reject = view.requests.find(r => r.player === 'Gobbo');
await admin({ action: 'setRequestStatus', id: reject.id, status: 'Rejected' });
await admin({ action: 'addAdjustment', team: 'red', tile: 13, goal: '', player: 'KaosRichie', add: '', complete: true, note: 'Free space' });
view = (await admin({ action: 'overview' })).result;
console.log('Seeded ' + event + ': ' + view.teams.map(t => t.name + ' ' + (t.board ? t.board.done : 0) + ' tiles').join(', ')
	+ '; ' + view.requests.length + ' requests; ' + view.adjustments.length + ' ledger rows');
