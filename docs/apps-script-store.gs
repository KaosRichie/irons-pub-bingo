/**
 * Irons Pub Bingo team store — free, clan-owned backend for the Irons Pub Bingo RuneLite plugin.
 *
 * What it does:
 *  1. Stores each player's bingo progress so teammates who are never online at the
 *     same time still see each other's progress. The plugin POSTs everything a client
 *     knows and gets the merged team state back in the same call.
 *  2. Lets admins credit progress by hand on the "Adjustments" tab — for players who
 *     cannot run the plugin (mobile) and send screenshots instead. Those credits sync
 *     back into everyone's plugin like any other contribution.
 *
 * ONE sheet runs the WHOLE event: every team shares it, kept apart by team code, and the
 * host plus their admins work from it together.
 *
 * Setup (bingo host, ~10 minutes):
 *  1. Go to https://sheets.new and create a blank spreadsheet (this is your store + audit log).
 *  2. Extensions -> Apps Script. Delete the sample code, paste this whole file, save.
 *  3. Deploy -> New deployment -> type "Web app".
 *       Execute as: Me
 *       Who has access: Anyone
 *     Click Deploy and authorize when asked.
 *  4. Copy the Web app URL (ends in /exec) and share it with everyone in the event. They
 *     paste it into RuneLite -> Irons Pub Bingo settings -> "Team store URL" and enable
 *     "Use team store".
 *  5. Reload the spreadsheet once: a "Irons Pub Bingo" menu appears. Paste the same /exec URL
 *     into the Settings tab's "Portal URL" row so the menu's "Open player portal" works.
 *
 * When deploying you'll see "Google hasn't verified this app" — expected for any personal
 * Apps Script, since the unverified "app" is this very script on your own account. Click
 * Advanced -> "Go to ... (unsafe)" -> Allow. Only the deployer sees this, once; players
 * never authorize anything, they only use the URL.
 *
 * IMPORTANT: after editing this script, redeploy with
 * Deploy -> Manage deployments -> (pencil) -> Version: New version -> Deploy.
 * Saving alone keeps serving the old code.
 *
 * Sharing: NEVER share this spreadsheet with the clan - players talk to the web app URL
 * only, which runs as your account and needs no sheet access. Share the spreadsheet with
 * your admins (editors) and nobody else.
 *
 * Tabs (created automatically; Store/Meta/Removed start hidden - View -> Hidden sheets):
 *  - Adjustments : admin credit, typed by hand. This is the only tab you routinely edit.
 *  - Requests    : credit requests from players - via the plugin, or via the /exec URL
 *                  opened in a browser: a player portal showing the live board, the
 *                  team's requests and their status, and a request form (proof =
 *                  screenshot links, e.g. Discord/Imgur). Select row(s) and use
 *                  Irons Pub Bingo -> Approve/Deny; approving writes the Adjustments row
 *                  for you and stamps the request's Status column.
 *  - Teams       : optional allow-list of team codes (Code + display Name). While it has
 *                  rows, syncs with any other code are rejected, and the plugin's
 *                  "Choose team" button offers exactly this list. Empty = any code works.
 *  - Board code  : paste the board code (JSON) here and players can load the board via
 *                  the plugin's Setup -> "Get board from store" - no code sharing needed.
 *                  Manual Import board keeps working for everyone regardless.
 *  - Settings    : host knobs. "Push throttle (seconds)" slows how often each client
 *                  pushes to this store (for big events on one deployment); the plugin
 *                  enforces its own minimum and cap, and blank means default.
 *  - Removed     : evicted members per board scope. Rows with reason "left" are written
 *                  automatically when a player switches teams and clear themselves if
 *                  that player rejoins. Add a row by hand (reason blank) to evict someone
 *                  permanently - delete it to let them back.
 *  - Board <team>: generated read-only view of the board and its progress, one tab
 *                  per team (plain "Board" for players without a team code).
 *  - Store       : raw per-player data from the plugin. Leave alone.
 *  - Meta        : board definitions sent by the plugin. Leave alone.
 */

/**
 * @OnlyCurrentDoc
 * Limits the requested permission to this script's own spreadsheet only,
 * instead of access to all spreadsheets on the account.
 */

var STORE_SHEET = 'Store';
var ADJ_SHEET = 'Adjustments';
var BOARD_SHEET = 'Board';
var META_SHEET = 'Meta';
var TEAMS_SHEET = 'Teams';
var REMOVED_SHEET = 'Removed';
var SETTINGS_SHEET = 'Settings';
var SETTINGS_HEADERS = ['Setting', 'Value'];
var BOARD_CODE_SHEET = 'Board code';
var SCORES_SHEET = 'Scores';
var SCORES_HEADERS = ['board', 'points', 'updated'];

var ADJ_HEADERS = ['Team', 'Tile', 'Goal', 'Player', 'Add (+/-)', 'Complete', 'Note',
	'Verified by', 'Added', '-> Tile label', '-> Running total', '-> Issues'];
var STORE_HEADERS = ['board', 'member', 'name', 'updated', 'data'];
var META_HEADERS = ['board', 'updated', 'meta'];
var TEAMS_HEADERS = ['Code', 'Name'];
var REMOVED_HEADERS = ['board', 'member', 'when', 'reason'];
var REQUESTS_SHEET = 'Requests';
var REQUESTS_HEADERS = ['When', 'Team', 'Player', 'Tile', 'Goal', 'Add', 'Complete', 'Note',
	'Member', 'Status', 'Proof links'];
var REQUEST_STATUSES = ['Pending', 'Done', 'Rejected'];
var STATUS_COLORS = { Pending: '#fff2cc', Done: '#d9ead3', Rejected: '#f4cccc' };
// Machine-written tabs stay hidden so the admin view is just the tabs humans use
// (unhide anytime via View -> Hidden sheets; hiding is tidiness, not security - the
// spreadsheet itself should only ever be shared with admins).
var HIDDEN_SHEETS = [STORE_SHEET, META_SHEET, REMOVED_SHEET, SCORES_SHEET];

var REFRESH_THROTTLE_MS = 60000;

// ---------------------------------------------------------------- web endpoints

