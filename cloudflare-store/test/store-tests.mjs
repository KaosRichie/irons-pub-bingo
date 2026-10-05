// Tests for the event store itself (src/store.js), driven with the payloads the plugin
// sends. Each test gets a fresh event. No network: node test/store-tests.mjs
import { createHash } from 'node:crypto';
import { EventStore, metaFromBoard, MAX_PENDING } from '../src/store.js';
import { eventData } from '../src/data.js';

const A = 'aaaaaaaaaaaaaa01';
const B = 'bbbbbbbbbbbbbb02';
const X = 'cccccccccccccc03';
const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
const META = {
	name: 'Test board', size: 1,
	tiles: [{ label: '10 kills', goals: [{ label: 'Kills: Man', target: 10 }] }]
};

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** A member's key, the way the plugin derives one per account. */
const keyFor = memberId => sha('key:' + memberId);

/** A fresh event with teams red and blue (or the given teams). */
function newStore(teams)
{
	const store = new EventStore([]);
	store.saveTeams(teams || [{ code: 'Red', name: 'Red Team' }, { code: 'Blue', name: '' }]);
	return {
		store,
		/** A sync like the plugin's: one pushed member is the sender, signed with their key. */
		post(body)
		{
			if (body.members && body.rejoin === undefined && Object.keys(body.members).length === 1)
			{
				body = Object.assign({ rejoin: Object.keys(body.members)[0] }, body);
			}
			const actor = body.rejoin || (body.remove && body.remove[0]) || (body.request && body.request.member);
			if (body.memberKey === undefined && actor)
			{
				body = Object.assign({ memberKey: keyFor(actor) }, body);
			}
			return JSON.parse(JSON.stringify(store.sync(JSON.stringify(body))));
		},
		credit(fields)
		{
			store.writeCredit(Object.assign({ board: 'b_' + (fields.team || 'red'), team: fields.team || 'red', goal: null, add: 0,
				complete: false, note: '', request: null, by: 'test' }, fields));
		},
		requests()
		{
			return [...store.requests.values()];
		},
		posts()
		{
			return store.takeOutbox().map(p => Object.assign({ url: p.url }, JSON.parse(p.body)));
		}
	};
}

function member(name, tiles)
{
	return { name, tiles };
}

function tile(ts, goalCounts)
{
	return { goals: goalCounts.map(n => ({ n })), manual: false, ts };
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

// ---------------------------------------------------------------- syncing

test('per-tile merge is last-write-wins by owner timestamp', () =>
{
	const s = newStore();
	let r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 5, 'initial push stored');
	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(500, [99]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 5, 'an older copy must not overwrite fresher data');
	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(2000, [7]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 7, 'a newer push wins');
});

test('a timestamped reset beats a stale copy', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [13]) }) } });
	let r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(3000, [0]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 0, 'reset stored');
	r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [13]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 0, 'the old numbers cannot come back');
});

test('a clock set far in the future cannot make progress unbeatable', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(9e15, [5]) }) } });
	const r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(Date.now() + 1000, [0]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 0, 'an honest reset beats the clamped future stamp');
});

