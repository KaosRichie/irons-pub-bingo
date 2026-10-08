// One bingo event's data and every rule the plugin, the portal and the admin page rely on.
//
// Pure and synchronous: the Durable Object hands in the event's stored records, calls the
// methods below, then saves what changed (takeChanges) and sends the queued Discord posts
// (takeOutbox). A Durable Object runs one request at a time, so nothing here needs a lock.
//
// Records, stored one per key:
//   member:<board>|<id>   a player's own progress on one team scope, owned by a member key
//   meta:<board>          the board summary (labels, targets) for one team scope
//   score:<board>         a team's self-reported points, for the standings
//   left:<board>|<id>     a member who left that team scope (their progress stays parked)
//   request:<id>          a credit request from the plugin or the portal, on one team scope
//   credit:<id>           admin credit on one team scope: an approved request, or given by hand
//   config                teams, the official board code, the poll interval, the generation
//
// A team scope ("board") is "<board key>_<team code>": every team on the same board shares
// the board key, which is how standings and team switches find each other.
import { sha256 } from './sha256.js';

// Largest sync accepted. A real one is a few kilobytes.
const MAX_BODY_CHARS = 200000;
// Client clocks drift. A stamp further ahead than this is clamped on write: unclamped, it
// would outrank every later write, including the owner's own reset, forever.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MEMBER_ID = /^[0-9a-f]{16}$/;
// A team scope: "<board key>_<team code>". The team code has no underscore.
const BOARD_KEY = /^[A-Za-z0-9_-]+_[A-Za-z0-9-]+$/;
// Caps on what one client may store. A real board is at most 10x10.
const MAX_BOARD_KEY = 120;
const MAX_TILES = 100;
const MAX_GOALS = 50;
const MAX_LABEL = 200;
const MAX_MATCHED = 300;
const MAX_GOT = 40;
const MAX_REMOVE = 20;
// Pending requests one player may have waiting at once.
export const MAX_PENDING = 10;
const DISCORD_WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//;
export const REQUEST_STATUSES = ['Pending', 'Done', 'Rejected'];
const KINDS = { member: 'members', meta: 'metas', score: 'scores', left: 'departures', request: 'requests', credit: 'credits' };

export class EventStore
{
	/** @param records the stored [key, value] pairs, in key order */
	constructor(records)
	{
		this.members = new Map();
		this.metas = new Map();
		this.scores = new Map();
		this.departures = new Map();
		this.requests = new Map();
		this.credits = new Map();
		this.config = { teams: [], boardCode: '', pollSeconds: 0, epoch: 1, boardHash: null, boardSigs: null };
		this.changes = new Map();
		this.outbox = [];
		for (const [key, value] of records || [])
		{
			if (key === 'config')
			{
				Object.assign(this.config, value);
				continue;
			}
			const at = key.indexOf(':');
			const map = KINDS[key.slice(0, at)];
			if (map === 'metas')
			{
				// An older store may hold a summary no client should have sent. Repaired on
				// load, so the portal and the admin page always open.
				const meta = value ? cleanMeta(value.meta, true) : null;
				if (meta)
				{
					this.metas.set(key.slice(at + 1), Object.assign({}, value, { meta }));
				}
			}
			else if (map)
			{
				this[map].set(key.slice(at + 1), value);
			}
		}
	}

	// ------------------------------------------------------------------ bookkeeping

	set(kind, id, value)
	{
		this[KINDS[kind]].set(id, value);
		this.changes.set(kind + ':' + id, value);
	}

	drop(kind, id)
	{
		if (this[KINDS[kind]].delete(id))
		{
			this.changes.set(kind + ':' + id, undefined);
		}
	}

	saveConfig()
	{
		this.changes.set('config', this.config);
	}

	/** What changed since the last call: key -> new value, or undefined for a deletion. */
	takeChanges()
	{
		const changes = this.changes;
		this.changes = new Map();
		return changes;
	}

	/** Discord posts queued since the last call: { url, body }. */
	takeOutbox()
	{
		return this.outbox.splice(0);
	}

	// ------------------------------------------------------------------ plugin sync

	/** The plugin's one call: push its own progress, get the merged team state back. */
	sync(text)
	{
		if (String(text || '').length > MAX_BODY_CHARS)
		{
			return { error: 'Request too large' };
		}
		const body = parseJson(text, null);
		if (!body || typeof body !== 'object')
		{
			return { error: 'Not a sync request' };
		}
		if (body.teamsOnly)
		{
			// The plugin's Choose team picker, with who already plays on each team.
			return { teams: this.teamsWithMembers(String(body.board || '')) };
		}
		if (body.fetchBoard)
		{
			return this.fetchBoard();
		}

		const board = String(body.board || '');
		if (board.length > MAX_BOARD_KEY || !BOARD_KEY.test(board))
		{
			return { error: 'Bad board key' };
		}
		const members = body.members && typeof body.members === 'object' ? body.members : {};
		// Proof of identity. The store URL is shared clan-wide and member ids are public,
		// so a write for a member must carry that member's key, derived from their account
		// on their own client. A member's rows accept only the key that first wrote them.
		const keyHash = memberKeyHash(body.memberKey);
		let self = MEMBER_ID.test(String(body.rejoin || '')) ? String(body.rejoin) : null;
		if (self && !this.ownsMember(self, keyHash))
		{
			if (members[self])
			{
				return { board, error: keyHash ? 'Key mismatch - ask your host' : 'Update the plugin to sync' };
			}
			self = null;
		}

		// The member left this team scope, a few ids per sync. A member with progress on the
		// scope leaves it before the team check, so leaving a team the host has since
		// removed still works. Other departures wait for the checks below.
		const leaving = Array.isArray(body.remove) ? body.remove.slice(0, MAX_REMOVE).map(String)
			.filter(id => this.ownsMember(id, keyHash)) : [];
		const withRows = leaving.filter(id => this.members.has(board + '|' + id));
		const onlyLeaving = leaving.length > 0 && !self && !body.request && !Object.keys(members).length;
		this.markLeft(board, withRows);

		// Only teams the host listed may sync. With none listed the event is not set up
		// (or was just reset), and a client still holding an old board must not refill it.
		const teams = this.teamList();
		const team = teamOf(board);
		if (!teams.length || !this.hasTeam(team))
		{
			if (onlyLeaving)
			{
				return { board, left: withRows };
			}
			const error = !teams.length ? 'No teams yet - ask your host to add them'
				: team === 'solo' ? 'No team code - use Choose team or ask your host'
					: 'Unknown team code - use Choose team or ask your host';
			return { board, error, teams };
		}

		// With an official board code saved, clients must run exactly that board: a locally
		// edited copy (easier goals, same board id) is refused.
		const code = this.config.boardCode;
		const codeHash = code ? sha256Hex(code) : null;
		const official = code ? parseJson(code, null) : null;
		if (codeHash && String(body.boardHash || '') !== codeHash)
		{
			// A client on any earlier code of this board is told about the update. Anything
			// else is an edited board. The error stays short: it sits on the plugin's button.
			const currentVersion = Number((official || {}).version || 0);
			const clientVersion = Number(body.boardVersion || 0);
			const outdated = (currentVersion && clientVersion && clientVersion < currentVersion)
				|| this.isEarlierBoardCode(String(body.boardHash || ''));
			return {
				board,
				error: outdated ? 'Board updated' : 'Wrong board - use Import board, then Import from store',
				newerVersion: outdated ? currentVersion : undefined
			};
		}
		// The official board's scopes are the only ones: a made-up board key on a listed
		// team would otherwise start a second board for that team.
		const officialTiles = official && Array.isArray(official.tiles);
		const officialId = officialTiles ? normalizedBoardId(official) : '';
		if (officialId && board !== 'id_' + officialId + '_' + team)
		{
			return { board, error: 'Wrong board - use Import from store' };
		}

		// With an official code saved the summary comes from it, never from the client:
		// a client could otherwise rename tiles or lower targets for everyone.
		let meta = null;
		if (body.meta)
		{
			meta = officialTiles ? cleanMeta(metaFromBoard(official), true) : cleanMeta(body.meta, false);
			if (!meta && !officialTiles)
			{
				return { board, error: 'Board summary not valid' };
			}
		}

		this.markLeft(board, leaving);
		if (onlyLeaving)
		{
			return { board, left: leaving };
		}
		if (self)
		{
			// Syncing here clears the member's own "left" mark, so switching back to a team
			// heals itself, and leaves any sibling team on the same board: one team per board.
			this.drop('left', board + '|' + self);
			this.leaveSiblingTeams(board, self);
		}
		if (meta)
		{
			this.saveMeta(board, meta);
		}
		if (body.request && this.ownsMember(String(body.request.member || ''), keyHash))
		{
			this.recordRequest(board, body.request, false);
		}
		if (typeof body.teamPoints === 'number' && body.teamPoints >= 0 && isFinite(body.teamPoints))
		{
			this.saveScore(board, Math.floor(body.teamPoints));
		}
		// A client writes only its own progress. Relayed copies of teammates are ignored,
		// so nobody can overwrite someone else, and a player who never turned the store on
		// is never uploaded by a teammate.
		if (self && members[self] && !this.leftMembers(board)[self])
		{
			this.mergeOwnProgress(board, self, members[self], keyHash);
		}
		return this.teamState(board);
	}