function doPost(e)
{
	var lock = LockService.getScriptLock();
	lock.waitLock(20000);
	try
	{
		var body = JSON.parse(e.postData.contents);
		if (body.teamsOnly)
		{
			// The plugin's "Choose team" picker: just the host-defined team list.
			return ContentService.createTextOutput(JSON.stringify({ teams: readTeamRows() }))
				.setMimeType(ContentService.MimeType.JSON);
		}
		if (body.fetchBoard)
		{
			// The plugin's "Get board from store": the board code the host pasted onto
			// the Board code tab. Manual Import board keeps working regardless.
			return fetchBoardResponse();
		}
		var board = String(body.board || '');
		var members = body.members || {};

		if (body.remove && body.remove.length)
		{
			// A player who left this team scope: delete their row and tombstone the id,
			// so teammates' cached copies can't push it back (see the Removed tab).
			// Processed before the team allow-list so leaving a since-delisted team
			// still cleans up.
			removeMembers(board, body.remove);
		}

		// When the host lists teams on the Teams tab, only those codes are accepted -
		// a typo'd or made-up code must not spawn new board tabs and store rows.
		var teams = readTeamRows();
		if (teams.length && !hasTeam(teams, teamOf(board)))
		{
			var reason = teamOf(board) === 'solo'
				? 'This store requires a team code - use Choose team or ask your host'
				: 'Unknown team code - use Choose team or ask your host for the right one';
			return ContentService.createTextOutput(JSON.stringify(
				{ board: board, error: reason, teams: teams }))
				.setMimeType(ContentService.MimeType.JSON);
		}

		// Board tampering guard: when the host pasted the official board code, clients
		// must be running exactly that board - a locally edited copy (easier goals,
		// same board id) is rejected outright. A modified CLIENT can still lie about
		// numbers, but this closes the no-code cheat of editing the board JSON.
		var canonicalCode = readBoardCode();
		var canonicalHash = canonicalCode ? sha256Hex(canonicalCode) : null;
		if (canonicalHash && body.boardHash && String(body.boardHash) !== canonicalHash)
		{
			return ContentService.createTextOutput(JSON.stringify({ board: board,
				error: 'Your board differs from the host\'s official board - use '
					+ 'Import board -> Import from store to get it.' }))
				.setMimeType(ContentService.MimeType.JSON);
		}
		var boardVerified = !canonicalHash || String(body.boardHash || '') === canonicalHash;

		if (body.rejoin && /^[0-9a-f]{16}$/.test(String(body.rejoin)))
		{
			// A member syncing here by choice clears any "left" tombstone they carry in
			// this scope, so switching back to a team you left heals itself. Hand-added
			// tombstones (no "left" reason) are admin evictions and stay.
			clearLeftTombstones(board, String(body.rejoin));
			// ...and their arrival moves their row: one team per board per member.
			moveMemberIfElsewhere(board, String(body.rejoin));
		}

		if (body.request)
		{
			// A member asking an admin to credit something the tracker missed - lands on
			// the Requests tab for review (Irons Pub Bingo menu -> approve/deny).
			recordRequest(board, body.request, false);
		}

		if (typeof body.teamPoints === 'number' && body.teamPoints >= 0)
		{
			// The team's self-computed total, for the cross-team standings.
			upsertScore(board, Math.floor(body.teamPoints));
		}

		if (body.meta && boardVerified)
		{
			// Clients that can't prove they run the official board (pre-fingerprint
			// versions) may sync, but must not write the labels admins read.
			saveMeta(board, body.meta);
		}

		var sheet = getSheet(STORE_SHEET, STORE_HEADERS);
		var rows = readRows(sheet);
		var removed = removedFor(board);

		// One team per board per member: a member's tracked data lives where THEIR OWN
		// client syncs (the rejoin id above moves it). A relayed copy can never create
		// a member inside a different team's scope.
		var prefix = boardPrefix(board);
		var ownedElsewhere = {};
		if (prefix)
		{
			for (var rk in rows)
			{
				if (rows[rk].board !== board && rows[rk].board.indexOf(prefix) === 0)
				{
					ownedElsewhere[rows[rk].member] = true;
				}
			}
		}

		for (var memberId in members)
		{
			// Member keys are 16-hex derived account ids. Anything else - notably the
			// "admin:" members this script generates - is never accepted from a client,
			// so a leaked URL cannot forge verified credit and echoes cannot loop.
			if (!/^[0-9a-f]{16}$/.test(memberId) || removed[memberId] || ownedElsewhere[memberId])
			{
				continue;
			}
			var incoming = members[memberId] || {};
			var key = board + '|' + memberId;
			var row = rows[key];
			var current = row ? parseJson(row.data, {}) : {};

			// Last-write-wins per tile, by the owning player's own timestamp.
			var incomingTiles = incoming.tiles || {};
			var changed = false;
			for (var tile in incomingTiles)
			{
				var inc = incomingTiles[tile];
				var cur = current[tile];
				if (inc && (!cur || (inc.ts || 0) > (cur.ts || 0)))
				{
					current[tile] = inc;
					changed = true;
				}
			}
			var name = incoming.name || (row ? row.name : '');
			if (!row || changed || name !== row.name)
			{
				writeStoreRow(sheet, rows, key, board, memberId, name, current);
			}
		}

		var response = respond(board, readRows(sheet));
		maybeRefreshViews(board, false);
		return response;
	}
	finally
	{
		lock.releaseLock();
	}
}

function doGet(e)
{
	var board = String((e && e.parameter && e.parameter.board) || '');
	if (board)
	{
		return respond(board, readRows(getSheet(STORE_SHEET, STORE_HEADERS)));
	}
	// The same URL players' plugins sync with doubles as the player portal for anyone
	// WITHOUT the plugin (mobile players): board state, their requests, and a form to
	// file new ones with proof links. Nobody needs access to the spreadsheet itself.
	return portalPage();
}

// ---------------------------------------------------------------- player portal

/**
 * The read-only player portal + credit-request form, served to browsers hitting the
 * /exec URL. Shows the live board state (grid, per-goal progress, who contributed) and
 * the team's credit requests with their status, so nobody needs the plugin - or any
 * access to this spreadsheet - to follow the event. Data is inlined at page load;
 * reloading refreshes it.
 */