test('a client writes only its own progress, and a member key locks it to its owner', () =>
{
	const s = newStore();
	const K1 = 'a'.repeat(64);
	const K2 = 'b'.repeat(64);
	s.post({ board: 'b_red', meta: META, memberKey: K1, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	const row = s.store.members.get('b_red|' + A);
	ok(/^[0-9a-f]{32}$/.test(row.key) && row.key.indexOf('aaaa') < 0, 'the store keeps a hash of the key, never the key');

	let r = s.post({ board: 'b_red', rejoin: B, members: {
		[B]: member('Bob', { 0: tile(2000, [1]) }), [A]: member('Alice', { 0: tile(9000, []) }),
		'admin:kaos': member('Kaos (verified)', { 0: tile(1000, [99]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 3, 'a relayed copy cannot overwrite Alice');
	is(r.members[B].tiles['0'].goals[0].n, 1, 'Bob still writes his own');
	ok(!('admin:kaos' in r.members), 'nor can a client send admin credit');

	r = s.post({ board: 'b_red', memberKey: K2, members: { [A]: member('Alice', { 0: tile(9000, []) }) } });
	is(r.error, 'Key mismatch - ask your host', 'the wrong key is told why it cannot write');
	s.post({ board: 'b_red', memberKey: K2, members: {}, remove: [A] });
	r = s.post({ board: 'b_red', rejoin: B, members: {} });
	ok(A in r.members, 'nor can the wrong key make Alice leave');
	r = s.post({ board: 'b_red', memberKey: K1, members: { [A]: member('Alice', { 0: tile(3000, [4]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 4, 'the owner writes as before');
});

test('a client without a member key is refused', () =>
{
	const s = newStore();
	const r = s.post({ board: 'b_red', meta: META, memberKey: null, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	is(r.error, 'Update the plugin to sync', 'told to update');
	is(s.store.members.size, 0, 'nothing stored');
});

test('an oversized or broken sync is refused', () =>
{
	const s = newStore();
	is(s.store.sync('{"junk":"' + 'x'.repeat(250000) + '"}').error, 'Request too large', 'too large');
	ok(!!s.store.sync('{nope').error, 'not JSON');
});

test('an unchanged sync changes nothing', () =>
{
	const s = newStore();
	const body = { board: 'b_red', meta: META, teamPoints: 5, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } };
	s.post(body);
	s.store.takeChanges();
	const r = s.post(body);
	is(s.store.takeChanges().size, 0, 'no record written');
	is(r.members[A].tiles['0'].goals[0].n, 3, 'and the reply still carries the state');
});

// ---------------------------------------------------------------- teams and departures

test('only listed teams can sync', () =>
{
	const blank = new EventStore([]);
	let r = blank.sync(JSON.stringify({ board: 'b_red', rejoin: A, memberKey: keyFor(A), meta: META,
		members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } }));
	ok(!!r.error, 'nothing is accepted before the host lists a team');
	is(blank.members.size + blank.metas.size, 0, 'and nothing is stored');

	const s = newStore([{ code: 'Red', name: 'Red Team' }]);
	r = s.post({ board: 'b_blue', rejoin: A, members: {} });
	ok(!!r.error, 'unknown code rejected');
	is(r.teams, [{ code: 'red', name: 'Red Team' }], 'the rejection carries the team list');
	r = s.post({ board: 'b_solo', rejoin: A, members: {} });
	ok(!!r.error, 'no team code rejected');
	r = s.post({ board: 'b_red', rejoin: A, members: {} });
	ok(!r.error, 'listed code accepted');
	ok(!('webhook' in r.teams[0]), 'clients never see webhooks');
});

test('teamsOnly returns the teams with each team\'s member names', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.post({ board: 'b_red', members: { [B]: member('Bob', { 0: tile(1000, [1]) }) } });
	let r = s.post({ teamsOnly: true, board: 'b' });
	is(r.teams, [{ code: 'red', name: 'Red Team', members: ['Alice', 'Bob'] }, { code: 'blue', name: '', members: [] }], 'teams with members');
	s.post({ board: 'b_red', members: {}, remove: [B] });
	is(s.post({ teamsOnly: true, board: 'b' }).teams[0].members, ['Alice'], 'a member who left drops out');
	is(s.post({ teamsOnly: true }).teams[0].members, ['Alice'], 'without a board key every board counts');
});

test('leaving parks the progress and stops it counting', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.post({ board: 'b_red', remove: [A], members: {} });
	let r = s.post({ board: 'b_red', rejoin: B, members: {} });
	ok(!(A in r.members), 'a member who left stops counting');
	is(r.removed, [A], 'the reply lists the departure');
	ok(s.store.members.has('b_red|' + A), 'their progress is kept for a return');
	r = s.post({ board: 'b_red', rejoin: B, members: { [B]: member('Bob', {}), [A]: member('Alice', { 0: tile(2000, [9]) }) } });
	ok(!(A in r.members), 'a teammate relaying them changes nothing');
});

test('coming back to a team restores what you earned there', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.post({ board: 'b_red', remove: [A], members: {} });
	let r = s.post({ board: 'b_blue', members: { [A]: member('Alice', { 0: tile(3000, [2]) }) } });
	is(r.members[A].tiles['0'].goals[0].n, 2, 'blue starts her from scratch');
	r = s.post({ board: 'b_red', rejoin: A, members: {} });
	is(r.members[A].tiles['0'].goals[0].n, 5, 'red progress came back with her');
	is(r.removed, [], 'the departure is cleared');
	r = s.post({ board: 'b_blue', rejoin: B, members: {} });
	ok(!(A in r.members), 'and blue no longer counts her');
});

test('one team per board per member', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	let r = s.post({ board: 'b_blue', rejoin: B, members: { [B]: member('Bob', {}), [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(!(A in r.members), 'a relay never creates a member on another team');
	r = s.post({ board: 'b_blue', members: { [A]: member('Alice', { 0: tile(3000, [0]) }) } });
	ok(A in r.members, 'her own sync joins the new team');
	r = s.post({ board: 'b_red', rejoin: B, members: {} });
	ok(!(A in r.members), 'and leaves the old one');
	is(r.removed, [A], 'marked left there');
});

test('leaving a team the host has since removed still works', () =>
{
	const s = newStore([{ code: 'Old', name: 'Old team' }]);
	s.post({ board: 'b_old', members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	s.store.saveTeams([{ code: 'Red', name: 'Red Team' }]);
	const r = s.post({ board: 'b_old', remove: [A], members: {} });
	ok(!r.error, 'the departure notice succeeds');
	is(r.left, [A], 'and is recorded');
});

test('team scores build cross-team standings on the shared board', () =>
{
	const s = newStore([{ code: 'Red' }, { code: 'Blue' }, { code: 'Green' }]);
	s.post({ board: 'b_red', rejoin: A, members: {}, teamPoints: 30 });
	let r = s.post({ board: 'b_blue', rejoin: A, members: {}, teamPoints: 45 });
	is(r.standings, [{ team: 'blue', points: 45 }, { team: 'red', points: 30 }], 'sorted best first');
	r = s.post({ board: 'b_red', rejoin: A, members: {}, teamPoints: 60 });
	is(r.standings[0], { team: 'red', points: 60 }, 'updates move the ranking');
	s.post({ board: 'other_green', rejoin: A, members: {}, teamPoints: 99 });
	is(s.post({ board: 'b_red', rejoin: A, members: {} }).standings.length, 2, 'standings stay on the same board');
});

test('the poll interval reaches clients', () =>
{
	const s = newStore();
	is(s.post({ board: 'b_red', rejoin: A, members: {} }).pollSeconds, 0, 'unset means the plugin default');
	ok(!!s.store.savePollInterval(20).error, 'below 60 refused');
	s.store.savePollInterval(300);
	is(s.post({ board: 'b_red', rejoin: A, members: {} }).pollSeconds, 300, 'served with every sync');
});

// ---------------------------------------------------------------- admin credit

test('admin credit becomes verified progress, and negative credit corrects a player down to zero at most', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [6]) }) } });
	s.credit({ tile: 1, player: 'Kaos', add: 4 });
	let r = s.post({ board: 'b_red', rejoin: A, members: {} });
	is(r.members['admin:kaos'].name, 'Kaos (verified)', 'shown as verified');
	is(r.members['admin:kaos'].tiles['0'].goals[0].n, 4, 'credited amount');
	is(s.store.tileTotals('b_red', META).done[0], true, '6 tracked plus 4 credited completes the tile');
	// A miscounted tracked drop is corrected with negative credit under any name.
	s.credit({ tile: 1, player: 'Alice', add: -3 });
	r = s.post({ board: 'b_red', rejoin: A, members: {} });
	is(r.members['admin:alice'].tiles['0'].goals[0].n, -3, 'the correction goes out as it is');
	const totals = s.store.tileTotals('b_red', META);
	is([totals.tracked[0][0] + totals.verified[0][0], totals.done[0]], [7, false], 'and takes the team below the target again');
	// A correction never takes a player below zero: Alice tracked 6.
	s.credit({ tile: 1, player: 'Alice', add: -20 });
	is(s.post({ board: 'b_red', rejoin: A, members: {} }).members['admin:alice'].tiles['0'].goals[0].n, -6, 'down to zero for Alice, never a penalty');
	s.credit({ team: 'blue', tile: 1, player: 'Bob', add: 5 });
	ok(!('admin:bob' in s.post({ board: 'b_red', rejoin: A, members: {} }).members), 'another team\'s credit stays out');
});

test('credit from the admin page is checked and announced, and so is taking it back', () =>
{
	const s = newStore([{ code: 'red', name: 'Red Team', webhook: WEBHOOK }]);
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	ok(/does not exist/.test(s.store.addCredit({ team: 'red', tile: 9, player: 'Alice', add: 2 }).error), 'a missing tile is refused');
	ok(!!s.store.addCredit({ team: 'nope', tile: 1, player: 'Alice', add: 2 }).error, 'a team without a board is refused');
	ok(/synced/.test(s.store.addCredit({ team: 'red', tile: 1, goal: 1, player: 'Nobody', add: 2 }).error), 'a player who never synced is refused');
	is(s.store.addCredit({ team: 'red', tile: 1, goal: 1, player: 'Alice', add: 2, note: 'screenshot' }), { ok: true }, 'credit added');
	let posts = s.posts();
	ok(posts.length === 1 && /Credit approved/.test(posts[0].content) && /screenshot/.test(posts[0].content), 'announced');
	s.store.addCredit({ team: 'red', tile: 1, goal: 1, player: 'Alice', add: 5 });
	ok(/completed \*\*10 kills\*\*/.test(s.posts()[0].content), 'credit that finishes the tile is the completion post');
	const last = [...s.store.credits.values()].pop();
	is(s.store.removeCredit(last.id), { ok: true }, 'removed');
	ok(/withdrawn/.test(s.posts()[0].content), 'and the removal is announced');
	ok(!!s.store.removeCredit(last.id).error, 'removing it twice reports it gone');
});

test('a correction takes off what the player has when it is given, never later progress', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', {}) } });
	ok(/no progress/.test(s.store.addCredit({ team: 'red', tile: 1, goal: 1, player: 'Alice', add: -6 }).error),
		'nothing to take off yet is refused');
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(2000, [4]) }) } });
	const r = s.store.addCredit({ team: 'red', tile: 1, goal: 1, player: 'Alice', add: -6 });
	ok(r.ok && /Took off 4/.test(r.alerts[0]), 'cut down to the 4 she has: ' + JSON.stringify(r));
	s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(3000, [9]) }) } });
	const totals = s.store.tileTotals('b_red', META);
	is(totals.tracked[0][0] + totals.verified[0][0], 5, 'her later progress counts in full: 9 tracked minus the 4 taken off');
});

