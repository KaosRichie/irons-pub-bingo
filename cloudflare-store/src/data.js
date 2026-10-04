// Turns the event's records into the data the portal and admin pages draw from: tile and
// goal names, contributors per goal, requests with their labels, and (for admins) the
// credit ledger, the raw team list and the settings.
import { linesInDone, parseCredit } from './store.js';

/**
 * Everything the portal shows. Admin data adds the ledger, settings and raw team rows.
 */
export function eventData(store, admin)
{
	const official = store.officialBoard();
	const event = { name: null, size: 0, diagonals: true, linePoints: 0, blackoutPoints: 0 };
	const out = { event, teams: [], requests: [], updated: new Date().toISOString() };
	let memberLists = null;
	const metaByTeam = {};

	for (const team of store.teamList())
	{
		const scope = store.latestBoardForTeam(team.code);
		const entry = { code: team.code, name: team.name || team.code, members: [], points: null, board: null };
		out.teams.push(entry);
		if (!scope)
		{
			continue;
		}
		const meta = scope.meta;
		metaByTeam[team.code] = meta;
		const size = meta.size || Math.round(Math.sqrt(meta.tiles.length));
		if (!event.name)
		{
			event.name = meta.name || 'Bingo board';
			event.size = size;
			event.diagonals = meta.diagonals !== false;
			event.linePoints = Number(meta.linePoints) || 0;
			event.blackoutPoints = Number(meta.blackoutPoints) || 0;
		}
		if (!memberLists)
		{
			const at = scope.board.lastIndexOf('_');
			memberLists = store.teamsWithMembers(at < 0 ? '' : scope.board.slice(0, at));
		}
		const listed = memberLists.find(t => t.code === team.code);
		entry.members = listed ? listed.members : [];
		const standing = store.standingsFor(scope.board).find(s => s.team === team.code);
		entry.points = standing ? standing.points : null;

		const totals = store.tileTotals(scope.board, meta);
		const frozen = store.frozenFor(scope.board);
		const names = memberNames(store, scope.board);
		const sameBoard = official && official.tiles.length === meta.tiles.length ? official : null;
		entry.board = {
			key: scope.board,
			size,
			done: totals.done.filter(Boolean).length,
			lines: linesInDone(meta, totals.done),
			tiles: meta.tiles.map((tile, t) =>
			{
				const source = sameBoard ? sameBoard.tiles[t] || {} : {};
				return {
					label: String(tile.label || 'Tile ' + (t + 1)),
					mode: tile.mode === 'ANY' ? 'ANY' : 'ALL',
					done: !!totals.done[t],
					verifiedComplete: !!totals.verifiedManual[t],
					tickedBy: Object.keys(totals.manualBy[t] || {}),
					icon: source.icon == null ? null : String(source.icon),
					description: source.description ? String(source.description) : null,
					points: source.points == null ? null : Number(source.points),
					goals: (tile.goals || []).map((goal, g) => Object.assign({
						label: String(goal.label || (goal.manual ? 'Manual tick' : 'Goal ' + (g + 1))),
						target: Number(goal.target || 0),
						manual: !!goal.manual,
						total: (totals.tracked[t][g] || 0) + (totals.verified[t][g] || 0),
						verified: totals.verified[t][g] || 0,
						contributors: Object.entries(totals.contrib[t][g] || {})
							.map(([name, amount]) => ({ name, amount }))
							.sort((a, b) => b.amount - a.amount)
					}, frozen[t] ? frozenGoal(frozen[t], g, goal, names) : {}))
				};
			})
		};
	}

	for (const request of store.requests.values())
	{
		const tileMeta = metaByTeam[request.team] && metaByTeam[request.team].tiles[request.tile - 1];
		out.requests.push({
			id: request.id,
			when: request.when,
			team: request.team,
			player: request.player,
			tile: request.tile,
			tileLabel: tileMeta ? String(tileMeta.label) : 'Tile ' + request.tile,
			goal: request.goal,
			goalLabel: tileMeta && request.goal && tileMeta.goals[request.goal - 1]
				? String(tileMeta.goals[request.goal - 1].label) : null,
			add: request.add,
			complete: request.complete,
			note: request.note,
			links: request.links || [],
			status: request.status
		});
	}
	out.requests.reverse(); // newest first

	if (!admin)
	{
		return out;
	}

	out.adjustments = [];
	for (const credit of store.credits.values())
	{
		const meta = metaByTeam[credit.team] || Object.values(metaByTeam)[0] || null;
		const parsed = parseCredit(credit, meta);
		const tileMeta = meta && meta.tiles[parsed.tile - 1];
		out.adjustments.push({
			id: credit.id,
			team: parsed.team,
			tile: isNaN(parsed.tile) ? null : parsed.tile,
			tileLabel: tileMeta ? String(tileMeta.label) : 'Tile ' + credit.tile,
			goal: parsed.goal,
			goalLabel: tileMeta && tileMeta.goals[parsed.goal - 1] ? String(tileMeta.goals[parsed.goal - 1].label) : null,
			player: parsed.player,
			add: parsed.add,
			complete: parsed.complete,
			note: credit.note,
			fromRequest: credit.request,
			by: credit.by,
			added: credit.added,
			issues: parsed.issues
		});
	}
	out.adjustments.reverse();

	out.teamRows = store.config.teams.map(t => ({ code: t.code, name: t.name, webhook: t.webhook }));
	out.settings = { pollSeconds: store.config.pollSeconds || 120 };
	out.boardCode = { text: store.config.boardCode, summary: summarizeBoard(store.config.boardCode) };
	return out;
}