function portalPage()
{
	var boards = {};
	var metaValues = getSheet(META_SHEET, META_HEADERS).getDataRange().getValues();
	var requestValues = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS).getDataRange().getValues();
	for (var i = 1; i < metaValues.length; i++)
	{
		var key = String(metaValues[i][0]);
		var meta = parseJson(metaValues[i][2], null);
		if (!key || !meta || !meta.tiles)
		{
			continue;
		}
		var team = teamOf(key);
		var totals = tileTotals(key, meta);
		var tiles = [];
		for (var t = 0; t < meta.tiles.length; t++)
		{
			var goals = [];
			var metaGoals = meta.tiles[t].goals || [];
			for (var g = 0; g < metaGoals.length; g++)
			{
				goals.push({
					label: String(metaGoals[g].label || ('Goal ' + (g + 1))),
					target: Number(metaGoals[g].target || 0),
					total: totals.tracked[t][g] + totals.verified[t][g],
					by: formatContrib(totals.contrib[t][g])
				});
			}
			tiles.push({
				label: String(meta.tiles[t].label || ('Tile ' + (t + 1))),
				done: !!totals.done[t],
				goals: goals
			});
		}
		var requests = [];
		for (var r = 1; r < requestValues.length; r++)
		{
			if (String(requestValues[r][1]) === team && String(requestValues[r][2] || '').trim())
			{
				var status = String(requestValues[r][9] || '').trim();
				// Legacy statuses from before the dropdown existed.
				status = status === 'approved' ? 'Done' : status === 'denied' ? 'Rejected'
					: isPending(status) ? 'Pending' : status;
				requests.push({
					when: String(requestValues[r][0]).slice(0, 10),
					player: String(requestValues[r][2]),
					tile: String(requestValues[r][3]),
					what: (requestValues[r][6] ? 'complete' : '+' + requestValues[r][5]),
					status: status
				});
			}
		}
		boards[key] = {
			name: String(meta.name || 'Bingo board'),
			team: team,
			size: Number(meta.size) || Math.round(Math.sqrt(meta.tiles.length)),
			tiles: tiles,
			requests: requests
		};
	}
	// <-escape so board/tile labels can never break out of the script tag; the page
	// itself only ever renders data through textContent.
	var data = JSON.stringify(boards).replace(/</g, '\\u003c');
	var html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">'
		+ '<title>Irons Pub Bingo</title><style>'
		+ 'body{font-family:sans-serif;background:#282828;color:#ddd;max-width:560px;margin:0 auto;padding:16px}'
		+ 'label{display:block;margin-top:12px;font-size:14px}'
		+ 'input,select,button{width:100%;box-sizing:border-box;padding:8px;margin-top:4px;'
		+ 'background:#1e1e1e;color:#ddd;border:1px solid #555;border-radius:4px;font-size:15px}'
		+ 'input[type=checkbox]{width:auto} .check{display:flex;gap:8px;align-items:center}'
		+ 'button{background:#7a5c00;border:0;font-weight:bold;margin-top:16px;cursor:pointer}'
		+ 'button:disabled{opacity:.5} #msg{margin-top:12px;font-size:14px} .ok{color:#7ac86c} .bad{color:#e06c55}'
		+ 'h2{margin-bottom:4px} h3{margin:20px 0 6px} p{font-size:13px;color:#aaa;margin-top:0}'
		+ '#grid{display:grid;gap:3px;margin-top:8px}'
		+ '.cell{background:#3a3a3a;border-radius:3px;padding:6px 4px;font-size:11px;min-height:44px;'
		+ 'display:flex;align-items:center;justify-content:center;text-align:center;word-break:break-word}'
		+ '.cell.done{background:#2e5d2e}'
		+ 'table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}'
		+ 'td,th{border-bottom:1px solid #444;padding:4px 6px;text-align:left;vertical-align:top}'
		+ 'th{color:#aaa;font-weight:normal} .st-done{color:#7ac86c} .st-rejected{color:#e06c55} .st-pending{color:#f5b83d}'
		+ '</style></head><body>'
		+ '<h2>Irons Pub Bingo</h2>'
		+ '<p>Live board state and credit requests - reload for the latest. '
		+ 'Requests are reviewed by an admin before they count; link screenshots as proof.</p>'
		+ '<label>Board / team <select id="board"></select></label>'
		+ '<h3>Board</h3><div id="grid"></div>'
		+ '<h3>Goals</h3><table id="goals"><thead><tr><th>Tile</th><th>Goal</th><th>Progress</th><th>By</th></tr></thead><tbody></tbody></table>'
		+ '<h3>Credit requests</h3><table id="reqs"><thead><tr><th>When</th><th>Player</th><th>Tile</th><th>What</th><th>Status</th></tr></thead><tbody></tbody></table>'
		+ '<h3>Request credit</h3>'
		+ '<label>Your player name <input id="player" maxlength="20"></label>'
		+ '<label>Tile <select id="tile"></select></label>'
		+ '<label id="goalwrap" style="display:none">Goal <select id="goal"></select></label>'
		+ '<label>Amount to credit (e.g. 40) <input id="add" type="number"></label>'
		+ '<label class="check"><input type="checkbox" id="complete"> the whole tile is complete</label>'
		+ '<label>Note for the admin <input id="note" maxlength="300" placeholder="e.g. laps 0 to 40"></label>'
		+ '<label>Proof link(s) - screenshots on Discord/Imgur <input id="links" placeholder="https://... https://..."></label>'
		+ '<button id="send">Send request</button><div id="msg"></div>'
		+ '<script>var BOARDS=' + data + ';\n'
		+ 'function el(id){return document.getElementById(id);}\n'
		+ 'var boardSel=el("board"),tileSel=el("tile"),goalSel=el("goal"),goalWrap=el("goalwrap"),'
		+ 'msg=el("msg"),send=el("send");\n'
		+ 'Object.keys(BOARDS).forEach(function(k){var o=document.createElement("option");o.value=k;'
		+ 'o.textContent=BOARDS[k].name+(BOARDS[k].team&&BOARDS[k].team!=="solo"?" - team "+BOARDS[k].team:"");'
		+ 'boardSel.appendChild(o);});\n'
		+ 'function cellText(t,i){return (i+1)+". "+t.label;}\n'
		+ 'function render(){var b=BOARDS[boardSel.value];if(!b)return;'
		+ 'var grid=el("grid");grid.innerHTML="";grid.style.gridTemplateColumns="repeat("+b.size+",1fr)";'
		+ 'b.tiles.forEach(function(t,i){var c=document.createElement("div");'
		+ 'c.className=t.done?"cell done":"cell";c.textContent=cellText(t,i);grid.appendChild(c);});\n'
		+ 'var goals=el("goals").tBodies[0];goals.innerHTML="";'
		+ 'b.tiles.forEach(function(t,i){t.goals.forEach(function(g,gi){var tr=document.createElement("tr");'
		+ '[gi===0?String(i+1):"",g.label,g.target?g.total+" / "+g.target:"",g.by||""]'
		+ '.forEach(function(v){var td=document.createElement("td");td.textContent=v;tr.appendChild(td);});'
		+ 'goals.appendChild(tr);});});\n'
		+ 'var reqs=el("reqs").tBodies[0];reqs.innerHTML="";'
		+ 'b.requests.forEach(function(q){var tr=document.createElement("tr");'
		+ '[q.when,q.player,q.tile,q.what].forEach(function(v){var td=document.createElement("td");'
		+ 'td.textContent=v;tr.appendChild(td);});'
		+ 'var st=document.createElement("td");st.textContent=q.status;st.className="st-"+q.status.toLowerCase();'
		+ 'tr.appendChild(st);reqs.appendChild(tr);});\n'
		+ 'tileSel.innerHTML="";b.tiles.forEach(function(t,i){var o=document.createElement("option");'
		+ 'o.value=i+1;o.textContent=cellText(t,i);tileSel.appendChild(o);});fillGoals();}\n'
		+ 'function fillGoals(){var b=BOARDS[boardSel.value];if(!b)return;'
		+ 'var t=b.tiles[tileSel.selectedIndex]||{goals:[]};goalSel.innerHTML="";'
		+ 't.goals.forEach(function(g,i){var o=document.createElement("option");o.value=i+1;'
		+ 'o.textContent=(i+1)+". "+g.label;goalSel.appendChild(o);});'
		+ 'goalWrap.style.display=t.goals.length>1?"block":"none";}\n'
		+ 'boardSel.onchange=render;tileSel.onchange=fillGoals;render();\n'
		+ 'send.onclick=function(){msg.textContent="Sending...";msg.className="";send.disabled=true;'
		+ 'google.script.run'
		+ '.withSuccessHandler(function(t){msg.className="ok";msg.textContent=t;send.disabled=false;})'
		+ '.withFailureHandler(function(e){msg.className="bad";msg.textContent=e.message||String(e);send.disabled=false;})'
		+ '.submitFormRequest({board:boardSel.value,player:el("player").value,'
		+ 'tile:Number(tileSel.value),goal:goalWrap.style.display==="none"?"":Number(goalSel.value),'
		+ 'add:el("add").value,complete:el("complete").checked,'
		+ 'note:el("note").value,links:el("links").value});};'
		+ '</scr' + 'ipt></body></html>';
	return HtmlService.createHtmlOutput(html).setTitle('Irons Pub Bingo');
}

/** google.script.run target for the browser form. Returns a confirmation, or throws. */
function submitFormRequest(payload)
{
	var lock = LockService.getScriptLock();
	lock.waitLock(20000);
	try
	{
		payload = payload || {};
		var board = String(payload.board || '');
		if (!readMeta(board))
		{
			throw new Error('Pick a board first.');
		}
		var row = recordRequest(board, {
			player: payload.player, tile: payload.tile, goal: payload.goal,
			add: payload.add, complete: payload.complete === true, note: payload.note,
			links: payload.links
		}, true);
		if (!row)
		{
			throw new Error('Fill in your player name, the tile, and an amount (or tick "complete"). '
				+ 'An identical request may also already be waiting.');
		}
		return 'Request sent - an admin will review it.';
	}
	finally
	{
		lock.releaseLock();
	}
}

/** Stored players plus the synthetic "admin:" members built from the Adjustments tab. */
function respond(board, rows)
{
	var members = {};
	var removed = removedFor(board);
	for (var key in rows)
	{
		var row = rows[key];
		// A hand-added Removed row evicts even when the store row wasn't deleted yet.
		if (row.board === board && /^[0-9a-f]{16}$/.test(row.member) && !removed[row.member])
		{
			members[row.member] = { name: row.name, tiles: parseJson(row.data, {}) };
		}
	}
	var credited = buildAdjustmentMembers(board, readMeta(board));
	for (var id in credited)
	{
		members[id] = credited[id];
	}
	return ContentService
		.createTextOutput(JSON.stringify({ board: board, members: members,
			teams: readTeamRows(), removed: Object.keys(removedFor(board)),
			throttle: readPushThrottle(), standings: standingsFor(board) }))
		.setMimeType(ContentService.MimeType.JSON);
}