test('credit belongs to the board it was given on', () =>
{
	const s = newStore();
	s.post({ board: 'id_old_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [6]) }) } });
	s.store.addCredit({ team: 'red', tile: 1, goal: 1, player: 'Alice', add: -3 });
	s.store.addCredit({ team: 'red', tile: 1, goal: 1, player: 'Alice', add: 2 });
	is(s.store.creditMembers('id_old_red', META)['admin:alice'].tiles['0'].goals[0].n, -1, 'it counts on its board');
	s.post({ board: 'id_new_red', meta: META, members: { [A]: member('Alice', { 0: tile(2000, [5]) }) } });
	ok(!('admin:alice' in s.store.creditMembers('id_new_red', META)), 'a new board starts without it');
	is(s.store.tileTotals('id_new_red', META).tracked[0][0], 5, 'so new progress counts in full');
});

// ---------------------------------------------------------------- credit requests

test('credit requests are validated and de-duplicated', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', {}) } });
	const send = request => s.post({ board: 'b_red', rejoin: A, members: {},
		request: Object.assign({ member: A, player: 'Alice', tile: 1, note: 'n' }, request) });
	send({ goal: 'abc', add: 2 });
	send({ goal: 5, add: 2 });
	send({ tile: 9, add: 2 });
	send({ add: -3 });
	send({ add: 'Infinity' });
	send({});
	is(s.requests().length, 0, 'none of the bad requests were filed');
	send({ goal: 1, add: 2 });
	send({ goal: 1, add: 2 });
	is(s.requests().length, 1, 'a valid request is filed once');
	is([s.requests()[0].team, s.requests()[0].status], ['red', 'Pending'], 'team from the scope, starts Pending');
	s.post({ board: 'b_red', rejoin: B, members: {}, request: { member: A, player: 'Mallory', tile: 1, add: 9 } });
	is(s.requests().length, 1, 'nobody files a request in someone else\'s name');
});

test('approving credits once, rejecting takes it back, approving again re-credits', () =>
{
	const s = newStore([{ code: 'red', name: 'Red Team', webhook: WEBHOOK }]);
	s.post({ board: 'b_red', meta: META, members: {}, rejoin: A, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 4, note: 'proof' } });
	const id = s.requests()[0].id;
	is(s.store.setRequestStatus(id, 'Done'), { ok: true }, 'approved');
	s.store.setRequestStatus(id, 'Pending');
	s.store.setRequestStatus(id, 'Done');
	ok(!!s.store.setRequestStatus(id, 'nonsense').error, 'unknown status refused');
	ok(!!s.store.setRequestStatus('nope', 'Done').error, 'unknown request reported');
	is([...s.store.credits.values()].filter(c => c.request === id).length, 1, 'one credit despite the flip-flop');
	is(s.post({ board: 'b_red', rejoin: A, members: {} }).members['admin:alice'].tiles['0'].goals[0].n, 4, 'credited once');
	const posts = s.posts();
	ok(/Credit approved/.test(posts[0].content) && /\+4 on goal 1 \(Kills: Man\)/.test(posts[0].content), 'the approval spells out the credit');
	ok(/withdrawn/.test(posts[1].content) && /proof/.test(posts[1].content), 'the flip back is announced with the note');
	s.store.setRequestStatus(id, 'Rejected');
	ok(!('admin:alice' in s.post({ board: 'b_red', rejoin: A, members: {} }).members), 'rejected credit is gone');
});