/** Member id -> display name for a team scope, admin credit included. */
function memberNames(store, board)
{
	const names = {};
	for (const row of store.members.values())
	{
		if (row.board === board)
		{
			names[row.member] = row.name || row.member;
		}
	}
	for (const credit of store.credits.values())
	{
		names['admin:' + String(credit.player || '').trim().toLowerCase()] = String(credit.player || '').trim() + ' (verified)';
	}
	return names;
}

/** A completed goal's frozen total, credit and contributors, as the plugin shows them. */
function frozenGoal(frozenTile, g, goal, names)
{
	let total = 0;
	let verified = 0;
	const distinct = new Set();
	const contributors = [];
	for (const [id, state] of Object.entries(frozenTile))
	{
		const entry = (state.goals || [])[g] || {};
		const matched = goal.distinct && entry.matched ? entry.matched : [];
		matched.forEach(name => distinct.add(String(name).toLowerCase()));
		const amount = Number(entry.n || 0) + matched.length;
		total += Number(entry.n || 0);
		if (id.startsWith('admin:'))
		{
			verified += amount;
		}
		if (amount > 0)
		{
			contributors.push({ name: names[id] || id, amount });
		}
	}
	return { total: total + distinct.size, verified, contributors: contributors.sort((a, b) => b.amount - a.amount) };
}

/** What the admin page shows beside the board code: name, id, size, or what is wrong. */
export function summarizeBoard(code)
{
	if (!code)
	{
		return { ok: false, message: 'No board code saved yet.' };
	}
	let parsed;
	try
	{
		parsed = JSON.parse(code);
	}
	catch (err)
	{
		return { ok: false, message: 'This is not a valid board code: ' + err.message };
	}
	if (!parsed || !Array.isArray(parsed.tiles))
	{
		return { ok: false, message: 'This JSON has no tiles. Export the code from Bingo Forge.' };
	}
	const size = Number(parsed.size) || 0;
	if (size && parsed.tiles.length !== size * size)
	{
		return { ok: false, message: 'A ' + size + 'x' + size + ' board needs ' + size * size
			+ ' tiles, this code has ' + parsed.tiles.length + '.' };
	}
	return {
		ok: true,
		name: parsed.name || 'Unnamed board',
		id: parsed.id == null ? null : String(parsed.id),
		version: parsed.version == null ? null : Number(parsed.version),
		size: size || Math.round(Math.sqrt(parsed.tiles.length)),
		tiles: parsed.tiles.length
	};
}