	/** Last-write-wins per tile, by the owner's own timestamps. */
	mergeOwnProgress(board, memberId, incoming, keyHash)
	{
		const key = board + '|' + memberId;
		const row = this.members.get(key);
		const tiles = row ? Object.assign({}, row.tiles) : {};
		incoming = incoming && typeof incoming === 'object' ? incoming : {};
		const incomingTiles = incoming.tiles && typeof incoming.tiles === 'object' ? incoming.tiles : {};
		// Only tiles the board has, each cut to its goals: junk keys never pile up.
		const meta = this.metaFor(board);
		const tileCount = meta ? meta.tiles.length : MAX_TILES;
		const maxTs = Date.now() + MAX_CLOCK_SKEW_MS;
		let changed = false;
		for (const tileKey of Object.keys(incomingTiles))
		{
			const index = /^(0|[1-9][0-9]{0,2})$/.test(tileKey) ? Number(tileKey) : -1;
			const goalCap = meta && index >= 0 && index < tileCount ? Math.max(1, meta.tiles[index].goals.length) : MAX_GOALS;
			const next = index >= 0 && index < tileCount ? cleanTileProgress(incomingTiles[tileKey], goalCap) : null;
			if (!next)
			{
				continue;
			}
			if (next.ts > maxTs)
			{
				// Clamp to now, not to now plus the skew: the next honest write must win.
				next.ts = Date.now();
			}
			const current = tiles[tileKey];
			if (!current || next.ts > (current.ts || 0))
			{
				tiles[tileKey] = next;
				changed = true;
			}
		}
		const name = cleanPlayerName(incoming.name) || (row ? row.name : '');
		if (!row || changed || name !== row.name)
		{
			this.set('member', key, { board, member: memberId, name, updated: new Date().toISOString(),
				tiles, key: row ? row.key : keyHash });
		}
	}

	/** Whether a request with this key hash may act for the member. Keyless requests act for nobody. */
	ownsMember(memberId, keyHash)
	{
		if (!keyHash || !MEMBER_ID.test(memberId))
		{
			return false;
		}
		for (const row of this.members.values())
		{
			if (row.member === memberId && row.key !== keyHash)
			{
				return false;
			}
		}
		return true;
	}

	/** Everything a client needs back: members, admin credit, teams, departures, standings. */
	teamState(board)
	{
		const left = this.leftMembers(board);
		const members = {};
		for (const row of this.members.values())
		{
			if (row.board === board && !left[row.member])
			{
				members[row.member] = { name: row.name, tiles: row.tiles };
			}
		}
		Object.assign(members, this.creditMembers(board, this.metaFor(board)));
		return {
			board,
			members,
			teams: this.teamList(),
			removed: Object.keys(left),
			pollSeconds: this.config.pollSeconds || 0,
			epoch: this.config.epoch,
			standings: this.standingsFor(board)
		};
	}

	/** The plugin's Import from store: the official board code. */
	fetchBoard()
	{
		const code = this.config.boardCode;
		if (!code)
		{
			return { error: 'No board code on the store yet - paste the code from your host' };
		}
		const parsed = parseJson(code, null);
		return parsed && parsed.tiles ? { boardJson: code }
			: { error: 'The board code on the store is not valid - ask your host to save it again.' };
	}

	// ------------------------------------------------------------------ teams, departures, scores

	/** The host's teams as clients see them: code and name, never the webhook. */
	teamList()
	{
		return this.config.teams.map(t => ({ code: t.code, name: t.name }));
	}

	hasTeam(code)
	{
		return this.config.teams.some(t => t.code === code);
	}

	teamInfo(code)
	{
		return this.config.teams.find(t => t.code === code) || null;
	}

	/**
	 * The teams, each with the names of the members stored under this board key, minus
	 * those who left. Without a board key (the client has no board yet) every board counts.
	 */
	teamsWithMembers(boardKey)
	{
		return this.teamList().map(team =>
		{
			const suffix = '_' + team.code;
			const names = [];
			for (const row of this.members.values())
			{
				const inScope = boardKey ? row.board === boardKey + suffix
					: row.board.length > suffix.length && row.board.endsWith(suffix);
				if (inScope && !this.departures.has(row.board + '|' + row.member))
				{
					const name = row.name || row.member;
					if (names.indexOf(name) < 0)
					{
						names.push(name);
					}
				}
			}
			names.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
			return Object.assign(team, { members: names });
		});
	}

	/** Whether a player name belongs to someone who has synced to this board's team. */
	isTeamMember(board, player)
	{
		const at = board.lastIndexOf('_');
		const name = cleanPlayerName(player).toLowerCase();
		if (at < 0 || !name)
		{
			return false;
		}
		const team = this.teamsWithMembers(board.slice(0, at)).find(t => t.code === board.slice(at + 1));
		return !!team && team.members.some(m => m.toLowerCase() === name);
	}

	/** Member ids that left this team scope. Their progress is kept but stops counting. */
	leftMembers(board)
	{
		const left = {};
		const prefix = board + '|';
		for (const key of this.departures.keys())
		{
			if (key.startsWith(prefix))
			{
				left[key.slice(prefix.length)] = true;
			}
		}
		return left;
	}