test('an approval that finishes the board announces lines and the blackout', () =>
{
	const meta = { name: 'Line board', size: 2, linePoints: 10, diagonals: false, tiles: [
		{ label: 'a', goals: [{ label: 'ga', target: 1 }] }, { label: 'b', goals: [{ label: 'gb', target: 1 }] },
		{ label: 'c', goals: [{ label: 'gc', target: 1 }] }, { label: 'd', goals: [{ label: 'gd', target: 1 }] }] };
	const s = newStore([{ code: 'red', name: 'Red Team', webhook: WEBHOOK }]);
	s.post({ board: 'b_red', meta, rejoin: A, members: {} });
	for (let t = 1; t <= 4; t++)
	{
		s.post({ board: 'b_red', rejoin: A, members: {}, request: { member: A, player: 'Alice', tile: t, goal: 1, add: 1, note: '' } });
	}
	s.requests().forEach(r => s.store.setRequestStatus(r.id, 'Done'));
	const posts = s.posts().map(p => p.content);
	ok(/completed \*\*a\*\*/.test(posts[0]) && posts[0].indexOf('Bingo!') < 0, 'the first tile finishes no line');
	ok(/completed \*\*b\*\*/.test(posts[1]) && posts[1].indexOf('Bingo! Line complete (+10 pts)') >= 0, 'the row is announced with its points');
	ok(posts[3].indexOf('BLACKOUT! Every tile complete') >= 0 && posts[3].indexOf('lines complete') >= 0, 'the last tile is a blackout, with its lines');
	is(posts[3].split('\n')[1], 'Line board: 4/4 tiles', 'board progress on its own line');
	is(JSON.parse(JSON.stringify(s.store.outbox)), [], 'every post was taken');
});

test('player text never pings anyone', () =>
{
	const s = newStore([{ code: 'red', name: 'Red Team', webhook: WEBHOOK }]);
	s.post({ board: 'b_red', meta: META, rejoin: A, members: {}, request:
		{ member: A, player: 'Alice', tile: 1, goal: 1, add: 40, note: '@everyone look' } });
	s.store.setRequestStatus(s.requests()[0].id, 'Done');
	const posts = s.store.takeOutbox();
	is(JSON.parse(posts[0].body).allowed_mentions, { parse: [] }, 'mentions are off');
	is(posts[0].url, WEBHOOK, 'sent to the team webhook');
});

test('portal requests name a player who synced to the team, with cleaned proof links', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('MobileMike', {}) } });
	let refused = '';
	try
	{
		s.store.submitPortalRequest({ board: 'b_red', player: 'Stranger', tile: 1, add: '5' });
	}
	catch (err)
	{
		refused = err.message;
	}
	ok(/Pick your name/.test(refused), 'a name nobody synced is refused');
	s.store.submitPortalRequest({ board: 'b_red', player: 'mobilemike', tile: 1, goal: '', add: '40', note: 'laps',
		links: 'https://imgur.com/a/abc, javascript:alert(1) notaurl https://cdn.discordapp.com/x.png' });
	const request = s.requests()[0];
	is(request.member, 'portal', 'marked as from the portal');
	is(request.links, ['https://imgur.com/a/abc', 'https://cdn.discordapp.com/x.png'], 'only http(s) links survive');
	s.store.setRequestStatus(request.id, 'Done');
	is(s.post({ board: 'b_red', rejoin: A, members: {} }).members['admin:mobilemike'].tiles['0'].goals[0].n, 40, 'approved like any other');
});