/** Latest points per team on this board scope's board, best first (Scores tab). */
function upsertScore(board, points)
{
	var sheet = getSheet(SCORES_SHEET, SCORES_HEADERS);
	var values = sheet.getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0]) === board)
		{
			sheet.getRange(i + 1, 2, 1, 2).setValues([[points, new Date().toISOString()]]);
			return;
		}
	}
	var range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, 3);
	range.setNumberFormat('@');
	range.setValues([[board, points, new Date().toISOString()]]);
}

function standingsFor(board)
{
	var at = board.lastIndexOf('_');
	if (at < 0)
	{
		return [];
	}
	var prefix = board.substring(0, at + 1);
	var values = getSheet(SCORES_SHEET, SCORES_HEADERS).getDataRange().getValues();
	var standings = [];
	for (var i = 1; i < values.length; i++)
	{
		var key = String(values[i][0]);
		if (key.indexOf(prefix) === 0)
		{
			standings.push({ team: teamOf(key), points: Number(values[i][1]) || 0 });
		}
	}
	standings.sort(function (a, b)
	{
		return b.points - a.points;
	});
	return standings;
}

// ---------------------------------------------------------------- teams & removals

/** Host-defined teams from the Teams tab, codes normalized like the plugin does. */
function readTeamRows()
{
	var values = getSheet(TEAMS_SHEET, TEAMS_HEADERS).getDataRange().getValues();
	var teams = [];
	for (var i = 1; i < values.length; i++)
	{
		var code = String(values[i][0] || '').trim().toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-').replace(/(^-+|-+$)/g, '');
		if (code)
		{
			teams.push({ code: code, name: String(values[i][1] || '').trim() });
		}
	}
	return teams;
}

function hasTeam(teams, code)
{
	for (var i = 0; i < teams.length; i++)
	{
		if (teams[i].code === code)
		{
			return true;
		}
	}
	return false;
}

/** Member ids evicted from this board scope; their data is never accepted again. */
function removedFor(board)
{
	var values = getSheet(REMOVED_SHEET, REMOVED_HEADERS).getDataRange().getValues();
	var removed = {};
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0]) === board && values[i][1])
		{
			removed[String(values[i][1])] = true;
		}
	}
	return removed;
}

// ---------------------------------------------------------------- credit requests

/**
 * Appends a credit request to the Requests tab. Validated but never trusted: nothing
 * counts until an admin approves it into the Adjustments ledger. Plugin requests carry
 * the sender's member id; browser-form requests are marked "form" (identity is the typed
 * player name, vouched for by the screenshot).
 *
 * @return the appended row number, or 0 when the request was invalid or a duplicate
 */
function recordRequest(board, request, fromForm)
{
	var member = fromForm ? 'form' : String(request.member || '');
	var player = String(request.player || '').trim();
	var tile = parseInt(request.tile, 10);
	var goal = request.goal == null || request.goal === '' ? '' : parseInt(request.goal, 10);
	var add = request.add == null || request.add === '' ? '' : Number(request.add);
	var complete = request.complete === true ? 'yes' : '';
	var note = String(request.note || '').slice(0, 300);
	var links = cleanProofLinks(request.links);
	if ((!fromForm && !/^[0-9a-f]{16}$/.test(member)) || !player || isNaN(tile) || tile < 1
		|| (add === '' && !complete) || (add !== '' && isNaN(add)))
	{
		return 0;
	}
	var team = teamOf(board);
	var sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
	var values = sheet.getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		// A retried send must not stack duplicate pending rows.
		if (isPending(values[i][9]) && String(values[i][8]) === member
			&& String(values[i][2]) === player
			&& String(values[i][1]) === team && String(values[i][3]) === String(tile)
			&& String(values[i][4]) === String(goal) && String(values[i][5]) === String(add)
			&& String(values[i][6]) === complete && String(values[i][7]) === note)
		{
			return 0;
		}
	}
	var row = sheet.getLastRow() + 1;
	var range = sheet.getRange(row, 1, 1, REQUESTS_HEADERS.length);
	range.setNumberFormat('@');
	range.setValues([[new Date().toISOString(), team, player, tile, goal, add, complete,
		note, member, 'Pending', links]]);
	styleStatusCell(sheet, row, 'Pending');
	return row;
}

/** Keeps only things that look like http(s) URLs; at most 5, newline-separated. */
function cleanProofLinks(text)
{
	var parts = String(text || '').split(/[\s,]+/);
	var links = [];
	for (var i = 0; i < parts.length && links.length < 5; i++)
	{
		if (/^https?:\/\/\S{4,300}$/i.test(parts[i]))
		{
			links.push(parts[i]);
		}
	}
	return links.join('\n');
}

/** Menu action: approve the request rows currently selected on the Requests tab. */
function approveSelectedRequests()
{
	resolveSelectedRequests(true);
}

/** Menu action: deny the request rows currently selected on the Requests tab. */
function denySelectedRequests()
{
	resolveSelectedRequests(false);
}

function resolveSelectedRequests(approve)
{
	var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
	var range = SpreadsheetApp.getActiveSpreadsheet().getActiveRange();
	if (!range || sheet.getName() !== REQUESTS_SHEET)
	{
		SpreadsheetApp.getUi().alert('Select the request row(s) on the Requests tab first.');
		return;
	}
	var rows = [];
	for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++)
	{
		if (r >= 2)
		{
			rows.push(r);
		}
	}
	var done = resolveRequests(rows, approve);
	SpreadsheetApp.getUi().alert(approve
		? done + ' request(s) marked Done and written to the Adjustments tab.'
		: done + ' request(s) rejected.');
}

/**
 * Approves or denies pending request rows via the menu. Already-resolved rows are
 * skipped, so re-running the menu action never double-credits.
 */
function resolveRequests(rowNumbers, approve)
{
	var sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
	var done = 0;
	for (var i = 0; i < rowNumbers.length; i++)
	{
		if (!isPending(sheet.getRange(rowNumbers[i], 10).getValue()))
		{
			continue;
		}
		if (setRequestStatus(rowNumbers[i], approve ? 'Done' : 'Rejected'))
		{
			done++;
		}
	}
	return done;
}

function isPending(status)
{
	var text = String(status || '').trim().toLowerCase();
	return text === '' || text === 'pending';
}

/**
 * Applies a status to one request row - from the menu or the Status dropdown. "Done"
 * writes the Adjustments ledger row exactly once: a "request #row" tag in the note
 * guards against double-crediting when the dropdown is flipped back and forth.
 *
 * @return whether the row was a real request and the status was applied
 */
function setRequestStatus(rowNumber, status)
{
	if (REQUEST_STATUSES.indexOf(status) < 0 || rowNumber < 2)
	{
		return false;
	}
	var sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
	var row = sheet.getRange(rowNumber, 1, 1, REQUESTS_HEADERS.length).getValues()[0];
	if (!String(row[2] || '').trim())
	{
		return false;
	}
	if (status === 'Done' && !adjustmentExistsForRequest(rowNumber))
	{
		getSheet(ADJ_SHEET, ADJ_HEADERS).appendRow([row[1], row[3], row[4], row[2], row[5],
			row[6], 'request #' + rowNumber + ': ' + row[7], 'approved request']);
	}
	styleStatusCell(sheet, rowNumber, status);
	return true;
}