	markLeft(board, ids)
	{
		for (const id of ids)
		{
			if (MEMBER_ID.test(id) && !this.departures.has(board + '|' + id))
			{
				this.set('left', board + '|' + id, { when: new Date().toISOString() });
			}
		}
	}

	/** A member's arrival on a team marks them left on every sibling team of the same board. */
	leaveSiblingTeams(board, memberId)
	{
		const prefix = boardPrefix(board);
		if (!prefix)
		{
			return;
		}
		for (const row of this.members.values())
		{
			if (row.member === memberId && row.board !== board && row.board.startsWith(prefix))
			{
				this.markLeft(row.board, [memberId]);
			}
		}
	}

	saveScore(board, points)
	{
		const known = this.scores.get(board);
		if (!known || known.points !== points)
		{
			this.set('score', board, { points, updated: new Date().toISOString() });
		}
	}

	/** Every team's points on this board, best first. */
	standingsFor(board)
	{
		const prefix = boardPrefix(board);
		if (!prefix)
		{
			return [];
		}
		const standings = [];
		for (const [key, score] of this.scores)
		{
			if (key.startsWith(prefix))
			{
				standings.push({ team: teamOf(key), points: Number(score.points) || 0 });
			}
		}
		return standings.sort((a, b) => b.points - a.points);
	}

	// ------------------------------------------------------------------ board summaries

	metaFor(board)
	{
		const entry = this.metas.get(board);
		return entry ? entry.meta : null;
	}

	saveMeta(board, meta)
	{
		const known = this.metas.get(board);
		if (!known || JSON.stringify(known.meta) !== JSON.stringify(meta))
		{
			this.set('meta', board, { updated: new Date().toISOString(), meta });
		}
	}

	/** The most recently updated team scope of a team, with its summary, or null. */
	latestBoardForTeam(team)
	{
		// With an official board saved, its scope wins: a stray scope must not steer the
		// portal, the admin pages or credit.
		const official = this.officialBoard();
		const id = official ? normalizedBoardId(official) : '';
		const scope = id ? this.scopeOf('id_' + id + '_' + team) : null;
		if (scope)
		{
			return scope;
		}
		let best = null;
		for (const [board, entry] of this.metas)
		{
			if (teamOf(board) === team && entry.meta && entry.meta.tiles && (!best || entry.updated > best.updated))
			{
				best = { board, meta: entry.meta, updated: entry.updated };
			}
		}
		return best;
	}

	/** A team scope with its board summary, or null when it has none. */
	scopeOf(board)
	{
		const meta = this.metaFor(String(board || ''));
		return meta && meta.tiles ? { board, meta } : null;
	}

	/** The official board code, parsed, or null. */
	officialBoard()
	{
		const parsed = parseJson(this.config.boardCode, null);
		return parsed && Array.isArray(parsed.tiles) ? parsed : null;
	}

	// ------------------------------------------------------------------ progress totals

	/**
	 * Per tile and goal: the tracked and the credited totals, who contributed what, who
	 * ticked a manual tile, and whether the tile is done by the plugin's rules.
	 */
	tileTotals(board, meta)
	{
		const left = this.leftMembers(board);
		const credited = this.creditMembers(board, meta);
		const tracked = [];
		const verified = [];
		const manual = [];
		const distinctSets = [];
		const contrib = [];
		const manualBy = [];
		for (const tile of meta.tiles)
		{
			const goalCount = Math.max(1, (tile.goals || []).length);
			tracked.push(new Array(goalCount).fill(0));
			verified.push(new Array(goalCount).fill(0));
			distinctSets.push(Array.from({ length: goalCount }, () => ({})));
			contrib.push(Array.from({ length: goalCount }, () => ({})));
			manual.push(false);
			manualBy.push({});
		}

		const absorb = (tiles, into, playerName) =>
		{
			for (const key of Object.keys(tiles || {}))
			{
				const index = parseInt(key, 10);
				if (isNaN(index) || index < 0 || index >= meta.tiles.length)
				{
					continue;
				}
				const entry = tiles[key] || {};
				if (entry.manual)
				{
					manual[index] = true;
					manualBy[index][playerName] = true;
				}
				// Rows stored before progress was checked on write may hold junk: skip it.
				const goals = Array.isArray(entry.goals) ? entry.goals : [];
				for (let g = 0; g < goals.length && g < into[index].length; g++)
				{
					const goalMeta = meta.tiles[index].goals[g] || {};
					const goal = goals[g] || {};
					const matched = Array.isArray(goal.matched) ? goal.matched : null;
					// The counter always adds up. On a distinct goal it carries admin credit,
					// which has no item names: the plugin counts names plus counter too.
					let amount = Number(goal.n) || 0;
					into[index][g] += amount;
					if (goalMeta.distinct && matched && matched.length)
					{
						// Distinct goals count each different item once for the whole team.
						for (const name of matched)
						{
							distinctSets[index][g][String(name).toLowerCase()] = true;
						}
						amount += matched.length;
					}
					if (amount > 0)
					{
						contrib[index][g][playerName] = (contrib[index][g][playerName] || 0) + amount;
					}
				}
			}
		};

		for (const row of this.members.values())
		{
			if (row.board === board && !left[row.member])
			{
				absorb(row.tiles, tracked, row.name || row.member);
			}
		}
		for (const id of Object.keys(credited))
		{
			absorb(credited[id].tiles, verified, credited[id].name);
		}
		for (let t = 0; t < tracked.length; t++)
		{
			for (let g = 0; g < tracked[t].length; g++)
			{
				tracked[t][g] += Object.keys(distinctSets[t][g]).length;
			}
		}
		const done = meta.tiles.map((tile, t) => manual[t]
			|| ((tile.goals || []).length > 0 && tileReached(tile, tracked[t], verified[t])));
		return { tracked, verified, done, contrib, manualBy };
	}

	// ------------------------------------------------------------------ admin credit

	/**
	 * Admin credit as synthetic members the plugin merges like teammates, one per player,
	 * named "<player> (verified)". Credit adds up, and a negative amount corrects a
	 * mistake, in what the player tracked or was credited, down to zero for that player.
	 */
	creditMembers(board, meta)
	{
		const members = {};
		const stamp = Date.now();
		for (const credit of this.credits.values())
		{
			// Credit belongs to the board it was given on: a new board starts without it.
			const parsed = parseCredit(credit, meta);
			if (credit.board !== board || parsed.issues.length)
			{
				continue;
			}
			const id = 'admin:' + parsed.player.toLowerCase();
			members[id] = members[id] || { name: parsed.player + ' (verified)', tiles: {} };
			const key = String(parsed.tile - 1);
			const tile = members[id].tiles[key] = members[id].tiles[key] || { goals: [], manual: false, ts: stamp };
			while (tile.goals.length < parsed.goal)
			{
				tile.goals.push({ n: 0 });
			}
			tile.goals[parsed.goal - 1].n += parsed.add;
			tile.manual = tile.manual || parsed.complete;
		}
		// Negative credit corrects progress, it never penalizes: it takes a player down to
		// zero at most, counting what they tracked themselves and what they were credited.
		for (const [id, member] of Object.entries(members))
		{
			const player = id.slice('admin:'.length);
			for (const [key, tile] of Object.entries(member.tiles))
			{
				tile.goals.forEach((goal, g) =>
				{
					let tracked = 0;
					for (const row of this.members.values())
					{
						const own = row.board === board && String(row.name || '').toLowerCase() === player
							&& row.tiles && row.tiles[key];
						if (own && !this.departures.has(row.board + '|' + row.member))
						{
							tracked += Number(((own.goals || [])[g] || {}).n || 0);
						}
					}
					goal.n = Math.max(-tracked, goal.n);
				});
			}
		}
		return members;
	}