// ---------------------------------------------------------------- the official board

test('with a board code saved, only that board syncs', () =>
{
	const s = newStore();
	const official = '{"name":"Official","id":"ev","version":2,"tiles":[{"label":"Any weed"}]}';
	s.store.saveBoardCode(official);
	let r = s.post({ board: 'id_ev_red', rejoin: A, boardHash: sha(official), boardVersion: 2, members: {} });
	ok(!r.error, 'the official board syncs');
	r = s.post({ board: 'id_ev_red', boardHash: 'deadbeef', boardVersion: 2, meta: META, members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(/Wrong board/.test(r.error) && !('newerVersion' in r), 'an edited board is refused, with no update hint');
	is(s.store.members.size, 0, 'nothing from it was stored');
	r = s.post({ board: 'id_ev_red', rejoin: A, boardHash: 'deadbeef', boardVersion: 1, members: {} });
	is([r.error, r.newerVersion], ['Board updated', 2], 'an older version is told about the update');
	r = s.post({ board: 'id_ev_red', rejoin: A, members: {} });
	ok(!!r.error, 'a client without a board fingerprint is refused');

	const revised = official.replace('Any weed', 'Any herb');
	s.store.saveBoardCode(revised);
	r = s.post({ board: 'id_ev_red', rejoin: A, boardHash: sha(official), boardVersion: 2, members: {} });
	is(r.error, 'Board updated', 'a client on the earlier code is outdated, not accused');
	r = s.post({ board: 'id_ev_red', rejoin: A, boardHash: sha(official), members: {} });
	is(r.error, 'Board updated', 'also when it sends no version');
	s.store.saveBoardCode(official);
	is(s.post({ board: 'id_ev_red', rejoin: A, boardHash: sha(revised), members: {} }).error, 'Board updated',
		'going back to an earlier code makes the newer one outdated');
	ok(!new EventStore([]).sync(JSON.stringify({ teamsOnly: true })).error, 'no board code means no check');
});

test('players can fetch the board code', () =>
{
	const s = newStore();
	ok(!!s.post({ fetchBoard: true }).error, 'none saved yet');
	const code = '{"name":"Test board","size":1,"tiles":[{"label":"x"}]}';
	s.store.saveBoardCode(code);
	is(s.post({ fetchBoard: true }).boardJson, code, 'the saved code');
	is(s.store.saveBoardCode('nope'), 'That board code does not parse - re-export it from Bingo Forge.', 'junk is refused');
});

test('saving an updated board code resets tiles whose tracking changed', () =>
{
	const v1 = '{"id":"ev","name":"E","size":2,"tiles":['
		+ '{"label":"a","goals":[{"type":"DROP","items":["Bones"],"count":10}]},'
		+ '{"label":"b","goals":[{"type":"DROP","items":["Egg"],"count":10}]},'
		+ '{"label":"c","goals":[{"type":"KC","npcs":["Zulrah"],"count":5}]},{"label":"d"}]}';
	const v2 = v1.replace('{"label":"a","goals":[{"type":"DROP","items":["Bones"],"count":10}]}', '{"label":"a"}')
		.replace('"Egg"],"count":10', '"Egg"],"count":25');
	const s = newStore();
	ok(/Board recorded/.test(s.store.saveBoardCode(v1)), 'the first save records the board');
	s.post({ board: 'id_ev_red', boardHash: sha(v1), members: { [A]: member('Alice', { 0: tile(1000, [5]), 1: tile(1000, [7]) }) } });
	const report = s.store.saveBoardCode(v2);
	ok(/Reset 1 re-tracked tile/.test(report) && report.indexOf('1 - a') >= 0, 'the report names the reset tile: ' + report);
	ok(/unchanged/.test(s.store.saveBoardCode(v2)), 'saving it again changes nothing');
	let r = s.post({ board: 'id_ev_red', rejoin: A, boardHash: sha(v2), members: {} });
	ok(!r.members[A].tiles['0'].goals.length, 'the re-tracked tile was reset');
	is(r.members[A].tiles['1'].goals[0].n, 7, 'a target-only change kept its progress');
	r = s.post({ board: 'id_ev_red', boardHash: sha(v2), members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	ok(!r.members[A].tiles['0'].goals.length, 'the wipe beats cached copies');
});

test('a board update never touches a board whose id only starts the same', () =>
{
	const s = newStore();
	const spring = '{"id":"spring","tiles":[{"label":"a","goals":[{"type":"KC","npcs":["Zulrah"]}]}]}';
	s.store.saveBoardCode(spring);
	s.store.config.boardCode = '';
	s.post({ board: 'id_spring_red', members: { [A]: member('Alice', { 0: tile(1000, [3]) }) } });
	s.post({ board: 'id_spring_2_red', members: { [B]: member('Bob', { 0: tile(1000, [5]) }) } });
	s.store.saveBoardCode(spring.replace('Zulrah', 'Vorkath'));
	s.store.config.boardCode = '';
	is(s.post({ board: 'id_spring_2_red', rejoin: B, members: {} }).members[B].tiles['0'].goals[0].n, 5, 'spring_2 keeps its progress');
	ok(!s.post({ board: 'id_spring_red', rejoin: A, members: {} }).members[A].tiles['0'].goals.length, 'spring is wiped');
});

test('with a board code saved, the board summary comes from the code, not the client', () =>
{
	const s = newStore();
	const code = JSON.stringify({ name: 'Official', id: 'ev', size: 1,
		tiles: [{ label: 'Real tile', goals: [{ type: 'KILL', npcs: ['Man'], count: 10 }] }] });
	s.store.saveBoardCode(code);
	s.post({ board: 'id_ev_red', rejoin: A, boardHash: sha(code), members: {},
		meta: { name: 'Fake', size: 1, tiles: [{ label: 'Easy', goals: [{ label: 'x', target: 1 }] }] } });
	const meta = s.store.metaFor('id_ev_red');
	is([meta.name, meta.tiles[0].goals[0].target], ['Official', 10], 'name and targets from the code');
});

test('saving a board code fills the portal for every team before anyone syncs', () =>
{
	const s = newStore();
	const code = JSON.stringify({ name: 'Paste first', id: 'Ev-2026', version: 3, size: 1,
		tiles: [{ label: 'Onyx', mode: 'ANY', goals: [
			{ type: 'DROP', items: ['Uncut onyx'], sources: ['Zulrah'], count: 2 },
			{ type: 'XP', skill: 'HITPOINTS', amount: 50000 }] }] });
	s.store.saveBoardCode(code);
	is([...s.store.metas.keys()].sort(), ['id_ev-2026_blue', 'id_ev-2026_red'], 'one summary per team');
	const meta = s.store.metaFor('id_ev-2026_red');
	is(meta.tiles[0].goals.map(g => [g.label, g.target]), [['Drops: Uncut onyx from Zulrah', 2], ['50,000 Hitpoints XP', 50000]],
		'goal labels and targets like the plugin');
	s.store.saveTeams([{ code: 'red' }, { code: 'green' }]);
	ok(!!s.store.metaFor('id_ev-2026_green'), 'a team added later gets the board too');
});

test('goal labels match the plugin wording', () =>
{
	const label = goal => metaFromBoard({ tiles: [{ goals: [goal] }] }).tiles[0].goals[0].label;
	is(label({ type: 'DROP', items: ['Ancient page*'], sources: ['Zulrah', 'Vorkath', 'Hydra'], distinct: true, loot: ['KILL'] }),
		'Distinct kill drops from 3 sources', 'a long description falls back to the short form');
	is(label({ type: 'DROP', items: ['Ancient page*'], sources: ['Zulrah'], distinct: true }), 'Distinct drops: Ancient page from Zulrah', 'distinct drops');
	is(label({ type: 'DROP', itemIds: [6571] }), 'Drops: item 6571', 'id-only goal');
	is(label({ type: 'RAID_PURPLE', raids: ['TOB'] }), 'Raid purples (TOB)', 'raid purples');
	is(label({ type: 'RAID_PURPLE' }), 'Raid purples (COX, TOB, TOA)', 'all raids');
	is(label({ type: 'KC', npcs: ['Zulrah'] }), 'Kills: Zulrah', 'kill count');
	is(label({ type: 'PET' }), 'Any pet', 'any pet');
	is(label({ type: 'LAP', course: 'Seers' }), "Seers' Village course laps", 'course display names');
	is(label({ type: 'VALUE', amount: 1000000, sources: ['Zulrah'] }), 'Drop worth 1,000,000+ gp from Zulrah', 'loot value');
	is(label({ type: 'CHAT', pattern: 'Corrupted challenge duration: [0-6]:[0-5][0-9]' }), 'Corrupted challenge duration', 'chat pattern');
	is(label({ type: 'MANUAL' }), 'Manual (request admin credit)', 'manual');
	is(label({ type: 'XP', skill: 'HITPOINTS', amount: 5000, name: 'HP grind' }), 'HP grind', 'a set name wins');
});

// ---------------------------------------------------------------- totals and resets

test('the store completes tiles by the plugin rules', () =>
{
	const s = newStore();
	const meta = { name: 'Rules', size: 2, tiles: [
		{ label: 'Manual', mode: 'ALL', goals: [{ label: 'Manual', target: 1, manual: true }] },
		{ label: 'Mixed', mode: 'ALL', goals: [{ label: 'Kills', target: 2 }, { label: 'Manual', target: 1, manual: true }] },
		{ label: 'Either', mode: 'ANY', goals: [{ label: 'Manual', target: 1, manual: true }, { label: 'Kills', target: 2 }] },
		{ label: 'Distinct', mode: 'ALL', goals: [{ label: 'Pages', target: 3, distinct: true }] }] };
	s.post({ board: 'b_red', meta, members: { [A]: member('Alice', {
		1: tile(1000, [2]), 3: { goals: [{ n: 0, matched: ['Page 1', 'Page 2'] }], manual: false, ts: 1000 } }) } });
	s.credit({ team: 'red', tile: 1, goal: 1, player: 'Kaos', add: 1 });
	s.credit({ team: 'red', tile: 4, goal: 1, player: 'Kaos', add: 1 });
	const done = s.store.tileTotals('b_red', meta).done;
	is(done, [false, false, false, true], 'manual goals need the tick, distinct names plus credit count');
});

test('manual ticks name who ticked, and goal indices stay aligned', () =>
{
	const s = newStore();
	const meta = { name: 'M', size: 1, tiles: [{ label: 'Outfit OR XP', mode: 'ANY', goals: [
		{ label: 'Manual: outfit', target: 1, manual: true }, { label: 'Herblore XP', target: 100 }] }] };
	s.post({ board: 'b_red', meta, members: { [A]: { name: 'Alice', tiles: { 0: { goals: [{}, { n: 60 }], manual: false, ts: 1000 } } } } });
	let totals = s.store.tileTotals('b_red', meta);
	is(totals.tracked[0], [0, 60], 'progress lands on the right goal');
	s.post({ board: 'b_red', members: { [B]: { name: 'Bob', tiles: { 0: { goals: [{}, {}], manual: true, ts: 2000 } } } } });
	totals = s.store.tileTotals('b_red', meta);
	is([totals.done[0], Object.keys(totals.manualBy[0])], [true, ['Bob']], 'the tick completes it and names Bob');
});

test('a tile reset wipes it for the whole team, and beats any client clock', () =>
{
	const s = newStore();
	const meta = { name: 'Four', size: 2, tiles: [0, 1, 2, 3].map(t => ({ label: 'Tile ' + t, goals: [{ label: 'g', target: 10 }] })) };
	s.post({ board: 'b_red', meta, members: { [A]: member('Alice', { 0: tile(1000, [3]), 1: tile(1000, [7]) }) } });
	s.post({ board: 'b_red', members: { [B]: member('Bob', { 0: tile(1000, [2]) }) } });
	ok(/2 member\(s\)/.test(s.store.resetTile('red', 1)), 'both members wiped');
	ok(/does not exist/.test(s.store.resetTile('red', 99)), 'a missing tile is refused');
	ok(/No board found/.test(s.store.resetTile('nope', 1)), 'an unknown team is refused');
	const fast = Date.now() + 4 * 60 * 1000;
	const r = s.post({ board: 'b_red', members: { [A]: member('Alice', { 0: tile(fast, [3]) }) } });
	ok(!r.members[A].tiles['0'].goals.length && r.members[A].tiles['0'].ts > fast, 'the wipe stands against a fast clock');
	is(r.members[A].tiles['1'].goals[0].n, 7, 'other tiles untouched');
});

test('resetting the event clears everything but the poll interval, and bumps the generation', () =>
{
	const s = newStore();
	s.store.savePollInterval(300);
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(1000, [5]) }) },
		request: { member: A, player: 'Alice', tile: 1, add: 5, note: 'x' } });
	s.store.saveBoardCode('{"tiles":[]}');
	is(s.post({ board: 'b_red', rejoin: A, members: {}, boardHash: sha('{"tiles":[]}') }).epoch, 1, 'a fresh event is generation 1');
	s.store.resetEvent();
	let r = s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', { 0: tile(9000, [5]) }) } });
	ok(!!r.error && !r.teams.length, 'a stale client cannot refill the event before teams are added');
	s.store.saveTeams([{ code: 'red' }]);
	r = s.post({ board: 'b_red', rejoin: B, members: {} });
	is([Object.keys(r.members).length, r.pollSeconds, r.epoch], [0, 300, 2], 'progress gone, interval kept, generation bumped');
	is([s.store.requests.size, s.store.credits.size], [0, 0], 'requests and credit gone');
	ok(!!s.post({ fetchBoard: true }).error, 'board code gone');
});