function adjustmentExistsForRequest(rowNumber)
{
	var values = getSheet(ADJ_SHEET, ADJ_HEADERS).getDataRange().getValues();
	var tag = 'request #' + rowNumber + ':';
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][6] || '').indexOf(tag) === 0)
		{
			return true;
		}
	}
	return false;
}

/** Status cell = dropdown (pending/Done/Rejected) with the status color. */
function styleStatusCell(sheet, rowNumber, status)
{
	var cell = sheet.getRange(rowNumber, 10);
	cell.setDataValidation(SpreadsheetApp.newDataValidation()
		.requireValueInList(REQUEST_STATUSES, true).setAllowInvalid(false).build());
	cell.setValue(status);
	cell.setBackground(STATUS_COLORS[status] || null);
	cell.setFontColor('#333333');
}

/** "boardKey_" - the part sibling team scopes on the same board share; null if teamless. */
function boardPrefix(board)
{
	var at = board.lastIndexOf('_');
	return at < 0 ? null : board.substring(0, at + 1);
}

/**
 * A member's own arrival on a team evicts them from any sibling team on the same board:
 * their row is deleted there and tombstoned "left", so stale relays can't restore it.
 */
function moveMemberIfElsewhere(board, memberId)
{
	var prefix = boardPrefix(board);
	if (!prefix)
	{
		return;
	}
	var rows = readRows(getSheet(STORE_SHEET, STORE_HEADERS));
	for (var key in rows)
	{
		var row = rows[key];
		if (row.member === memberId && row.board !== board && row.board.indexOf(prefix) === 0)
		{
			removeMembers(row.board, [memberId]);
		}
	}
}

/** Clears "left" tombstones for a member rejoining this scope (admin rows untouched). */
function clearLeftTombstones(board, memberId)
{
	var sheet = getSheet(REMOVED_SHEET, REMOVED_HEADERS);
	var values = sheet.getDataRange().getValues();
	for (var i = values.length - 1; i >= 1; i--)
	{
		if (String(values[i][0]) === board && String(values[i][1]) === memberId
			&& String(values[i][3] || '').trim() === 'left')
		{
			sheet.deleteRow(i + 1);
		}
	}
}

/** Deletes members' store rows for a board and tombstones the ids on the Removed tab. */
function removeMembers(board, ids)
{
	var removedSheet = getSheet(REMOVED_SHEET, REMOVED_HEADERS);
	var existing = removedFor(board);
	var storeSheet = getSheet(STORE_SHEET, STORE_HEADERS);
	var rows = readRows(storeSheet);
	var toDelete = [];
	for (var i = 0; i < ids.length; i++)
	{
		var id = String(ids[i]);
		if (!/^[0-9a-f]{16}$/.test(id))
		{
			continue;
		}
		if (!existing[id])
		{
			// Explicit text format: an all-digit id would otherwise be float-mangled.
			// Reason "left" marks a self-eviction (player switched teams) - the only
			// kind a later rejoin may clear. Hand-added rows have no reason and stick.
			var range = removedSheet.getRange(removedSheet.getLastRow() + 1, 1, 1, 4);
			range.setNumberFormat('@');
			range.setValues([[board, id, new Date().toISOString(), 'left']]);
			existing[id] = true;
		}
		var row = rows[board + '|' + id];
		if (row)
		{
			toDelete.push(row.rowIndex);
		}
	}
	// Bottom-up so earlier deletions don't shift the remaining indexes.
	toDelete.sort(function (a, b)
	{
		return b - a;
	});
	for (var d = 0; d < toDelete.length; d++)
	{
		storeSheet.deleteRow(toDelete[d]);
	}
	if (toDelete.length)
	{
		maybeRefreshViews(board, true);
	}
}

// ---------------------------------------------------------------- admin adjustments

/** Team code portion of a store key ("<boardKey>_<teamcode>"). */
function teamOf(board)
{
	var at = board.lastIndexOf('_');
	return at < 0 ? '' : board.substring(at + 1);
}

/** Board view tab for a store key: one tab per team; solo players share the plain tab. */
function boardTabName(board)
{
	var team = teamOf(board);
	return team && team !== 'solo' ? BOARD_SHEET + ' ' + team : BOARD_SHEET;
}

/**
 * Turns the Adjustments ledger into synthetic members the plugin merges like teammates.
 * Rows are deltas: two screenshots of the same grind are two rows that add up, and a
 * mistake is corrected with a negative row. Nothing is ever edited in place, so the tab
 * doubles as the audit trail.
 */
function buildAdjustmentMembers(board, meta)
{
	var sheet = getSheet(ADJ_SHEET, ADJ_HEADERS);
	var values = sheet.getDataRange().getValues();
	var team = teamOf(board);
	var members = {};
	var stamp = Date.now();

	for (var i = 1; i < values.length; i++)
	{
		var parsed = parseAdjustmentRow(values[i], meta);
		if (parsed.issues.length || !parsed.player)
		{
			continue;
		}
		// Blank team = applies to every team using this deployment.
		if (parsed.team && team && parsed.team !== team)
		{
			continue;
		}

		var id = 'admin:' + parsed.player.toLowerCase();
		if (!members[id])
		{
			members[id] = { name: parsed.player + ' (verified)', tiles: {} };
		}
		var tiles = members[id].tiles;
		var tileKey = String(parsed.tile - 1);
		if (!tiles[tileKey])
		{
			tiles[tileKey] = { goals: [], manual: false, ts: stamp };
		}
		var tileEntry = tiles[tileKey];
		while (tileEntry.goals.length < parsed.goal)
		{
			tileEntry.goals.push({ n: 0 });
		}
		tileEntry.goals[parsed.goal - 1].n += parsed.add;
		if (parsed.complete)
		{
			tileEntry.manual = true;
		}
	}

	// Never hand back negative totals from over-correction.
	for (var m in members)
	{
		var memberTiles = members[m].tiles;
		for (var t in memberTiles)
		{
			var goals = memberTiles[t].goals;
			for (var g = 0; g < goals.length; g++)
			{
				if (goals[g].n < 0)
				{
					goals[g].n = 0;
				}
			}
		}
	}
	return members;
}

/** Reads and validates one Adjustments row. Bad rows are reported, never guessed at. */
function parseAdjustmentRow(row, meta)
{
	var out = {
		team: String(row[0] || '').trim().toLowerCase(),
		tile: parseInt(row[1], 10),
		goal: row[2] === '' || row[2] == null ? 1 : parseInt(row[2], 10),
		player: String(row[3] || '').trim(),
		add: row[4] === '' || row[4] == null ? 0 : Number(row[4]),
		complete: isTrue(row[5]),
		issues: []
	};

	var blank = !String(row[1] || '').trim() && !out.player && !row[4] && !out.complete;
	if (blank)
	{
		out.issues.push('');   // empty row: ignored silently
		return out;
	}
	if (!out.player)
	{
		out.issues.push('Player is required');
	}
	if (isNaN(out.tile) || out.tile < 1)
	{
		out.issues.push('Tile must be a tile number from the Board tab');
	}
	else if (meta && meta.tiles && out.tile > meta.tiles.length)
	{
		out.issues.push('Tile ' + out.tile + ' does not exist (board has ' + meta.tiles.length + ' tiles)');
	}
	if (isNaN(out.goal) || out.goal < 1)
	{
		out.issues.push('Goal must be blank or a goal number');
	}
	else if (meta && meta.tiles && out.tile >= 1 && out.tile <= meta.tiles.length)
	{
		var goals = meta.tiles[out.tile - 1].goals || [];
		if (out.goal > goals.length)
		{
			out.issues.push('Tile ' + out.tile + ' has ' + goals.length + ' goal(s)');
		}
	}
	if (isNaN(out.add))
	{
		out.issues.push('Add must be a number (or blank when only ticking Complete)');
	}
	if (!out.add && !out.complete)
	{
		out.issues.push('Nothing to credit: fill Add, or tick Complete');
	}
	return out;
}