	/** Admin credit given by hand on the admin page, announced like an approval. */
	addCredit(fields)
	{
		const team = String(fields.team || '').trim().toLowerCase();
		const scope = this.latestBoardForTeam(team);
		const credit = {
			board: scope ? scope.board : '',
			team,
			tile: parseInt(fields.tile, 10),
			goal: fields.goal === '' || fields.goal == null ? null : parseInt(fields.goal, 10),
			player: cleanPlayerName(fields.player),
			add: fields.add === '' || fields.add == null ? 0 : Number(fields.add),
			complete: !!fields.complete,
			note: String(fields.note || '').slice(0, 200),
			request: null,
			by: 'admin page'
		};
		const issues = parseCredit(credit, scope ? scope.meta : null).issues;
		if (!scope || issues.length)
		{
			return { error: scope ? issues.join('. ') : 'That team has no board yet.' };
		}
		if (!this.isTeamMember(scope.board, credit.player))
		{
			return { error: 'Pick a player who has synced to this team.' };
		}
		const alerts = [];
		if (credit.add < 0)
		{
			// A correction takes off what the player has right now, and no more: stored as
			// that amount, it can never lie in wait and eat progress they make later.
			const has = this.playerGoalTotal(scope.board, credit.player, credit.tile, credit.goal || 1);
			if (has <= 0)
			{
				return { error: credit.player + ' has no progress on that goal to take off.' };
			}
			if (-credit.add > has)
			{
				credit.add = -has;
				alerts.push('Took off ' + has + ', all of ' + credit.player + "'s progress on that goal.");
			}
		}
		// The before and after around the write tell the post whether this finished the
		// tile, and which bingo lines it completed.
		const doneBefore = this.tileTotals(scope.board, scope.meta).done.slice();
		this.writeCredit(credit);
		this.announceApproval(credit, scope, doneBefore);
		return alerts.length ? { ok: true, alerts } : { ok: true };
	}

	/** A player's progress on one goal right now: what they tracked plus what they were credited. */
	playerGoalTotal(board, player, tileNumber, goalNumber)
	{
		const name = String(player || '').trim().toLowerCase();
		const key = String(tileNumber - 1);
		let total = 0;
		for (const row of this.members.values())
		{
			if (row.board === board && String(row.name || '').toLowerCase() === name
				&& !this.departures.has(row.board + '|' + row.member) && row.tiles && row.tiles[key])
			{
				total += Number(((row.tiles[key].goals || [])[goalNumber - 1] || {}).n || 0);
			}
		}
		const credited = this.creditMembers(board, this.metaFor(board))['admin:' + name];
		const tile = credited && credited.tiles[key];
		return total + Number(tile && tile.goals[goalNumber - 1] ? tile.goals[goalNumber - 1].n : 0);
	}

	writeCredit(credit)
	{
		const id = newId('c');
		this.set('credit', id, Object.assign({ id, added: new Date().toISOString() }, credit));
	}

	/** Takes credit back, announced on the team's webhook. */
	removeCredit(id)
	{
		const credit = this.credits.get(String(id));
		if (!credit)
		{
			return { error: 'That credit no longer exists. Reload the page.' };
		}
		this.drop('credit', credit.id);
		this.announceWithdrawal(credit, this.scopeOf(credit.board));
		return { ok: true };
	}

	// ------------------------------------------------------------------ credit requests

	/**
	 * Files a credit request. Validated but never trusted: nothing counts until an admin
	 * approves it. Plugin requests carry the sender's member id; portal requests are
	 * marked "portal" and name a player who synced to the team.
	 *
	 * @return the request id, or null when it was invalid or already waiting
	 */
	recordRequest(board, request, fromPortal)
	{
		const member = fromPortal ? 'portal' : String(request.member || '');
		const player = cleanPlayerName(request.player);
		const tile = parseInt(request.tile, 10);
		const goal = request.goal == null || request.goal === '' ? null : parseInt(request.goal, 10);
		const add = request.add == null || request.add === '' ? null : Number(request.add);
		const complete = request.complete === true;
		if ((!fromPortal && !MEMBER_ID.test(member)) || !player || isNaN(tile) || tile < 1
			|| (add === null && !complete) || (add !== null && !(isFinite(add) && add > 0))
			|| (goal !== null && (isNaN(goal) || goal < 1)))
		{
			return null;
		}
		// The tile and goal must exist, or the approval would land nowhere.
		const meta = this.metaFor(board);
		if (meta && meta.tiles && (tile > meta.tiles.length
			|| (goal !== null && goal > (meta.tiles[tile - 1].goals || []).length)))
		{
			return null;
		}
		const fields = {
			board, team: teamOf(board), player, tile, goal, add, complete,
			note: String(request.note || '').slice(0, 300), member
		};
		for (const known of this.requests.values())
		{
			// A retried send must not stack duplicate requests.
			if (known.status === 'Pending' && ['team', 'player', 'tile', 'goal', 'add', 'complete', 'note', 'member']
				.every(k => known[k] === fields[k]))
			{
				return null;
			}
		}
		if (this.pendingCount(fields.team, player, member) >= MAX_PENDING)
		{
			return null; // a changed note must not file request after request
		}
		const id = newId('r');
		this.set('request', id, Object.assign({ id, when: new Date().toISOString() }, fields,
			{ links: cleanProofLinks(request.links), status: 'Pending' }));
		return id;
	}

	/** Pending requests on a team for this player name, or sent by this member's client. */
	pendingCount(team, player, member)
	{
		const name = String(player || '').toLowerCase();
		let count = 0;
		for (const known of this.requests.values())
		{
			if (known.status === 'Pending' && known.team === team
				&& (String(known.player || '').toLowerCase() === name || (member !== 'portal' && known.member === member)))
			{
				count++;
			}
		}
		return count;
	}

	/** The portal's request form. Returns a confirmation, or throws with the reason. */
	submitPortalRequest(payload)
	{
		payload = payload || {};
		const board = String(payload.board || '');
		if (!this.metaFor(board))
		{
			throw new Error('This team has no board yet.');
		}
		if (!this.isTeamMember(board, payload.player))
		{
			throw new Error('Pick your name from the list. Only players who have synced to this team can request credit.');
		}
		if (this.pendingCount(teamOf(board), cleanPlayerName(payload.player), 'portal') >= MAX_PENDING)
		{
			throw new Error('You have ' + MAX_PENDING + ' requests waiting. Wait for an admin to review them.');
		}
		const id = this.recordRequest(board, {
			player: payload.player, tile: payload.tile, goal: payload.goal, add: payload.add,
			complete: payload.complete === true, note: payload.note, links: payload.links
		}, true);
		if (!id)
		{
			throw new Error('Fill in an amount, or pick the whole tile. The same request may already be waiting.');
		}
		return 'Request sent. An admin will review it.';
	}