test('records round-trip through storage', () =>
{
	const s = newStore([{ code: 'red', name: 'Red Team', webhook: WEBHOOK }]);
	s.post({ board: 'b_red', meta: META, teamPoints: 3, members: { [A]: member('Alice', { 0: tile(1000, [3]) }) },
		request: { member: A, player: 'Alice', tile: 1, add: 2, note: 'n' } });
	s.post({ board: 'b_red', remove: [A], members: {} });
	s.credit({ team: 'red', tile: 1, player: 'Kaos', add: 1 });
	const stored = new Map();
	for (const [key, value] of s.store.takeChanges())
	{
		stored.set(key, JSON.parse(JSON.stringify(value)));
	}
	const reloaded = new EventStore([...stored].sort());
	is(reloaded.config.teams, s.store.config.teams, 'teams');
	is([...reloaded.members.keys()], [...s.store.members.keys()], 'members');
	is([reloaded.requests.size, reloaded.credits.size, reloaded.departures.size, reloaded.scores.size, reloaded.metas.size],
		[1, 1, 1, 1, 1], 'every kind of record');
});

// ---------------------------------------------------------------- limits on what clients store

test('a malformed board summary is refused, and a stored one is repaired on load', () =>
{
	const s = newStore();
	for (const meta of [{ tiles: [null] }, { size: 2, tiles: META.tiles }, { size: 1, tiles: [{ label: 'x', goals: [null] }] },
		{ size: 1, tiles: [{ label: 'x' }] }, { size: 11, tiles: new Array(121).fill(META.tiles[0]) }])
	{
		const r = s.post({ board: 'b_red', meta, members: { [A]: member('Alice', { 0: tile(1000, [1]) }) } });
		is(r.error, 'Board summary not valid', 'refused: ' + JSON.stringify(meta).slice(0, 60));
	}
	is([s.store.metas.size, s.store.members.size], [0, 0], 'nothing from them was stored');
	s.post({ board: 'b_red', meta: Object.assign({ junk: 'x'.repeat(1000) }, META), members: {}, rejoin: A });
	ok(!('junk' in s.store.metaFor('b_red')), 'a good summary keeps only the fields the store reads');

	const stored = new EventStore([
		['config', { teams: [{ code: 'red', name: 'Red' }, { code: 'blue', name: 'Blue' }] }],
		['meta:b_blue', { updated: '2026-01-01', meta: { tiles: 'no' } }],
		['meta:b_red', { updated: '2026-01-01', meta: { size: 'x', tiles: [null, { label: 'Kept', goals: [null, { label: 'g', target: 2 }] }] } }]
	]);
	const data = eventData(stored, true);
	const red = data.teams.find(t => t.code === 'red').board;
	is(red.tiles.map(t => [t.label, t.goals.length]), [['Tile 1', 0], ['Kept', 1]], 'bad tiles are repaired, good ones kept');
	is(data.teams.find(t => t.code === 'blue').board, null, 'a summary with no tiles is left out');
});