function isTrue(value)
{
	if (value === true)
	{
		return true;
	}
	var text = String(value || '').trim().toLowerCase();
	return text === 'yes' || text === 'y' || text === 'true' || text === 'x' || text === 'done';
}

/** Writes the helper columns back: tile label, running total per player/goal, issues. */
function annotateAdjustments(meta)
{
	var sheet = getSheet(ADJ_SHEET, ADJ_HEADERS);
	var lastRow = sheet.getLastRow();
	if (lastRow < 2)
	{
		return;
	}
	var values = sheet.getRange(2, 1, lastRow - 1, ADJ_HEADERS.length).getValues();
	var running = {};
	var notes = [];

	for (var i = 0; i < values.length; i++)
	{
		var parsed = parseAdjustmentRow(values[i], meta);
		var label = '';
		var total = '';
		var issues = parsed.issues.filter(function (t) { return t; }).join('; ');

		if (!issues && parsed.player)
		{
			if (meta && meta.tiles && meta.tiles[parsed.tile - 1])
			{
				label = meta.tiles[parsed.tile - 1].label || '';
			}
			var key = [parsed.team, parsed.player.toLowerCase(), parsed.tile, parsed.goal].join('|');
			running[key] = (running[key] || 0) + parsed.add;
			total = running[key];
			if (meta && meta.tiles && meta.tiles[parsed.tile - 1])
			{
				var goalMeta = (meta.tiles[parsed.tile - 1].goals || [])[parsed.goal - 1];
				if (goalMeta && goalMeta.target)
				{
					total = running[key] + ' / ' + goalMeta.target;
				}
			}
		}
		notes.push([label, total, issues]);
	}
	sheet.getRange(2, 10, notes.length, 3).setValues(notes);
}

// ---------------------------------------------------------------- board view

/**
 * Rebuilds the human-readable board tab: the grid, then a goal-by-goal breakdown.
 * Each team gets its own tab ("Board <teamcode>"), so an event with several teams on one
 * deployment shows every team - a single shared tab would only ever show the team that
 * synced last.
 */
function refreshBoardView(board)
{
	var meta = readMeta(board);
	var sheet = getSheet(boardTabName(board), null);
	sheet.clear();

	if (!meta || !meta.tiles)
	{
		sheet.getRange(1, 1).setValue(
			'Waiting for a board. Any player with "Sync via team store" enabled sends it automatically.');
		return;
	}

	var totals = tileTotals(board, meta);
	var size = meta.size || Math.round(Math.sqrt(meta.tiles.length));
	sheet.getRange(1, 1).setValue(meta.name || 'Bingo board').setFontWeight('bold').setFontSize(14);
	sheet.getRange(2, 1).setValue('Team: ' + (teamOf(board) || '-') + '   ·   updated ' + new Date().toISOString());

	// Grid, mirroring the in-game board.
	var grid = [];
	for (var r = 0; r < size; r++)
	{
		var row = [];
		for (var c = 0; c < size; c++)
		{
			var index = r * size + c;
			var tile = meta.tiles[index];
			row.push(tile ? (index + 1) + '. ' + (tile.label || '') + (totals.done[index] ? '  ✔' : '') : '');
		}
		grid.push(row);
	}
	if (grid.length)
	{
		var gridRange = sheet.getRange(4, 1, grid.length, size);
		gridRange.setValues(grid).setWrap(true).setVerticalAlignment('middle');
		for (var g = 0; g < meta.tiles.length; g++)
		{
			if (totals.done[g])
			{
				sheet.getRange(4 + Math.floor(g / size), 1 + (g % size)).setBackground('#d9ead3');
			}
		}
	}

	// Goal-by-goal table: what to reference when crediting on the Adjustments tab.
	var tableTop = 4 + size + 2;
	var table = [['Tile', 'Label', 'Goal', 'Goal description', 'Target', 'Tracked', 'Verified', 'Total', 'Done', 'By player']];
	for (var t = 0; t < meta.tiles.length; t++)
	{
		var tileMeta = meta.tiles[t];
		var goals = tileMeta.goals || [];
		var tickers = Object.keys(totals.manualBy[t] || {}).join(', ');
		if (!goals.length)
		{
			table.push([t + 1, tileMeta.label || '', 1, 'Manual tile', 1,
				'', totals.verifiedManual[t] ? 'ticked' : '', '', totals.done[t] ? 'yes' : '',
				tickers ? 'ticked by ' + tickers : '']);
			continue;
		}
		for (var gi = 0; gi < goals.length; gi++)
		{
			var byPlayer = formatContrib(totals.contrib[t][gi]);
			if (gi === 0 && tickers)
			{
				byPlayer += (byPlayer ? '  ·  ' : '') + 'ticked by ' + tickers;
			}
			table.push([
				t + 1,
				gi === 0 ? (tileMeta.label || '') : '',
				gi + 1,
				goals[gi].label || '',
				goals[gi].target || '',
				totals.tracked[t][gi],
				totals.verified[t][gi],
				totals.tracked[t][gi] + totals.verified[t][gi],
				gi === 0 ? (totals.done[t] ? 'yes' : '') : '',
				byPlayer
			]);
		}
	}
	sheet.getRange(tableTop, 1, table.length, table[0].length).setValues(table);
	sheet.getRange(tableTop, 1, 1, table[0].length).setFontWeight('bold');
	sheet.setFrozenRows(tableTop);
	for (var col = 1; col <= Math.max(size, table[0].length); col++)
	{
		sheet.setColumnWidth(col, col === 2 ? 220 : col === table[0].length ? 320 : 110);
	}
	sheet.protect().setDescription('Generated view - edit the Adjustments tab instead')
		.setWarningOnly(true);
}