	/**
	 * Approves, rejects or reopens a request. Approving writes its credit exactly once, and
	 * any other status takes an approval back. Both are announced on the team's webhook.
	 */
	setRequestStatus(id, status)
	{
		if (REQUEST_STATUSES.indexOf(status) < 0)
		{
			return { error: 'Unknown status' };
		}
		const request = this.requests.get(String(id));
		if (!request)
		{
			return { error: 'That request no longer exists. Reload the page.' };
		}
		const scope = this.scopeOf(request.board);
		const credit = [...this.credits.values()].find(c => c.request === request.id);
		if (status === 'Done' && !credit)
		{
			const doneBefore = scope ? this.tileTotals(scope.board, scope.meta).done.slice() : null;
			this.writeCredit({
				board: request.board, team: request.team, tile: request.tile, goal: request.goal, player: request.player,
				add: request.add || 0, complete: request.complete, note: request.note,
				request: request.id, by: 'approved request'
			});
			this.announceApproval(request, scope, doneBefore);
		}
		else if (status !== 'Done' && credit)
		{
			this.drop('credit', credit.id);
			this.announceWithdrawal(request, scope);
		}
		this.set('request', request.id, Object.assign({}, request, { status }));
		return { ok: true };
	}

	// ------------------------------------------------------------------ Discord

	/**
	 * Announces approved credit on the team's webhook. When it finishes the tile, the post
	 * mirrors the plugin's completion post, so verified tiles get the same moment in the
	 * channel as tracked ones.
	 */
	announceApproval(item, scope, doneBefore)
	{
		const team = this.teamInfo(item.team);
		if (!team || !DISCORD_WEBHOOK.test(team.webhook || ''))
		{
			return;
		}
		const tileIndex = item.tile - 1;
		const doneAfter = scope && doneBefore ? this.tileTotals(scope.board, scope.meta).done : null;
		let content;
		if (doneAfter && tileIndex >= 0 && tileIndex < scope.meta.tiles.length
			&& doneAfter[tileIndex] && !doneBefore[tileIndex])
		{
			content = ':tada: **' + item.player + '** completed **' + tileLabel(item, scope)
				+ '** (admin verified) for team **' + (team.name || team.code) + '**'
				+ '\n' + (scope.meta.name || 'Bingo board') + ': '
				+ doneAfter.filter(Boolean).length + '/' + scope.meta.tiles.length + ' tiles'
				+ '\nCredit: ' + creditText(item, scope);
			const bonus = bonusLine(scope.meta, doneBefore, doneAfter);
			if (bonus)
			{
				content += '\n:sparkles: ' + bonus;
			}
		}
		else
		{
			content = ':white_check_mark: Credit approved for ' + requestSummary(item, scope);
		}
		this.post(team.webhook, content + noteAndProof(item));
	}

	announceWithdrawal(item, scope)
	{
		const team = this.teamInfo(item.team);
		if (team && DISCORD_WEBHOOK.test(team.webhook || ''))
		{
			this.post(team.webhook, ':no_entry: Credit withdrawn for ' + requestSummary(item, scope) + noteAndProof(item));
		}
	}