test('with a board code saved, only that board\'s key syncs', () =>
{
	const s = newStore();
	const code = JSON.stringify({ name: 'Official', id: 'ev', size: 1, tiles: [{ label: 'Real', goals: [{ type: 'KILL', npcs: ['Man'], count: 10 }] }] });
	s.store.saveBoardCode(code);
	const r = s.post({ board: 'forged_red', boardHash: sha(code), meta: META, teamPoints: 999,
		members: { [A]: member('Alice', { 0: tile(1000, [5]) }) } });
	is(r.error, 'Wrong board - use Import from store', 'a forged board key is refused');
	ok(!s.store.metas.has('forged_red') && !s.store.scores.has('forged_red') && !s.store.members.size, 'and stores nothing');
	ok(!s.post({ board: 'id_ev_red', rejoin: A, boardHash: sha(code), members: {} }).error, 'the official key syncs');
	// A stray scope from before the code was saved must not steer the pages or credit.
	s.store.saveMeta('stray_red', { name: 'Stray', size: 1, tiles: META.tiles });
	s.store.metas.get('stray_red').updated = '2999-01-01';
	is(s.store.latestBoardForTeam('red').board, 'id_ev_red', 'the official scope wins');
});

test('each team\'s member list comes from its own board', () =>
{
	const s = newStore();
	s.post({ board: 'one_red', meta: META, members: { [A]: member('Alice', {}) } });
	s.post({ board: 'two_blue', meta: META, members: { [B]: member('Bob', {}) } });
	const data = eventData(s.store, true);
	is(data.teams.map(t => [t.code, t.members]), [['red', ['Alice']], ['blue', ['Bob']]], 'members per team scope');
	ok(!('verifiedComplete' in data.teams[0].board.tiles[0]) && !('summary' in data.boardCode), 'unused fields are gone');
});