/** Per-tile, per-goal totals from stored players and from admin credit. */
function tileTotals(board, meta)
{
	var rows = readRows(getSheet(STORE_SHEET, STORE_HEADERS));
	var credited = buildAdjustmentMembers(board, meta);
	var tracked = [];
	var verified = [];
	var manual = [];
	var verifiedManual = [];
	var distinctSets = [];
	var contrib = [];     // [tile][goal] -> {player name: amount}
	var manualBy = [];    // [tile] -> {player name: true} for manual ticks

	for (var t = 0; t < meta.tiles.length; t++)
	{
		var goalCount = Math.max(1, (meta.tiles[t].goals || []).length);
		tracked.push(zeros(goalCount));
		verified.push(zeros(goalCount));
		distinctSets.push([]);
		contrib.push([]);
		for (var g = 0; g < goalCount; g++)
		{
			distinctSets[t].push({});
			contrib[t].push({});
		}
		manual.push(false);
		verifiedManual.push(false);
		manualBy.push({});
	}

	function absorb(tiles, into, isAdmin, playerName)
	{
		for (var key in tiles)
		{
			var index = parseInt(key, 10);
			if (isNaN(index) || index < 0 || index >= meta.tiles.length)
			{
				continue;
			}
			var entry = tiles[key] || {};
			if (entry.manual)
			{
				manual[index] = true;
				manualBy[index][playerName] = true;
				if (isAdmin)
				{
					verifiedManual[index] = true;
				}
			}
			var goals = entry.goals || [];
			for (var g = 0; g < goals.length && g < into[index].length; g++)
			{
				var goalMeta = (meta.tiles[index].goals || [])[g] || {};
				var matched = goals[g].matched;
				var amount;
				if (goalMeta.distinct && matched && matched.length)
				{
					// Distinct goals count different items once across the whole team.
					for (var m = 0; m < matched.length; m++)
					{
						distinctSets[index][g][String(matched[m]).toLowerCase()] = true;
					}
					amount = matched.length;
				}
				else
				{
					amount = Number(goals[g].n || 0);
					into[index][g] += amount;
				}
				if (amount > 0)
				{
					contrib[index][g][playerName] = (contrib[index][g][playerName] || 0) + amount;
				}
			}
		}
	}

	var removedIds = removedFor(board);
	for (var key in rows)
	{
		var row = rows[key];
		if (row.board === board && /^[0-9a-f]{16}$/.test(row.member) && !removedIds[row.member])
		{
			absorb(parseJson(row.data, {}), tracked, false, row.name || row.member);
		}
	}
	for (var id in credited)
	{
		absorb(credited[id].tiles, verified, true, credited[id].name || id);
	}

	// Fold distinct unions back into the tracked column.
	for (var t2 = 0; t2 < tracked.length; t2++)
	{
		for (var g2 = 0; g2 < tracked[t2].length; g2++)
		{
			var unionSize = Object.keys(distinctSets[t2][g2]).length;
			if (unionSize)
			{
				tracked[t2][g2] += unionSize;
			}
		}
	}

	var done = [];
	for (var t3 = 0; t3 < meta.tiles.length; t3++)
	{
		var goalsMeta = meta.tiles[t3].goals || [];
		if (manual[t3])
		{
			done.push(true);
			continue;
		}
		if (!goalsMeta.length)
		{
			done.push(false);   // manual-only tile, not ticked
			continue;
		}
		var anyMode = meta.tiles[t3].mode === 'ANY';
		var complete = !anyMode;
		for (var g3 = 0; g3 < goalsMeta.length; g3++)
		{
			var target = Number(goalsMeta[g3].target || 0);
			var reached = target > 0 && (tracked[t3][g3] + verified[t3][g3]) >= target;
			complete = anyMode ? (complete || reached) : (complete && reached);
		}
		done.push(complete);
	}
	return { tracked: tracked, verified: verified, done: done, verifiedManual: verifiedManual,
		contrib: contrib, manualBy: manualBy };
}

/** "Kaos: 40 · Rich: 12", largest contribution first. */
function formatContrib(byPlayer)
{
	var names = Object.keys(byPlayer || {});
	names.sort(function (a, b)
	{
		return byPlayer[b] - byPlayer[a];
	});
	var parts = [];
	for (var i = 0; i < names.length; i++)
	{
		parts.push(names[i] + ': ' + byPlayer[names[i]]);
	}
	return parts.join('  ·  ');
}

function zeros(n)
{
	var out = [];
	for (var i = 0; i < n; i++)
	{
		out.push(0);
	}
	return out;
}

// ---------------------------------------------------------------- board metadata

function saveMeta(board, meta)
{
	var sheet = getSheet(META_SHEET, META_HEADERS);
	var values = sheet.getDataRange().getValues();
	var json = JSON.stringify(meta);
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0]) === board)
		{
			if (String(values[i][2]) !== json)
			{
				sheet.getRange(i + 1, 1, 1, 3).setValues([[board, new Date().toISOString(), json]]);
				maybeRefreshViews(board, true);
			}
			return;
		}
	}
	sheet.appendRow([board, new Date().toISOString(), json]);
	maybeRefreshViews(board, true);
}

function readMeta(board)
{
	var sheet = getSheet(META_SHEET, META_HEADERS);
	var values = sheet.getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0]) === board)
		{
			return parseJson(values[i][2], null);
		}
	}
	return null;
}

// ---------------------------------------------------------------- sheet plumbing

function maybeRefreshViews(board, force)
{
	var props = PropertiesService.getScriptProperties();
	var last = Number(props.getProperty('lastRefresh_' + board) || 0);
	if (!force && Date.now() - last < REFRESH_THROTTLE_MS)
	{
		return;
	}
	props.setProperty('lastRefresh_' + board, String(Date.now()));
	try
	{
		var meta = readMeta(board);
		annotateAdjustments(meta);
		refreshBoardView(board);
	}
	catch (err)
	{
		// A view failure must never break progress syncing.
		console.error('Refreshing views failed: ' + err);
	}
}

function getSheet(name, headers)
{
	var doc = SpreadsheetApp.getActiveSpreadsheet();
	if (!doc)
	{
		// Happens when the code was pasted into a standalone Apps Script project.
		throw new Error('This script must live INSIDE your Google Sheet: open the sheet, '
			+ 'go to Extensions -> Apps Script, paste the code there and deploy that project.');
	}
	var sheet = doc.getSheetByName(name);
	if (!sheet)
	{
		sheet = doc.insertSheet(name);
		if (headers)
		{
			sheet.appendRow(headers);
			sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
			sheet.setFrozenRows(1);
			if (name === ADJ_SHEET)
			{
				sheet.getRange(1, 10, 1, 3).setFontColor('#888888');
				sheet.setColumnWidth(7, 240);
			}
		}
		if (name === SETTINGS_SHEET)
		{
			// Discoverable knobs, one per row. Blank = the plugin's default.
			sheet.appendRow(['Push throttle (seconds)', '']);
			// Apps Script cannot reliably learn its own /exec URL (getService().getUrl()
			// 404s for container-bound scripts), so the host pastes it here once.
			sheet.appendRow(['Portal URL (web app /exec)', '']);
		}
		if (HIDDEN_SHEETS.indexOf(name) >= 0)
		{
			sheet.hideSheet();
		}
	}
	return sheet;
}

/**
 * Host-tuned minimum seconds between a client's store pushes (Settings tab), for large
 * events on one deployment. 0 = not set; the plugin never goes below its own default
 * and ignores values it considers unsafe.
 */
/**
 * The board code the host pasted onto the Board code tab, so players with the store URL
 * can load the board without being sent the code separately. Multi-line pastes land one
 * line per row; everything under the instruction row is joined back together.
 */
/** The board code the host pasted (rows rejoined, trimmed); '' when the tab is empty. */
function readBoardCode()
{
	var sheet = ensureBoardCodeSheet();
	var values = sheet.getDataRange().getValues();
	var lines = [];
	for (var i = 1; i < values.length; i++)
	{
		lines.push(String(values[i][0] == null ? '' : values[i][0]));
	}
	return lines.join('\n').trim();
}

function sha256Hex(text)
{
	var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text,
		Utilities.Charset.UTF_8);
	var hex = '';
	for (var i = 0; i < bytes.length; i++)
	{
		var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
		hex += (b < 16 ? '0' : '') + b.toString(16);
	}
	return hex;
}

function fetchBoardResponse()
{
	var code = readBoardCode();
	var payload;
	if (!code)
	{
		payload = { error: 'The host has not pasted a board code onto the sheet\'s '
			+ '"Board code" tab yet - use Import board with the code instead.' };
	}
	else
	{
		try
		{
			var parsed = JSON.parse(code);
			if (!parsed || !parsed.tiles)
			{
				throw new Error('no tiles');
			}
			payload = { boardJson: code };
		}
		catch (err)
		{
			// The classic failure: a multi-line paste ran through Sheets' CSV handling,
			// which strips the quotes (name: instead of "name":).
			var mangled = /(^|\n)\s*[A-Za-z]+\s*:/.test(code);
			payload = { error: mangled
				? 'The board code on the sheet got corrupted by pasting across cells '
					+ '(Sheets strips the quotes). Ask your host to paste it INSIDE one cell '
					+ '(double-click A2 first) or to copy a fresh one-line code from the board builder.'
				: 'The board code on the sheet\'s "Board code" tab is not valid board JSON '
					+ '- ask your host to re-paste it.' };
		}
	}
	return ContentService.createTextOutput(JSON.stringify(payload))
		.setMimeType(ContentService.MimeType.JSON);
}