	/** Player text (names, notes) can never ping anyone: mentions are off. */
	post(url, content)
	{
		this.outbox.push({ url, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
	}

	// ------------------------------------------------------------------ host settings

	saveTeams(teams)
	{
		if (!Array.isArray(teams))
		{
			return { error: 'No teams sent' };
		}
		const rows = [];
		for (const team of teams)
		{
			const code = teamCodeOf(team.code);
			if (!code)
			{
				continue;
			}
			if (rows.some(r => r.code === code))
			{
				return { error: 'Two teams use the code "' + code + '".' };
			}
			rows.push({ code, name: String(team.name || '').trim().slice(0, 60), webhook: String(team.webhook || '').trim() });
		}
		this.config.teams = rows;
		this.saveConfig();
		// A new team shows the official board in the portal before anyone syncs.
		const official = this.officialBoard();
		if (official)
		{
			this.seedMetas(official, normalizedBoardId(official));
		}
		return { ok: true, teams: rows.length };
	}

	savePollInterval(seconds)
	{
		seconds = Math.round(Number(seconds));
		if (!(seconds >= 60 && seconds <= 900))
		{
			return { error: 'Pick a value from 60 to 900 seconds.' };
		}
		this.config.pollSeconds = seconds;
		this.saveConfig();
		return { ok: true };
	}

	/**
	 * Saves the official board code. Every member's stored progress on a tile that now
	 * tracks something else is wiped, the store-wide twin of the plugin's per-tile reset.
	 * Tiles that only changed labels, points or targets keep their progress.
	 *
	 * @return a message for the admin
	 */
	saveBoardCode(code)
	{
		const parsed = parseJson(code, null);
		if (!parsed || !parsed.tiles)
		{
			return 'That board code is not valid. Export it again from Bingo Forge.';
		}
		const hash = sha256Hex(code);
		this.config.boardCode = code;
		const unchanged = this.config.boardHash === hash;
		const sigs = parsed.tiles.map(tileTrackingSignature);
		const id = normalizedBoardId(parsed);
		const previous = this.config.boardSigs;
		// Every code saved for this board id, newest last, so the sync check can tell an
		// outdated client from an edited board whatever version it reports. Saving an
		// earlier code again makes it current, and the one it replaced becomes outdated.
		const hashes = (previous && previous.id === id && previous.hashes ? previous.hashes : [])
			.filter(h => h !== hash).concat([hash]).slice(-30);
		this.config.boardHash = hash;
		this.config.boardSigs = { id, sigs, hashes };
		this.saveConfig();
		this.seedMetas(parsed, id);
		if (unchanged)
		{
			return 'Board code unchanged.';
		}
		if (!previous || !previous.sigs || !id || previous.id !== id)
		{
			return 'Board recorded. It is a new board, so nothing was reset.';
		}
		const changed = [];
		for (let i = 0; i < sigs.length && i < previous.sigs.length; i++)
		{
			if (sigs[i] !== previous.sigs[i])
			{
				changed.push(i);
			}
		}
		if (!changed.length)
		{
			return 'Board updated. No tile changed what it tracks, so all progress is kept.';
		}
		this.wipeTiles(board => board.startsWith('id_' + id + '_')
			// "id_spring_" must not also match board "spring_2": a team code has no underscore.
			&& board.slice(('id_' + id + '_').length).indexOf('_') < 0, changed);
		return 'Board updated. These tiles now track something else, so their progress was reset:\n'
			+ changed.map(i => (i + 1) + '. ' + (parsed.tiles[i].label || '')).join('\n');
	}

	/** Whether the hash is an earlier saved code of the current board. */
	isEarlierBoardCode(hash)
	{
		const sigs = this.config.boardSigs;
		return !!hash && hash !== this.config.boardHash && !!sigs && (sigs.hashes || []).indexOf(hash) >= 0;
	}

	/** The official board's summary for every team, so the portal shows it before anyone syncs. */
	seedMetas(parsed, id)
	{
		if (!id)
		{
			return; // an id-less board's scope keys are only known once a client syncs
		}
		const meta = cleanMeta(metaFromBoard(parsed), true);
		if (!meta)
		{
			return; // a board with no tiles has nothing to show
		}
		for (const team of this.config.teams)
		{
			this.saveMeta('id_' + id + '_' + team.code, meta);
		}
	}

	/**
	 * Wipes one tile's stored progress for every member of a team. Credit stays: it is
	 * the admins' own ledger.
	 *
	 * @return a message for the admin
	 */
	resetTile(team, tileNumber)
	{
		const scope = this.latestBoardForTeam(String(team || '').toLowerCase());
		if (!scope)
		{
			return 'No board found for team "' + team + '".';
		}
		if (!(tileNumber >= 1 && tileNumber <= scope.meta.tiles.length))
		{
			return 'Tile ' + tileNumber + ' does not exist (board has ' + scope.meta.tiles.length + ' tiles).';
		}
		const rows = this.wipeTiles(board => board === scope.board, [tileNumber - 1]);
		return 'Reset "' + (scope.meta.tiles[tileNumber - 1].label || 'tile ' + tileNumber) + '" for ' + rows
			+ ' member(s) of team "' + team + '".\nCredit given for this tile still counts. Remove it under Give credit if it should not.';
	}

	/**
	 * Replaces the tiles with an empty state stamped past anything a client may still send,
	 * so the wipe wins the last-write merge against every cached copy. Plain deletion would
	 * come back from teammates' caches.
	 */
	wipeTiles(matchesBoard, tileIndexes)
	{
		const stamp = Date.now() + MAX_CLOCK_SKEW_MS + 1;
		let wiped = 0;
		for (const [key, row] of this.members)
		{
			if (!matchesBoard(row.board))
			{
				continue;
			}
			const tiles = Object.assign({}, row.tiles);
			for (const index of tileIndexes)
			{
				tiles[String(index)] = { goals: [], manual: false, ts: stamp };
			}
			this.set('member', key, Object.assign({}, row, { tiles, updated: new Date().toISOString() }));
			wiped++;
		}
		return wiped;
	}

	/**
	 * Clears all event data: progress, teams, the board code, credit, requests and
	 * departures. Only the poll interval stays. The new generation tells every client to
	 * drop what it cached about teammates, so the old event cannot push itself back in.
	 */
	resetEvent()
	{
		for (const kind of Object.keys(KINDS))
		{
			for (const id of [...this[KINDS[kind]].keys()])
			{
				this.drop(kind, id);
			}
		}
		this.config = { teams: [], boardCode: '', pollSeconds: this.config.pollSeconds, epoch: this.config.epoch + 1,
			boardHash: null, boardSigs: null };
		this.saveConfig();
	}
}

// ---------------------------------------------------------------------- helpers

/** Team code of a team scope ("<board key>_<team code>"). */
export function teamOf(board)
{
	const at = board.lastIndexOf('_');
	return at < 0 ? '' : board.slice(at + 1);
}

/** "<board key>_", the part sibling team scopes share; null when there is no team. */
function boardPrefix(board)
{
	const at = board.lastIndexOf('_');
	return at < 0 ? null : board.slice(0, at + 1);
}

/** A team code as the plugin normalizes it. */
function teamCodeOf(code)
{
	return String(code || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-+|-+$)/g, '');
}

/** The plugin's board id normalization; '' when the board has no id. */
function normalizedBoardId(parsed)
{
	return String(parsed.id == null ? '' : parsed.id).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
}

/** Ids that sort by creation time, so stored requests and credit list in order. */
function newId(prefix)
{
	return prefix + Date.now().toString(36).padStart(9, '0') + Math.random().toString(36).slice(2, 8);
}

function sha256Hex(text)
{
	return Array.from(sha256(text), b => b.toString(16).padStart(2, '0')).join('');
}

/** What the store keeps of a member key: a hash, so reading storage can't sign as them. */
function memberKeyHash(memberKey)
{
	const raw = String(memberKey || '');
	return /^[0-9a-f]{64}$/.test(raw) ? sha256Hex('member-key:' + raw).slice(0, 32) : '';
}

function cleanPlayerName(name)
{
	return String(name || '').trim().slice(0, 40);
}

/** Keeps only things that look like http(s) links, at most 5. */
function cleanProofLinks(text)
{
	return String(text || '').split(/[\s,]+/).filter(part => /^https?:\/\/\S{4,300}$/i.test(part)).slice(0, 5);
}

export function parseJson(text, fallback)
{
	if (!text)
	{
		return fallback;
	}
	try
	{
		return JSON.parse(text) || fallback;
	}
	catch (err)
	{
		return fallback;
	}
}

/** Reads and checks one credit against the board. Bad credit is reported, never guessed at. */
export function parseCredit(credit, meta)
{
	const out = {
		team: String(credit.team || '').trim().toLowerCase(),
		tile: parseInt(credit.tile, 10),
		goal: credit.goal == null || credit.goal === '' ? 1 : parseInt(credit.goal, 10),
		player: String(credit.player || '').trim(),
		add: Number(credit.add) || 0,
		complete: !!credit.complete,
		issues: []
	};
	if (!out.player)
	{
		out.issues.push('Player is required');
	}
	const tiles = meta && meta.tiles;
	if (isNaN(out.tile) || out.tile < 1)
	{
		out.issues.push('Pick a tile');
	}
	else if (tiles && out.tile > tiles.length)
	{
		out.issues.push('Tile ' + out.tile + ' does not exist (board has ' + tiles.length + ' tiles)');
	}
	if (isNaN(out.goal) || out.goal < 1)
	{
		out.issues.push('Pick a goal');
	}
	else if (tiles && out.tile >= 1 && out.tile <= tiles.length && out.goal > (tiles[out.tile - 1].goals || []).length)
	{
		out.issues.push('Tile ' + out.tile + ' has ' + (tiles[out.tile - 1].goals || []).length + ' goal(s)');
	}
	if (!out.add && !out.complete)
	{
		out.issues.push('Nothing to credit: give an amount, or mark the tile complete');
	}
	return out;
}

/**
 * The plugin's completion rule (BingoTile.isComplete): a manual goal never completes by
 * count, an ALL tile with a manual goal needs the tick, an ANY tile needs one counted goal.
 */
function tileReached(tile, tracked, verified)
{
	const anyMode = tile.mode === 'ANY';
	let sawManual = false;
	for (let g = 0; g < tile.goals.length; g++)
	{
		if (tile.goals[g].manual)
		{
			sawManual = true;
			continue;
		}
		const target = Number(tile.goals[g].target || 0);
		const reached = target > 0 && tracked[g] + verified[g] >= target;
		if (anyMode && reached)
		{
			return true;
		}
		if (!anyMode && !reached)
		{
			return false;
		}
	}
	return !anyMode && !sawManual;
}

/** Completed bingo lines in a done[] array, counted like the plugin does. */
export function linesInDone(meta, done)
{
	const size = meta.size || Math.round(Math.sqrt(meta.tiles.length));
	let lines = 0;
	for (let r = 0; r < size; r++)
	{
		let row = true;
		let col = true;
		for (let c = 0; c < size; c++)
		{
			row = row && !!done[r * size + c];
			col = col && !!done[c * size + r];
		}
		lines += (row ? 1 : 0) + (col ? 1 : 0);
	}
	if (meta.diagonals === false)
	{
		return lines;
	}
	let diag = true;
	let anti = true;
	for (let i = 0; i < size; i++)
	{
		diag = diag && !!done[i * size + i];
		anti = anti && !!done[i * size + (size - 1 - i)];
	}
	return lines + (diag ? 1 : 0) + (anti ? 1 : 0);
}

/** The plugin's line and blackout bonus message for a done[] change, or ''. */
function bonusLine(meta, doneBefore, doneAfter)
{
	const total = meta.tiles.length;
	let text = '';
	const gained = linesInDone(meta, doneAfter) - linesInDone(meta, doneBefore);
	if (gained > 0)
	{
		const linePoints = Number(meta.linePoints || 0);
		text = 'Bingo! ' + (gained === 1 ? 'Line complete' : gained + ' lines complete')
			+ (linePoints > 0 ? ' (+' + gained * linePoints + ' pts)' : '');
	}
	if (doneAfter.filter(Boolean).length === total && doneBefore.filter(Boolean).length < total)
	{
		const blackoutPoints = Number(meta.blackoutPoints || 0);
		text += (text ? ' - ' : '') + 'BLACKOUT! Every tile complete' + (blackoutPoints > 0 ? ' (+' + blackoutPoints + ' pts)' : '');
	}
	return text;
}

function tileLabel(item, scope)
{
	const tile = scope && scope.meta.tiles[item.tile - 1];
	return tile && tile.label ? String(tile.label) : 'Tile ' + item.tile;
}

/** "+40 on goal 1 (Kills: Man)", or "tile complete". */
function creditText(item, scope)
{
	const what = item.complete ? 'tile complete' : (item.add < 0 ? '' : '+') + item.add;
	const goal = parseInt(item.goal, 10);
	if (isNaN(goal) || goal < 1)
	{
		return what;
	}
	const tile = scope && scope.meta.tiles[item.tile - 1];
	const label = tile && (tile.goals || [])[goal - 1] ? String(tile.goals[goal - 1].label || '') : '';
	return what + ' on goal ' + goal + (label ? ' (' + label + ')' : '');
}

/** "**Alice**: 10 kills, +40 on goal 1 (Kills: Man)". */
function requestSummary(item, scope)
{
	return '**' + item.player + '**: ' + tileLabel(item, scope) + ', ' + creditText(item, scope);
}

function noteAndProof(item)
{
	let lines = '';
	if (String(item.note || '').trim())
	{
		lines += '\n' + item.note;
	}
	if (item.links && item.links.length)
	{
		lines += '\nProof: ' + item.links.join('  ');
	}
	return lines;
}

// ---------------------------------------------------------------------- board summaries

/** The store's twin of the plugin's board summary (buildBoardMeta). */
export function metaFromBoard(board)
{
	const tiles = board.tiles || [];
	return {
		name: board.name || '',
		size: Number(board.size) > 0 ? Number(board.size) : Math.round(Math.sqrt(tiles.length)),
		diagonals: board.diagonals == null ? true : !!board.diagonals,
		linePoints: Math.max(0, Number(board.linePoints) || 0),
		blackoutPoints: Math.max(0, Number(board.blackoutPoints) || 0),
		tiles: tiles.map((tile, t) =>
		{
			tile = tile || {};
			const goals = tile.goals && tile.goals.length ? tile.goals : [{ type: 'MANUAL' }];
			return {
				label: tile.label || 'Tile ' + (t + 1),
				mode: String(tile.mode || 'ALL').toUpperCase() === 'ANY' ? 'ANY' : 'ALL',
				goals: goals.map(goal =>
				{
					goal = goal || {};
					const type = String(goal.type || 'MANUAL').toUpperCase();
					return {
						label: goalShortLabel(goal, type),
						target: type === 'XP' ? Number(goal.amount) || 0 : type === 'MANUAL' ? 1
							: goal.count == null ? 1 : Number(goal.count) || 1,
						distinct: ((type === 'DROP' || type === 'RAID_PURPLE') && !!goal.distinct)
							|| (type === 'PET' && !!(goal.pets && goal.pets.length)),
						manual: type === 'MANUAL'
					};
				})
			};
		})
	};
}

/**
 * A board summary with only the fields the store reads, or null when it is not one.
 * A client's summary must be well formed (repair false). A stored one keeps what it can:
 * a broken tile becomes an empty one, so old bad data never breaks the pages.
 */
export function cleanMeta(meta, repair)
{
	if (!meta || typeof meta !== 'object' || !Array.isArray(meta.tiles) || !meta.tiles.length
		|| (!repair && meta.tiles.length > MAX_TILES))
	{
		return null;
	}
	const size = Number(meta.size);
	const sizeOk = Number.isInteger(size) && size >= 1 && size <= 10 && meta.tiles.length === size * size;
	if (!sizeOk && !repair)
	{
		return null;
	}
	const tiles = [];
	for (const tile of meta.tiles.slice(0, MAX_TILES))
	{
		const goals = tile && typeof tile === 'object' && Array.isArray(tile.goals) ? tile.goals : null;
		const wellFormed = !!goals && goals.length <= MAX_GOALS && goals.every(goal => goal && typeof goal === 'object');
		if (!wellFormed && !repair)
		{
			return null;
		}
		tiles.push({
			label: labelText(tile && tile.label, 'Tile ' + (tiles.length + 1)),
			mode: tile && tile.mode === 'ANY' ? 'ANY' : 'ALL',
			goals: (goals || []).filter(goal => goal && typeof goal === 'object').slice(0, MAX_GOALS).map(goal => ({
				label: labelText(goal.label, ''),
				target: Math.max(0, Number(goal.target) || 0),
				distinct: !!goal.distinct,
				manual: !!goal.manual
			}))
		});
	}
	return {
		name: labelText(meta.name, ''),
		size: sizeOk ? size : Math.max(1, Math.round(Math.sqrt(tiles.length))),
		diagonals: meta.diagonals !== false,
		linePoints: Math.max(0, Number(meta.linePoints) || 0),
		blackoutPoints: Math.max(0, Number(meta.blackoutPoints) || 0),
		tiles
	};
}

function labelText(value, fallback)
{
	return value == null || value === '' ? fallback : String(value).slice(0, MAX_LABEL);
}

/** One tile of a member's own progress, cut to what the plugin sends, or null. */
function cleanTileProgress(entry, goalCap)
{
	if (!entry || typeof entry !== 'object')
	{
		return null;
	}
	return {
		goals: Array.isArray(entry.goals) ? entry.goals.slice(0, goalCap).map(cleanGoalProgress) : [],
		manual: entry.manual === true,
		ts: Number(entry.ts) || 0
	};
}

/** A goal's counter, distinct names and item breakdown, each capped. */
function cleanGoalProgress(goal)
{
	goal = goal && typeof goal === 'object' ? goal : {};
	const out = { n: finiteNumber(goal.n) };
	if (Array.isArray(goal.matched) && goal.matched.length)
	{
		out.matched = goal.matched.slice(0, MAX_MATCHED).map(name => String(name).slice(0, MAX_LABEL));
	}
	if (goal.got && typeof goal.got === 'object' && !Array.isArray(goal.got))
	{
		out.got = {};
		for (const name of Object.keys(goal.got).slice(0, MAX_GOT))
		{
			out.got[name.slice(0, MAX_LABEL)] = finiteNumber(goal.got[name]);
		}
	}
	return out;
}

function finiteNumber(value)
{
	const n = Number(value);
	return isFinite(n) ? n : 0;
}

// The label rules below mirror BingoGoal.describe() and shortDescribe() in the plugin.
const MAX_GOAL_LABEL = 46;

function goalShortLabel(goal, type)
{
	if (goal.name && String(goal.name).trim())
	{
		return String(goal.name).trim();
	}
	const full = goalDescribe(goal, type);
	if (full.length <= MAX_GOAL_LABEL)
	{
		return full;
	}
	const npcs = goal.npcs || [];
	const pets = goal.pets || [];
	switch (type)
	{
		case 'DROP':
			return (goal.distinct ? 'Distinct ' + dropNoun(goal).toLowerCase() : dropNoun(goal)) + fromSources(goal);
		case 'RAID_PURPLE':
			return 'Raid purples (' + raidList(goal) + ')';
		case 'KC':
		case 'KILL':
			return npcs.length === 1 ? 'Kills: ' + prettyGlob(npcs[0]) : 'Kills (' + npcs.length + ' targets)';
		case 'PET':
			return !pets.length ? 'Any pet' : pets.length === 1 ? 'Pet: ' + prettyGlob(pets[0]) : 'Pets (' + pets.length + ')';
		case 'XP':
			return skillName(goal.skill) + ' XP';
		case 'LAP':
			return courseName(goal.course) + ' laps';
		case 'VALUE':
			return 'Big drop' + fromSources(goal);
		case 'CHAT':
			return 'Game message';
		default:
			return 'Manual tile';
	}
}

function goalDescribe(goal, type)
{
	const sources = goal.sources || [];
	switch (type)
	{
		case 'DROP':
		{
			let matched = prettyJoin(goal.items);
			if (!matched && goal.itemIds && goal.itemIds.length)
			{
				matched = goal.itemIds.length === 1 ? 'item ' + goal.itemIds[0] : goal.itemIds.length + ' item ids';
			}
			return (goal.distinct ? 'Distinct ' + dropNoun(goal).toLowerCase() : dropNoun(goal)) + ': ' + matched
				+ (sources.length ? ' from ' + prettyJoin(sources) : '');
		}
		case 'RAID_PURPLE':
			return 'Raid purples (' + raidList(goal) + ')';
		case 'KC':
		case 'KILL':
			return 'Kills: ' + prettyJoin(goal.npcs);
		case 'PET':
			return goal.pets && goal.pets.length ? 'Pets: ' + prettyJoin(goal.pets) : 'Any pet';
		case 'XP':
			return withCommas(Number(goal.amount) || 0) + ' ' + skillName(goal.skill) + ' XP';
		case 'LAP':
			return courseName(goal.course) + ' course laps';
		case 'VALUE':
			return 'Drop worth ' + withCommas(Number(goal.amount) || 0) + '+ gp' + (sources.length ? ' from ' + prettyJoin(sources) : '');
		case 'CHAT':
			return readablePattern(String(goal.pattern || '')) || 'Game message';
		default:
			return 'Manual (request admin credit)';
	}
}

function dropNoun(goal)
{
	const loot = sigList(goal.loot);
	return loot === 'pickpocket' ? 'Pickpocket loot' : loot === 'kill' ? 'Kill drops' : 'Drops';
}

function fromSources(goal)
{
	const sources = goal.sources || [];
	if (!sources.length)
	{
		return '';
	}
	return sources.length === 1 ? ' from ' + prettyGlob(sources[0]) : ' from ' + sources.length + ' sources';
}

function raidList(goal)
{
	const all = ['COX', 'TOB', 'TOA'];
	const raids = (goal.raids || []).map(r => String(r).toUpperCase());
	const wanted = all.filter(r => raids.indexOf(r) >= 0);
	return (wanted.length ? wanted : all).join(', ');
}

/** The plugin's course display names, keyed the way it resolves them (BingoCourse). */
const COURSE_NAMES = {
	gnome: 'Gnome Stronghold', gnomestronghold: 'Gnome Stronghold',
	shayzienbasic: 'Shayzien Basic', draynor: 'Draynor Village', draynorvillage: 'Draynor Village',
	alkharid: 'Al Kharid', pyramid: 'Agility Pyramid', agilitypyramid: 'Agility Pyramid',
	varrock: 'Varrock', penguin: 'Penguin', barbarian: 'Barbarian Outpost',
	barbarianoutpost: 'Barbarian Outpost', canifis: 'Canifis', apeatoll: 'Ape Atoll',
	shayzienadvanced: 'Shayzien Advanced', falador: 'Falador', wilderness: 'Wilderness',
	werewolf: 'Werewolf', seers: "Seers' Village", seersvillage: "Seers' Village",
	pollnivneach: 'Pollnivneach', rellekka: 'Rellekka', relleka: 'Rellekka',
	prifddinas: 'Prifddinas', prif: 'Prifddinas', ardougne: 'Ardougne'
};

function courseName(course)
{
	return COURSE_NAMES[String(course || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || String(course || 'Agility');
}

/** "HITPOINTS" -> "Hitpoints", matching RuneLite's skill display names. */
function skillName(skill)
{
	const raw = String(skill || '').trim();
	return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'Skill';
}

function prettyGlob(glob)
{
	return String(glob == null ? '' : glob).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim();
}

function prettyJoin(values)
{
	return (values || []).map(prettyGlob).filter(Boolean).join(', ');
}

function withCommas(n)
{
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The literal words of a regex, so "Corrupted challenge duration: [0-6]:..." reads. */
function readablePattern(regex)
{
	const literals = regex.split(/\[[^\]]*\][*+?]?|\([^)]*\)[*+?]?|\\[a-zA-Z]|\{\d+(?:,\d+)?\}|[.*+?^$|]/)
		.map(part => part.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').replace(/^[\s:;,\-]+|[\s:;,\-]+$/g, ''))
		.filter(part => part.length >= 4);
	return literals.length ? literals.join(' ... ') : null;
}

/** What a tile TRACKS (types and matchers, not targets or labels); the plugin's twin. */
function tileTrackingSignature(tile)
{
	const goals = tile && tile.goals && tile.goals.length ? tile.goals : [{ type: 'MANUAL' }];
	return goals.map(goal =>
	{
		goal = goal || {};
		return [
			String(goal.type || '').toUpperCase(),
			sigList(goal.items), sigList(goal.itemIds), sigList(goal.sources),
			sigList(goal.loot), goal.distinct ? 'distinct' : '',
			sigList(goal.raids), sigList(goal.npcs), sigList(goal.pets),
			String(goal.skill || '').toUpperCase(), String(goal.course || '').toUpperCase(),
			String(goal.pattern || ''), sigList(goal.regions)
		].join('|');
	}).join(';');
}

/** Sorted, so reordering a list (same meaning) never looks like a different goal. */
function sigList(values)
{
	if (!values || !values.length)
	{
		return '';
	}
	return values.map(v => String(v == null ? '' : v).trim().toLowerCase()).filter(Boolean).sort().join(',');
}