test('board keys, departures and progress are capped', () =>
{
	const s = newStore();
	is(s.post({ board: 'b'.repeat(200) + '_red', rejoin: A, members: {} }).error, 'Bad board key', 'a long board key is refused');
	is(s.post({ board: 'nounderscore', rejoin: A, members: {} }).error, 'Bad board key', 'a board key with no team is refused');

	const ids = Array.from({ length: 30 }, (_, i) => 'dddddddddddd' + String(1000 + i));
	s.post({ board: 'b_red', memberKey: keyFor(ids[0]), remove: ids, members: {} });
	ok(s.store.departures.size <= 20, 'at most 20 departures per sync, got ' + s.store.departures.size);
	const before = s.store.departures.size;
	s.post({ board: 'b_gone', memberKey: keyFor(ids[0]), remove: ids, members: {} });
	is(s.store.departures.size, before, 'no departures on an unknown team without progress there');

	const got = {};
	for (let i = 0; i < 100; i++)
	{
		got['item ' + i] = 1;
	}
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', {
		0: { goals: [{ n: 3, got, matched: new Array(500).fill('x') }, { n: 9 }], manual: false, ts: 1000, junk: 'y' },
		1: tile(1000, [1]), 999: tile(1000, [1]), '00': tile(1000, [1]), x: tile(1000, [1]) }) } });
	const row = s.store.members.get('b_red|' + A);
	is(Object.keys(row.tiles), ['0'], 'only tiles the board has are kept');
	const kept = row.tiles['0'];
	is([kept.goals.length, Object.keys(kept.goals[0].got).length, kept.goals[0].matched.length, 'junk' in kept],
		[1, 40, 300, false], 'goals, item names and distinct names are capped');
});

test('a player can have only a few requests waiting', () =>
{
	const s = newStore();
	s.post({ board: 'b_red', meta: META, members: { [A]: member('Alice', {}) } });
	for (let i = 0; i < MAX_PENDING + 5; i++)
	{
		s.post({ board: 'b_red', rejoin: A, members: {}, request: { member: A, player: 'Alice', tile: 1, add: 1, note: 'try ' + i } });
	}
	is(s.requests().length, MAX_PENDING, 'a changed note cannot file request after request');
	let refused = '';
	try
	{
		s.store.submitPortalRequest({ board: 'b_red', player: 'alice', tile: 1, add: '1', note: 'portal' });
	}
	catch (err)
	{
		refused = err.message;
	}
	ok(/requests waiting/.test(refused), 'the portal says why: ' + refused);
	s.store.setRequestStatus(s.requests()[0].id, 'Rejected');
	s.store.submitPortalRequest({ board: 'b_red', player: 'alice', tile: 1, add: '1', note: 'portal' });
	is(s.requests().length, MAX_PENDING + 1, 'a reviewed request frees a place');
});

// ---------------------------------------------------------------- report

if (failures.length)
{
	console.error('\nSTORE TESTS FAILED (' + failures.length + '):');
	for (const failure of failures)
	{
		console.error('  x ' + failure);
	}
	process.exitCode = 1;
}
else
{
	console.log('Store tests: all scenarios passed.');
}