function ensureBoardCodeSheet()
{
	var sheet = getSheet(BOARD_CODE_SHEET, null);
	if (sheet.getLastRow() < 1)
	{
		sheet.getRange(1, 1).setValue('Paste the board code below - players can then load it '
			+ 'via Setup -> Get board from store. IMPORTANT: paste INSIDE cell A2 '
			+ '(double-click it first), or Sheets strips the quotes and corrupts the code.')
			.setFontWeight('bold');
		sheet.setColumnWidth(1, 700);
	}
	return sheet;
}

/** The host-pasted /exec URL from the Settings tab, or null when unset/not a URL. */
function readPortalUrl()
{
	var values = getSheet(SETTINGS_SHEET, SETTINGS_HEADERS).getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0] || '').toLowerCase().indexOf('portal') >= 0)
		{
			var url = String(values[i][1] || '').trim();
			return /^https:\/\/\S+$/.test(url) ? url : null;
		}
	}
	return null;
}

function readPushThrottle()
{
	var values = getSheet(SETTINGS_SHEET, SETTINGS_HEADERS).getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0] || '').toLowerCase().indexOf('throttle') >= 0)
		{
			var seconds = Number(values[i][1]);
			return isNaN(seconds) || seconds <= 0 ? 0 : Math.floor(seconds);
		}
	}
	return 0;
}

function readRows(sheet)
{
	var rows = {};
	var values = sheet.getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		var board = String(values[i][0]);
		var member = String(values[i][1]);
		if (!board || !member)
		{
			continue;
		}
		rows[board + '|' + member] = {
			rowIndex: i + 1,
			board: board,
			member: member,
			name: String(values[i][2] || ''),
			data: String(values[i][4] || '')
		};
	}
	return rows;
}

function writeStoreRow(sheet, rows, key, board, memberId, name, tiles)
{
	var values = [board, memberId, name, new Date().toISOString(), JSON.stringify(tiles)];
	var row = rows[key];
	var rowIndex = row ? row.rowIndex : sheet.getLastRow() + 1;
	var range = sheet.getRange(rowIndex, 1, 1, 5);
	// Force plain-text cells: account ids are long hex strings and Sheets would otherwise
	// coerce anything numeric-looking, mangling the member key.
	range.setNumberFormat('@');
	range.setValues([values]);
}

function parseJson(text, fallback)
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

// ---------------------------------------------------------------- spreadsheet UI

function onOpen()
{
	// Make the tabs admins type into exist right away (they would otherwise only appear
	// after the first player sync): define teams on Teams, credit on Adjustments, and
	// review player requests on Requests.
	getSheet(TEAMS_SHEET, TEAMS_HEADERS);
	getSheet(ADJ_SHEET, ADJ_HEADERS);
	getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
	getSheet(SETTINGS_SHEET, SETTINGS_HEADERS);
	ensureBoardCodeSheet();
	SpreadsheetApp.getUi()
		.createMenu('Irons Pub Bingo')
		.addItem('Open player portal', 'openPortal')
		.addItem('Refresh board view', 'refreshAllViews')
		.addItem('Approve selected request(s)', 'approveSelectedRequests')
		.addItem('Deny selected request(s)', 'denySelectedRequests')
		.addItem('Reset store data...', 'resetStoreData')
		.addToUi();
}

/**
 * Menu action: wipes every event tab (Store, Meta, Teams, Board code, Adjustments,
 * Requests, Removed, generated Board views) and recreates them empty - only the
 * Settings tab survives. For starting a fresh event or clearing test data.
 */
function resetStoreData()
{
	var ui = SpreadsheetApp.getUi();
	var answer = ui.alert('Reset store data',
		'This clears ALL event data: Store, Meta, Teams, Board code, Adjustments, Requests, '
			+ 'Removed and the generated Board tabs. Only Settings is kept.\n\n'
			+ 'Note: players\' plugins keep their local progress and will push it back on '
			+ 'their next sync - have them import the next board (new id) or switch teams '
			+ 'if this is between events.\n\nContinue?',
		ui.ButtonSet.YES_NO);
	if (answer !== ui.Button.YES)
	{
		return;
	}
	var lock = LockService.getScriptLock();
	lock.waitLock(20000);
	try
	{
		var doc = SpreadsheetApp.getActiveSpreadsheet();
		// Settings must exist before the loop: a spreadsheet can never lose its last tab.
		getSheet(SETTINGS_SHEET, SETTINGS_HEADERS);
		var sheets = doc.getSheets();
		for (var i = 0; i < sheets.length; i++)
		{
			if (sheets[i].getName() !== SETTINGS_SHEET)
			{
				doc.deleteSheet(sheets[i]);
			}
		}
		// Recreate the standing tabs empty, with their usual headers/seeding/visibility.
		getSheet(STORE_SHEET, STORE_HEADERS);
		getSheet(META_SHEET, META_HEADERS);
		getSheet(TEAMS_SHEET, TEAMS_HEADERS);
		getSheet(ADJ_SHEET, ADJ_HEADERS);
		getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
		getSheet(REMOVED_SHEET, REMOVED_HEADERS);
		ensureBoardCodeSheet();
		PropertiesService.getScriptProperties().deleteAllProperties();
	}
	finally
	{
		lock.releaseLock();
	}
	ui.alert('Store reset - all event data cleared. Settings kept.');
}

/**
 * Menu action: opens the player portal - the same /exec page the clan uses - so admins
 * see the event exactly as players do. The URL comes from the Settings tab (pasted once
 * by the host; the script cannot reliably learn its own deployment URL). Menus can't
 * open URLs directly, so a tiny dialog does it (with a fallback link for popup blockers).
 */
function openPortal()
{
	var url = readPortalUrl();
	if (!url)
	{
		SpreadsheetApp.getUi().alert('Paste your web app URL (the /exec link from '
			+ 'Deploy -> Manage deployments) into the Settings tab\'s "Portal URL" row first.');
		return;
	}
	var html = HtmlService.createHtmlOutput(
		'<script>window.open(' + JSON.stringify(url) + ', "_blank");</script>'
		+ '<p style="font-family:sans-serif;font-size:13px">Opening the portal in a new tab... '
		+ 'If nothing happened, <a href="' + url + '" target="_blank">click here</a>.</p>')
		.setWidth(320).setHeight(70);
	SpreadsheetApp.getUi().showModalDialog(html, 'Irons Pub Bingo - player portal');
}

/** Menu action: refresh every board this sheet holds. */
function refreshAllViews()
{
	var sheet = getSheet(META_SHEET, META_HEADERS);
	var values = sheet.getDataRange().getValues();
	if (values.length < 2)
	{
		SpreadsheetApp.getUi().alert('No board yet — a player needs to sync once with the team store enabled.');
		return;
	}
	for (var i = 1; i < values.length; i++)
	{
		maybeRefreshViews(String(values[i][0]), true);
	}
}

/** Stamps when an adjustment row was added, so the ledger is self-documenting. */
function onEdit(e)
{
	var sheet = e.range.getSheet();
	if (sheet.getName() === REQUESTS_SHEET)
	{
		// Admin picked a status from the Status dropdown: apply it - "Done" writes the
		// Adjustments ledger row (once), and the cell gets its status color.
		if (e.range.getColumn() === 10 && e.range.getRow() >= 2 && e.range.getNumRows() === 1)
		{
			setRequestStatus(e.range.getRow(), String(e.value || 'Pending'));
		}
		return;
	}
	if (sheet.getName() !== ADJ_SHEET || e.range.getRow() < 2)
	{
		return;
	}
	var row = e.range.getRow();
	var stampCell = sheet.getRange(row, 9);
	if (!stampCell.getValue())
	{
		stampCell.setValue(new Date().toISOString());
	}
}
