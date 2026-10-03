// Turns the store's tabs into the structured data the portal and admin pages draw from:
// tile and goal names instead of row and column numbers, contributors per goal, requests
// with their proof links split out, and (for admins) the credit ledger and settings.

const REQUEST_COLUMNS = 12;

/** The pasted board code, parsed, or null. Used for tile icons, descriptions and points. */
function officialBoard(store)
{
	const code = store.readBoardCode();
	if (!code)
	{
		return null;
	}
	try
	{
		const parsed = JSON.parse(code);
		return parsed && Array.isArray(parsed.tiles) ? parsed : null;
	}
	catch (err)
	{
		return null;
	}
}

function tab(spreadsheet, name)
{
	const sheet = spreadsheet.getSheetByName(name);
	return sheet ? sheet.data : [];
}

function cell(row, index)
{
	const value = row && row[index];
	return value == null ? '' : String(value);
}

function splitLinks(text)
{
	return String(text || '').split(/\s+/).filter(link => /^https?:\/\/\S+$/i.test(link)).slice(0, 5);
}

/**
 * Everything the portal shows. Admin data adds the ledger, settings and raw team rows.
 */
export function eventData(store, spreadsheet, admin)
{
	const teams = store.readTeamRows();
	const official = officialBoard(store);
	const scores = store.readScores();
	const event = { name: null, size: 0, diagonals: true, linePoints: 0, blackoutPoints: 0 };
	const out = { event, teams: [], requests: [], updated: new Date().toISOString() };
	let memberLists = null;
	const metaByTeam = {};

	for (const team of teams)
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
			memberLists = store.teamsWithMembers(at < 0 ? '' : scope.board.substring(0, at));
		}
		const listed = memberLists.find(t => t.code === team.code);
		entry.members = listed && listed.members ? listed.members : [];
		const standing = store.standingsFor(scope.board, scores).find(s => s.team === team.code);
		entry.points = standing ? standing.points : null;

		const totals = store.tileTotals(scope.board, meta);
		const sameBoard = official && official.tiles.length === meta.tiles.length ? official : null;
		entry.board = {
			key: scope.board,
			size,
			done: totals.done.filter(Boolean).length,
			lines: store.linesInDone(meta, totals.done),
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
					goals: (tile.goals || []).map((goal, g) => ({
						label: String(goal.label || (goal.manual ? 'Manual tick' : 'Goal ' + (g + 1))),
						target: Number(goal.target || 0),
						manual: !!goal.manual,
						total: (totals.tracked[t][g] || 0) + (totals.verified[t][g] || 0),
						verified: totals.verified[t][g] || 0,
						contributors: Object.entries(totals.contrib[t][g] || {})
							.map(([name, amount]) => ({ name, amount }))
							.sort((a, b) => b.amount - a.amount)
					}))
				};
			})
		};
	}

	const requests = tab(spreadsheet, 'Requests');
	for (let i = 1; i < requests.length; i++)
	{
		const row = requests[i] || [];
		if (!cell(row, 2).trim())
		{
			continue;
		}
		const team = cell(row, 1).trim().toLowerCase();
		const tileNumber = parseInt(row[3], 10);
		const goalNumber = parseInt(row[4], 10);
		const meta = metaByTeam[team];
		const tileMeta = meta && meta.tiles[tileNumber - 1];
		const status = cell(row, 9).trim();
		out.requests.push({
			id: cell(row, 11) || '#' + (i + 1),
			when: cell(row, 0),
			team,
			player: cell(row, 2),
			tile: isNaN(tileNumber) ? null : tileNumber,
			tileLabel: tileMeta ? String(tileMeta.label) : cell(row, 3).replace(/^\d+\s*-\s*/, ''),
			goal: isNaN(goalNumber) ? null : goalNumber,
			goalLabel: tileMeta && !isNaN(goalNumber) && tileMeta.goals[goalNumber - 1]
				? String(tileMeta.goals[goalNumber - 1].label) : null,
			add: row[5] === '' || row[5] == null ? null : Number(row[5]),
			complete: !!cell(row, 6).trim(),
			note: cell(row, 7),
			links: splitLinks(row[10]),
			status: status === 'Done' || status === 'Rejected' ? status : 'Pending'
		});
	}
	out.requests.reverse(); // newest first

	if (!admin)
	{
		return out;
	}

	const ledger = tab(spreadsheet, 'Adjustments');
	out.adjustments = [];
	for (let i = 1; i < ledger.length; i++)
	{
		const row = ledger[i] || [];
		const team = cell(row, 0).trim().toLowerCase();
		const meta = metaByTeam[team] || Object.values(metaByTeam)[0] || null;
		const parsed = store.parseAdjustmentRow(row, meta);
		if (parsed.issues.length === 1 && parsed.issues[0] === '')
		{
			continue; // an empty row
		}
		const tileMeta = meta && meta.tiles[parsed.tile - 1];
		// Approvals are written as "request <id>: <the player's note>".
		const tagged = cell(row, 6).match(/^request (\S+?): ?([\s\S]*)$/);
		out.adjustments.push({
			row: i + 1,
			fingerprint: JSON.stringify(row),
			team,
			tile: isNaN(parsed.tile) ? null : parsed.tile,
			tileLabel: tileMeta ? String(tileMeta.label) : cell(row, 1),
			goal: parsed.goal,
			goalLabel: tileMeta && tileMeta.goals[parsed.goal - 1] ? String(tileMeta.goals[parsed.goal - 1].label) : null,
			player: parsed.player,
			add: parsed.add,
			complete: parsed.complete,
			note: tagged ? tagged[2] : cell(row, 6),
			fromRequest: tagged ? tagged[1] : null,
			by: cell(row, 7),
			added: cell(row, 8),
			issues: parsed.issues.filter(Boolean)
		});
	}
	out.adjustments.reverse();

	out.teamRows = tab(spreadsheet, 'Teams').slice(1)
		.filter(row => cell(row, 0).trim())
		.map(row => ({ code: cell(row, 0), name: cell(row, 1), webhook: cell(row, 2) }));
	out.settings = { pollSeconds: store.readPollInterval() || 120 };
	const code = store.readBoardCode();
	out.boardCode = { text: code, summary: summarizeBoard(code) };
	return out;
}

/** What the admin page shows beside the board code: name, id, size, or what is wrong. */
export function summarizeBoard(code)
{
	if (!code)
	{
		return { ok: false, message: 'No board code pasted yet.' };
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

export { REQUEST_COLUMNS };
