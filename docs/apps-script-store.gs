/**
 * Irons Pub Bingo team store: the backend for the Irons Pub Bingo RuneLite plugin.
 *
 * cloudflare-store/ runs this file inside a Cloudflare Worker, one Durable Object per
 * event. It started out as a Google Apps Script bound to a spreadsheet, so it still talks
 * to "tabs" through the Google APIs. cloudflare-store/src/google.js stands in for them,
 * and the tabs are the event's tables in Durable Object storage.
 *
 * What it does:
 *  1. Stores each player's bingo progress so teammates who are never online at the same
 *     time still see each other's progress. A client sends its own progress and gets the
 *     merged team state back in the same call.
 *  2. Keeps admin credit (Adjustments) and player credit requests (Requests), which sync
 *     back into everyone's plugin like any other contribution.
 *  3. Serves the player portal and the data the admin page shows.
 *
 * One store event runs the whole bingo: every team shares it, kept apart by team code.
 *
 * Tables:
 *  - Adjustments : admin credit. Rows add up. A negative row corrects a mistake.
 *  - Requests    : credit requests from the plugin and the portal, with their status.
 *                  Approving one writes its Adjustments row.
 *  - Teams       : the allow-list of team codes (Code, Name, Webhook). Only listed codes
 *                  may sync, and the plugin's Choose team picker offers exactly this list.
 *                  While it is empty the store accepts nothing.
 *  - Board code  : the official board. Players import it, and clients running any other
 *                  board are rejected.
 *  - Settings    : "Poll interval (seconds)", 60 to 900, blank means 120.
 *  - Removed     : who no longer counts, per board scope. Their Store row stays parked,
 *                  so returning to the team brings their progress back. Reason "left" is
 *                  written when a player switches teams and clears when they rejoin.
 *  - Board <team>: a generated view of each team's board and progress.
 *  - Store       : per-player progress, with the member key hash that owns each row.
 *  - Meta        : board summaries per board scope.
 *  - Scores      : each team's points, for the standings.
 */

var STORE_SHEET = 'Store';
var ADJ_SHEET = 'Adjustments';
var BOARD_SHEET = 'Board';
var META_SHEET = 'Meta';
var TEAMS_SHEET = 'Teams';
// Bumped by Reset store data. Clients that see a new generation drop the cached
// teammates they would otherwise push straight back into the fresh event.
var EPOCH_PROP = 'storeEpoch';
var REMOVED_SHEET = 'Removed';
var SETTINGS_SHEET = 'Settings';
var SETTINGS_HEADERS = ['Setting', 'Value', 'Notes'];
var BOARD_CODE_SHEET = 'Board code';
var SCORES_SHEET = 'Scores';
var SCORES_HEADERS = ['board', 'points', 'updated'];

var ADJ_HEADERS = ['Team', 'Tile', 'Goal', 'Player', 'Add (+/-)', 'Complete', 'Note',
	'Verified by', 'Added', '-> Tile label', '-> Running total', '-> Issues'];
var STORE_HEADERS = ['board', 'member', 'name', 'updated', 'data', 'key'];
// Largest sync body accepted. A real one is a few kilobytes; anything near this is junk
// that would otherwise hold the store lock while it is parsed and written.
var MAX_BODY_CHARS = 200000;
var META_HEADERS = ['board', 'updated', 'meta'];
var TEAMS_HEADERS = ['Code', 'Name', 'Webhook'];
var REMOVED_HEADERS = ['board', 'member', 'when', 'reason'];
var REQUESTS_SHEET = 'Requests';
var REQUESTS_HEADERS = ['When', 'Team', 'Player', 'Tile', 'Goal', 'Add', 'Complete', 'Note',
	'Member', 'Status', 'Proof links', 'Id'];
var REQUEST_STATUSES = ['Pending', 'Done', 'Rejected'];
var STATUS_COLORS = { Pending: '#fff2cc', Done: '#d9ead3', Rejected: '#f4cccc' };
// Machine-written tabs stay hidden so the admin view is just the tabs humans use
// (unhide anytime via View -> Hidden sheets; hiding is tidiness, not security - the
// spreadsheet itself should only ever be shared with admins).
var HIDDEN_SHEETS = [STORE_SHEET, META_SHEET, REMOVED_SHEET, SCORES_SHEET];

var REFRESH_THROTTLE_MS = 120000;
// Teams, the board code, the poll interval and the store generation change rarely but
// would otherwise be read on every sync. They are cached this long; editing those tabs by hand clears
// the cache at once (onEdit), so a host's change still applies on the next sync.
var CONFIG_CACHE_SECONDS = 60;
// Client clocks drift; anything further ahead than this is clamped on write. An
// unclamped future stamp would out-rank every later write - including the owner's
// own reset - forever.
var MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- web endpoints

function doPost(e)
{
	// The Board tab render is the slowest thing a sync does, and it only READS the
	// store, so it runs after the write lock is released: clients queued behind this
	// request get their turn seconds earlier.
	var refreshAfter = {};
	var output = handlePost(e, function (board, force)
	{
		refreshAfter[board] = refreshAfter[board] || !!force;
	});
	for (var board in refreshAfter)
	{
		maybeRefreshViews(board, refreshAfter[board]);
	}
	// Web requests run fully authorized, so they deliver any announcements the Status
	// dropdown's limited trigger context had to park. Outside the sync lock: Discord
	// being slow must not hold every other player's sync.
	flushWebhookQueue();
	return output;
}

function handlePost(e, deferRefresh)
{
	var body;
	try
	{
		if (String(e.postData.contents || '').length > MAX_BODY_CHARS)
		{
			return jsonError('Request too large');
		}
		body = JSON.parse(e.postData.contents);

		// Read-only requests answer before the write lock is even attempted: a store
		// busy merging someone's push can still hand out the team list and the board.
		if (body.teamsOnly)
		{
			// The plugin's "Choose team" picker: the host-defined team list, each with
			// the names already signed up, so players can see who they would join.
			return ContentService.createTextOutput(JSON.stringify(
				{ teams: teamsWithMembers(String(body.board || '')) }))
				.setMimeType(ContentService.MimeType.JSON);
		}
		if (body.fetchBoard)
		{
			// The plugin's "Get board from store": the board code the host pasted onto
			// the Board code tab. Manual Import board keeps working regardless.
			return fetchBoardResponse();
		}
	}
	catch (err)
	{
		console.error('doPost failed: ' + err);
		return jsonError('Script error - see the executions log on the sheet');
	}

	var lock = LockService.getScriptLock();
	if (!lock.tryLock(25000))
	{
		// Another client is mid-write. Answering in JSON keeps the plugin's status
		// readable; the next sync (or poll) picks the data up anyway.
		return jsonError('Busy - another client is writing; it retries on the next sync');
	}
	try
	{
		var board = String(body.board || '');
		var members = body.members || {};
		// Every sheet read is a slow RPC, so each tab is read ONCE per request and the
		// results are threaded through (the write lock is held - nothing can change).
		// (Not created here: a request the allow-list below rejects must leave no tabs.)
		var existingStore = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STORE_SHEET);
		var rows = existingStore ? readRows(existingStore) : {};
		// Proof of identity. The /exec URL is shared clan-wide and member ids are public,
		// so a write for a member must carry that member's key (derived from their
		// account on their own client). Rows claimed by a key accept only that key.
		var keyHash = memberKeyHash(body.memberKey);
		// The Removed tab, read at most once and only when needed.
		var departures = null;
		var readOnce = function ()
		{
			departures = departures || readDepartures();
			return departures;
		};
		var self = /^[0-9a-f]{16}$/.test(String(body.rejoin || '')) ? String(body.rejoin) : null;
		if (self && !ownsMember(rows, self, keyHash))
		{
			if (members[self])
			{
				// Say so, instead of silently dropping every sync this player sends.
				return ContentService.createTextOutput(JSON.stringify({ board: board,
					error: keyHash ? 'Key mismatch - ask your host' : 'Update the plugin to sync' }))
					.setMimeType(ContentService.MimeType.JSON);
			}
			self = null;
		}

		if (body.remove && body.remove.length)
		{
			// A player who left this team scope: tombstone the id (their row stays parked),
			// so teammates' cached copies can't push it back (see the Removed tab).
			// Processed before the team allow-list so leaving a since-delisted team
			// still cleans up. Only the member themselves can leave.
			var leaving = [];
			for (var li = 0; li < body.remove.length; li++)
			{
				if (ownsMember(rows, String(body.remove[li]), keyHash))
				{
					leaving.push(String(body.remove[li]));
				}
			}
			removeMembers(board, leaving, leaving.length ? readOnce() : null, deferRefresh);
			if (!self && !body.request && !Object.keys(members).length)
			{
				// A pure departure notice is done here. It must succeed even when the
				// team it leaves has since been taken off the Teams tab.
				return ContentService.createTextOutput(JSON.stringify({ board: board, left: leaving }))
					.setMimeType(ContentService.MimeType.JSON);
			}
		}

		// The Teams tab is the allow-list: only codes the host listed may write. An empty
		// tab means the event is not set up (or was just reset), and a client still
		// holding an old board must not spawn board tabs and store rows behind the host.
		var teams = readTeamRows();
		if (!teams.length || !hasTeam(teams, teamOf(board)))
		{
			var reason;
			if (!teams.length)
			{
				reason = 'No teams yet - the host has not set up the Teams tab';
			}
			else if (teamOf(board) === 'solo')
			{
				reason = 'No team code - use Choose team or ask your host';
			}
			else
			{
				reason = 'Unknown team code - use Choose team or ask your host';
			}
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
		// A changed board code reconciles stored progress BEFORE the tamper gate, so
		// the very first poll after the host pastes an update cleans the store - even
		// a poll from a client still running the old board.
		reconcileBoardCode(canonicalCode, canonicalHash);
		if (canonicalHash && String(body.boardHash || '') !== canonicalHash)
		{
			// A client behind on versions gets told about the update; any other
			// mismatch is a locally edited board. The error stays short (it sits on
			// the plugin's store button); newerVersion carries the guidance instead.
			// The store also remembers every code it has seen for this board id, so a
			// client on ANY earlier paste (or one too old to send a version) is
			// recognised as outdated instead of accused of editing the board.
			var canonicalVersion = Number((parseJson(canonicalCode, {}) || {}).version || 0);
			var clientVersion = Number(body.boardVersion || 0);
			var outdated = (canonicalVersion && clientVersion && clientVersion < canonicalVersion)
				|| isEarlierBoardCode(String(body.boardHash || ''));
			return ContentService.createTextOutput(JSON.stringify({ board: board,
				error: outdated ? 'Board updated' : 'Wrong board - use Import board, then Import from store',
				newerVersion: outdated ? canonicalVersion : undefined }))
				.setMimeType(ContentService.MimeType.JSON);
		}
		if (self)
		{
			// A member syncing here by choice clears any "left" tombstone they carry in
			// this scope, so switching back to a team you left heals itself. Hand-added
			// tombstones (no "left" reason) are admin evictions and stay.
			departures = clearLeftTombstones(board, self, readOnce());
			// ...and their arrival moves their row: one team per board per member.
			moveMemberIfElsewhere(board, self, rows, departures, deferRefresh);
		}

		if (body.request && ownsMember(rows, String(body.request.member || ''), keyHash))
		{
			// A member asking an admin to credit something the tracker missed - lands on
			// the Requests tab for review (Irons Pub Bingo menu -> approve/deny).
			recordRequest(board, body.request, false);
		}

		var scores = readScores();
		if (typeof body.teamPoints === 'number' && body.teamPoints >= 0)
		{
			// The team's self-computed total, for the cross-team standings.
			upsertScore(board, Math.floor(body.teamPoints), scores);
		}

		var metaChanged = false;
		if (body.meta)
		{
			// The board summary admins and the portal read. With an official board code
			// pasted it is built from that code, never taken from the client: a client
			// could otherwise rename tiles or lower targets on the sheet.
			var official = canonicalCode ? parseJson(canonicalCode, null) : null;
			metaChanged = saveMeta(board, official && official.tiles
				? metaFromBoard(official) : cleanClientMeta(body.meta));
		}

		var sheet = getSheet(STORE_SHEET, STORE_HEADERS);
		var marks = readOnce().marks;
		var removed = removedFor(board, marks);

		// One team per board per member: a member's tracked data lives where THEIR OWN
		// client syncs (the rejoin id above moves it). A relayed copy can never create
		// a member inside a different team's scope.
		var prefix = boardPrefix(board);
		var ownedElsewhere = {};
		if (prefix)
		{
			// Rows left behind in a team the member has since left don't count as owning
			// them - those are parked, waiting for a return, not an active membership.
			for (var rk in rows)
			{
				if (rows[rk].board !== board && rows[rk].board.indexOf(prefix) === 0
					&& !marks[rows[rk].board + '|' + rows[rk].member])
				{
					ownedElsewhere[rows[rk].member] = true;
				}
			}
		}

		for (var memberId in members)
		{
			// A client writes only its own row, proven by its key: relayed copies of
			// teammates are ignored, so nobody can overwrite (or wipe) someone else, and
			// a player who never turned the store on is never uploaded by a teammate.
			// The "admin:" members this script generates are never accepted either.
			if (memberId !== self || removed[memberId] || ownedElsewhere[memberId])
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
			var maxTs = Date.now() + MAX_CLOCK_SKEW_MS;
			for (var tile in incomingTiles)
			{
				var inc = incomingTiles[tile];
				var cur = current[tile];
				if (inc && inc.ts > maxTs)
				{
					// Clamp to now, not to now+skew: the next honest write must win.
					inc.ts = Date.now();
				}
				if (inc && (!cur || (inc.ts || 0) > (cur.ts || 0)))
				{
					current[tile] = inc;
					changed = true;
				}
			}
			var name = cleanPlayerName(incoming.name) || (row ? row.name : '');
			if (!row || changed || name !== row.name || !row.key)
			{
				writeStoreRow(sheet, rows, key, board, memberId, name, current, keyHash);
			}
		}

		var response = respond(board, rows, removed, teams, scores);
		deferRefresh(board, metaChanged);
		return response;
	}
	catch (err)
	{
		// A thrown error would otherwise become an HTML error page, which clients
		// cannot parse - answer in JSON so the reason reaches the player.
		console.error('doPost failed: ' + err);
		return jsonError('Script error - see the executions log on the sheet');
	}
	finally
	{
		lock.releaseLock();
	}
}

function jsonError(message)
{
	return ContentService.createTextOutput(JSON.stringify({ error: message }))
		.setMimeType(ContentService.MimeType.JSON);
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
				if (metaGoals[g].manual)
				{
					// Manual goals have no counters; their progress IS the tick.
					var tickers = Object.keys(totals.manualBy[t]);
					goals.push({
						label: String(metaGoals[g].label || 'Manual tick'),
						target: 1,
						total: tickers.length ? 1 : 0,
						by: tickers.length ? 'ticked by ' + tickers.join(', ') : ''
					});
					continue;
				}
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
				status = isPending(status) ? 'Pending' : status;
				requests.push({
					when: String(requestValues[r][0]).slice(0, 10),
					player: String(requestValues[r][2]),
					// The cell may carry "3 - <label>"; the portal only needs the number
					// (it renders the label from the board itself).
					tile: String(parseInt(requestValues[r][3], 10) || requestValues[r][3]),
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
		+ 'body{font-family:sans-serif;background:#282828;color:#ddd;max-width:1100px;margin:0 auto;padding:16px}'
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
		+ '[gi===0?cellText(t,i):"",g.label,g.target?g.total+" / "+g.target:"",g.by||""]'
		+ '.forEach(function(v){var td=document.createElement("td");td.textContent=v;tr.appendChild(td);});'
		+ 'goals.appendChild(tr);});});\n'
		+ 'var reqs=el("reqs").tBodies[0];reqs.innerHTML="";'
		+ 'b.requests.forEach(function(q){var tr=document.createElement("tr");'
		+ 'var rt=b.tiles[Number(q.tile)-1];'
		+ '[q.when,q.player,rt?cellText(rt,Number(q.tile)-1):q.tile,q.what].forEach(function(v){'
		+ 'var td=document.createElement("td");td.textContent=v;tr.appendChild(td);});'
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
		if (!isTeamMember(board, payload.player))
		{
			throw new Error('Pick your name from the list. Only players who have synced to this team can request credit.');
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
function respond(board, rows, removed, teams, scores)
{
	var members = {};
	removed = removed || removedFor(board);
	var epoch = storeEpoch();
	for (var key in rows)
	{
		var row = rows[key];
		// A hand-added Removed row evicts even when the store row wasn't deleted yet.
		if (row.board === board && /^[0-9a-f]{16}$/.test(row.member) && !removed[row.member])
		{
			members[row.member] = { name: row.name, tiles: parseJson(row.data, {}) };
		}
	}
	var credited = buildAdjustmentMembers(board, cachedMeta(board, epoch));
	for (var id in credited)
	{
		members[id] = credited[id];
	}
	return ContentService
		.createTextOutput(JSON.stringify({ board: board, members: members,
			teams: teams || readTeamRows(), removed: Object.keys(removed),
			pollSeconds: readPollInterval(), epoch: epoch,
			standings: standingsFor(board, scores) }))
		.setMimeType(ContentService.MimeType.JSON);
}

/** The Scores tab read once, for upsertScore and standingsFor to share. */
function readScores()
{
	var sheet = getSheet(SCORES_SHEET, SCORES_HEADERS);
	return { sheet: sheet, values: sheet.getDataRange().getValues() };
}

function upsertScore(board, points, scores)
{
	scores = scores || readScores();
	for (var i = 1; i < scores.values.length; i++)
	{
		if (String(scores.values[i][0]) === board)
		{
			if (Number(scores.values[i][1]) === points)
			{
				return; // most polls change nothing - skip the write entirely
			}
			scores.sheet.getRange(i + 1, 2, 1, 2).setValues([[points, new Date().toISOString()]]);
			scores.values[i][1] = points;
			return;
		}
	}
	var range = scores.sheet.getRange(scores.sheet.getLastRow() + 1, 1, 1, 3);
	range.setNumberFormat('@');
	range.setValues([[board, points, new Date().toISOString()]]);
	scores.values.push([board, points, '']);
}

/** Latest points per team on this board scope's board, best first (Scores tab). */
function standingsFor(board, scores)
{
	var at = board.lastIndexOf('_');
	if (at < 0)
	{
		return [];
	}
	var prefix = board.substring(0, at + 1);
	var values = (scores || readScores()).values;
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
	return cachedConfig('teams', loadTeamRows);
}

/** A Teams tab code as the plugin normalizes team codes. */
function teamCodeOf(cell)
{
	return String(cell || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-+|-+$)/g, '');
}

function loadTeamRows()
{
	var values = getSheet(TEAMS_SHEET, TEAMS_HEADERS).getDataRange().getValues();
	var teams = [];
	for (var i = 1; i < values.length; i++)
	{
		var code = teamCodeOf(values[i][0]);
		if (code)
		{
			teams.push({ code: code, name: String(values[i][1] || '').trim() });
		}
	}
	return teams;
}

/**
 * The Teams tab plus, per team, the member display names stored under the given board
 * key (players who left are filtered out). Without a board key - the client has not
 * imported a board yet - names are collected from every board scope of that team.
 */
function teamsWithMembers(boardKey)
{
	var teams = readTeamRows();
	if (!teams.length)
	{
		return teams;
	}
	var rows = readRows(getSheet(STORE_SHEET, STORE_HEADERS));
	var marks = readDepartures().marks;
	for (var i = 0; i < teams.length; i++)
	{
		var suffix = '_' + teams[i].code;
		var names = [];
		for (var key in rows)
		{
			var row = rows[key];
			var inScope = boardKey
				? row.board === boardKey + suffix
				: row.board.length > suffix.length
					&& row.board.lastIndexOf(suffix) === row.board.length - suffix.length;
			if (!inScope || marks[row.board + '|' + row.member])
			{
				continue;
			}
			var name = row.name || row.member;
			if (names.indexOf(name) < 0)
			{
				names.push(name);
			}
		}
		names.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
		teams[i].members = names;
	}
	return teams;
}

/** Whether a player name belongs to someone who has synced to this board's team. */
function isTeamMember(board, player)
{
	var at = board.lastIndexOf('_');
	var name = cleanPlayerName(player).toLowerCase();
	if (at < 0 || !name)
	{
		return false;
	}
	var code = board.substring(at + 1);
	var teams = teamsWithMembers(board.substring(0, at));
	for (var i = 0; i < teams.length; i++)
	{
		if (teams[i].code === code)
		{
			for (var j = 0; j < (teams[i].members || []).length; j++)
			{
				if (String(teams[i].members[j]).toLowerCase() === name)
				{
					return true;
				}
			}
		}
	}
	return false;
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

/**
 * The Removed tab in one read: marks ("board|member" -> true) and, for the "left"
 * marks a rejoin may clear, their sheet row numbers.
 */
function readDepartures()
{
	var values = getSheet(REMOVED_SHEET, REMOVED_HEADERS).getDataRange().getValues();
	var marks = {};
	var leftRows = {};
	for (var i = 1; i < values.length; i++)
	{
		var scope = String(values[i][0] || '');
		var member = String(values[i][1] || '');
		if (scope && member)
		{
			var key = scope + '|' + member;
			marks[key] = true;
			if (String(values[i][3] || '').trim() === 'left')
			{
				(leftRows[key] = leftRows[key] || []).push(i + 1);
			}
		}
	}
	return { marks: marks, leftRows: leftRows };
}

/**
 * Member ids that left this board scope; their data is kept but stops counting.
 * Pass preloaded readDepartures().marks marks to avoid re-reading the Removed tab.
 */
function removedFor(board, marks)
{
	marks = marks || readDepartures().marks;
	var removed = {};
	var prefix = board + '|';
	for (var key in marks)
	{
		if (key.indexOf(prefix) === 0)
		{
			removed[key.substring(prefix.length)] = true;
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
	var player = cleanPlayerName(request.player);
	var tile = parseInt(request.tile, 10);
	var goal = request.goal == null || request.goal === '' ? '' : parseInt(request.goal, 10);
	var add = request.add == null || request.add === '' ? '' : Number(request.add);
	var complete = request.complete === true ? 'yes' : '';
	var note = String(request.note || '').slice(0, 300);
	var links = cleanProofLinks(request.links);
	if ((!fromForm && !/^[0-9a-f]{16}$/.test(member)) || !player || isNaN(tile) || tile < 1
		|| (add === '' && !complete) || (add !== '' && !(isFinite(add) && add > 0))
		|| (goal !== '' && (isNaN(goal) || goal < 1)))
	{
		return 0;
	}
	// The tile and goal must exist on the board, or the approval would land nowhere.
	var meta = cachedMeta(board);
	if (meta && meta.tiles && (tile > meta.tiles.length
		|| (goal !== '' && goal > (meta.tiles[tile - 1].goals || []).length)))
	{
		return 0;
	}
	var team = teamOf(board);
	// The Tile cell carries the label too ("3 - Manual me baby"): admins reviewing the
	// tab shouldn't need the board open. Every reader parseInt()s the leading number.
	var tileCell = String(tile);
	if (meta && meta.tiles && meta.tiles[tile - 1] && meta.tiles[tile - 1].label)
	{
		tileCell = tile + ' - ' + meta.tiles[tile - 1].label;
	}
	var sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
	var values = sheet.getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		// A retried send must not stack duplicate pending rows.
		if (isPending(values[i][9]) && String(values[i][8]) === member
			&& String(values[i][2]) === player
			&& String(values[i][1]) === team && parseInt(values[i][3], 10) === tile
			&& String(values[i][4]) === String(goal) && String(values[i][5]) === String(add)
			&& String(values[i][6]) === complete && String(values[i][7]) === note)
		{
			return 0;
		}
	}
	var row = sheet.getLastRow() + 1;
	var range = sheet.getRange(row, 1, 1, REQUESTS_HEADERS.length);
	range.setNumberFormat('@');
	range.setValues([[new Date().toISOString(), team, player, tileCell, goal, add, complete,
		note, member, 'Pending', links, newRequestId()]]);
	styleStatusCell(sheet, row, 'Pending');
	return row;
}

/**
 * A request's identity for its ledger rows. Row numbers are not identities: admins
 * sort and delete rows, and the next request would inherit an old row's approval.
 */
function newRequestId()
{
	return 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
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

/**
 * Runs an admin action under the same lock player syncs take, so neither overwrites
 * the other's rows from a stale read. Returns null when the store stayed busy.
 */
function withStoreLock(waitMs, action)
{
	var lock = LockService.getScriptLock();
	if (!lock.tryLock(waitMs))
	{
		return null;
	}
	try
	{
		return { value: action() };
	}
	finally
	{
		lock.releaseLock();
	}
}

var STORE_BUSY_MESSAGE = 'The store is busy with player syncs. Try again in a few seconds.';

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
	var result = withStoreLock(30000, function () { return resolveRequests(rows, approve); });
	if (!result)
	{
		SpreadsheetApp.getUi().alert(STORE_BUSY_MESSAGE);
		return;
	}
	var done = result.value;
	flushWebhookQueue();
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
 * writes the Adjustments ledger row exactly once: a "request <id>" tag in the note
 * guards against double-crediting when the dropdown is flipped back and forth. Any
 * other status takes an existing approval back.
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
	var requestId = String(row[11] || '').trim();
	if (!String(row[2] || '').trim() || !requestId)
	{
		return false;
	}
	if (status === 'Done' && !adjustmentExistsForRequest(requestId))
	{
		// The announcement's before/after diff around the ledger write tells whether
		// this approval finished the tile, and which bingo lines it completed.
		var scope = latestBoardForTeam(String(row[1] || '').trim().toLowerCase());
		var tileIndex = parseInt(row[3], 10) - 1;
		var doneBefore = scope ? tileTotals(scope.board, scope.meta).done.slice() : null;
		getSheet(ADJ_SHEET, ADJ_HEADERS).appendRow([row[1], row[3], row[4], cleanCellText(row[2]),
			row[5], row[6], 'request ' + requestId + ': ' + row[7], 'approved request']);
		announceApproval(row, scope, tileIndex, doneBefore);
	}
	else if (status !== 'Done' && removeAdjustmentForRequest(requestId))
	{
		// An approval flipped to Rejected (or back to Pending) takes its credit back: the
		// tagged ledger row is removed, and clients drop the credit on their next sync.
		// Flipping back to Done re-credits (and re-announces) cleanly.
		announceWithdrawal(row, latestBoardForTeam(String(row[1] || '').trim().toLowerCase()));
	}
	styleStatusCell(sheet, rowNumber, status);
	return true;
}

/** Deletes the ledger row(s) a request's approval wrote. Returns whether any existed. */
function removeAdjustmentForRequest(requestId)
{
	var sheet = getSheet(ADJ_SHEET, ADJ_HEADERS);
	var values = sheet.getDataRange().getValues();
	var tag = 'request ' + requestId + ':';
	var removed = false;
	for (var i = values.length - 1; i >= 1; i--)
	{
		if (String(values[i][6] || '').indexOf(tag) === 0)
		{
			sheet.deleteRow(i + 1);
			removed = true;
		}
	}
	return removed;
}

/** Tells the team's webhook that an announced approval no longer stands. */
function announceWithdrawal(row, scope)
{
	try
	{
		var team = teamInfoFor(String(row[1] || '').trim().toLowerCase());
		if (!team || !team.webhook)
		{
			return;
		}
		sendOrQueueWebhook(team.webhook,
			':no_entry: Credit approval withdrawn: ' + requestSummary(row, scope)
				+ noteAndProofLines(row));
	}
	catch (err)
	{
		console.error('Withdrawal announcement failed: ' + err);
	}
}

/** The most recently updated board scope for a team, with its meta, or null. */
function latestBoardForTeam(team)
{
	var values = getSheet(META_SHEET, META_HEADERS).getDataRange().getValues();
	var best = null;
	for (var i = 1; i < values.length; i++)
	{
		var key = String(values[i][0] || '');
		var meta = parseJson(values[i][2], null);
		if (teamOf(key) !== team || !meta || !meta.tiles)
		{
			continue;
		}
		var updated = String(values[i][1] || '');
		if (!best || updated > best.updated)
		{
			best = { board: key, meta: meta, updated: updated };
		}
	}
	return best;
}

/** The tile's plain label - the sheet cell carries "N - label" for the admins only. */
function tileLabelOf(row, scope, tileIndex)
{
	if (scope && scope.meta.tiles[tileIndex] && scope.meta.tiles[tileIndex].label)
	{
		return String(scope.meta.tiles[tileIndex].label);
	}
	return String(row[3] || '').replace(/^\d+\s*-\s*/, '');
}

/** Completed bingo lines in a done[] array; mirrors the plugin's counting. */
function linesInDone(meta, done)
{
	var size = meta.size || Math.round(Math.sqrt(meta.tiles.length));
	var lines = 0;
	for (var r = 0; r < size; r++)
	{
		var rowDone = true;
		var colDone = true;
		for (var c = 0; c < size; c++)
		{
			rowDone = rowDone && !!done[r * size + c];
			colDone = colDone && !!done[c * size + r];
		}
		lines += (rowDone ? 1 : 0) + (colDone ? 1 : 0);
	}
	if (meta.diagonals === false)
	{
		return lines;
	}
	var diag = true;
	var anti = true;
	for (var i = 0; i < size; i++)
	{
		diag = diag && !!done[i * size + i];
		anti = anti && !!done[i * size + (size - 1 - i)];
	}
	return lines + (diag ? 1 : 0) + (anti ? 1 : 0);
}

/** The plugin's line/blackout bonus message for a done[] transition, or ''. */
function bonusLineFor(meta, doneBefore, doneAfter)
{
	var total = meta.tiles.length;
	var beforeCount = 0;
	var afterCount = 0;
	for (var i = 0; i < total; i++)
	{
		beforeCount += doneBefore[i] ? 1 : 0;
		afterCount += doneAfter[i] ? 1 : 0;
	}
	// A blackout finishes lines too - announce both, lines first (like the plugin).
	var text = '';
	var gained = linesInDone(meta, doneAfter) - linesInDone(meta, doneBefore);
	if (gained > 0)
	{
		var linePts = Number(meta.linePoints || 0);
		text = 'Bingo! ' + (gained === 1 ? 'Line complete' : gained + ' lines complete')
			+ (linePts > 0 ? ' (+' + (gained * linePts) + ' pts)' : '');
	}
	if (afterCount === total && beforeCount < total)
	{
		var blackoutPts = Number(meta.blackoutPoints || 0);
		text += (text ? ' - ' : '') + 'BLACKOUT! Every tile complete'
			+ (blackoutPts > 0 ? ' (+' + blackoutPts + ' pts)' : '');
	}
	return text;
}

/** The team's row on the Teams tab: { webhook, name }, or null. */
function teamInfoFor(teamCode)
{
	var values = getSheet(TEAMS_SHEET, TEAMS_HEADERS).getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		var code = teamCodeOf(values[i][0]);
		if (code && code === teamCode)
		{
			var url = String(values[i][2] || '').trim();
			return {
				webhook: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url) ? url : '',
				name: String(values[i][1] || '').trim()
			};
		}
	}
	return null;
}

/**
 * Announces a freshly approved request on the team's Discord webhook, proof links
 * included. When the approval finishes the tile, the announcement mirrors the plugin's
 * completion post (the proof link stands in for the screenshot), so verified tiles get
 * the same moment in the channel as tracked ones. Requires the Webhook column on the
 * Teams tab; without it nothing is sent. Never throws - Discord being down must not
 * block the approval itself.
 */
function announceApproval(row, scope, tileIndex, doneBefore)
{
	try
	{
		var team = teamInfoFor(String(row[1] || '').trim().toLowerCase());
		if (!team || !team.webhook)
		{
			return;
		}
		var teamName = team.name || String(row[1] || '');
		var doneAfter = scope ? tileTotals(scope.board, scope.meta).done : null;
		var newlyDone = doneBefore && doneAfter && tileIndex >= 0
			&& tileIndex < scope.meta.tiles.length
			&& doneAfter[tileIndex] && !doneBefore[tileIndex];
		var content;
		if (newlyDone)
		{
			var doneCount = 0;
			for (var t = 0; t < scope.meta.tiles.length; t++)
			{
				doneCount += doneAfter[t] ? 1 : 0;
			}
			content = ':tada: **' + row[2] + '** completed **' + tileLabelOf(row, scope, tileIndex)
				+ '** (admin verified) for team **' + teamName + '**'
				+ '\n' + (scope.meta.name || 'Bingo board') + ': '
				+ doneCount + '/' + scope.meta.tiles.length + ' tiles'
				+ '\nCredit: ' + creditText(row, scope);
			var bonus = bonusLineFor(scope.meta, doneBefore, doneAfter);
			if (bonus)
			{
				content += '\n:sparkles: ' + bonus;
			}
		}
		else
		{
			content = ':white_check_mark: Credit approved: ' + requestSummary(row, scope);
		}
		sendOrQueueWebhook(team.webhook, content + noteAndProofLines(row));
	}
	catch (err)
	{
		console.error('Approval announcement failed: ' + err);
	}
}

/** "+40 on goal 1 (Kills: Man)", or "tile complete". */
function creditText(row, scope)
{
	var what = row[6] ? 'tile complete' : '+' + row[5];
	var g = parseInt(row[4], 10);
	if (isNaN(g) || g < 1)
	{
		return what;
	}
	var label = '';
	var t = parseInt(row[3], 10) - 1;
	if (scope && scope.meta.tiles[t] && (scope.meta.tiles[t].goals || [])[g - 1])
	{
		label = String(scope.meta.tiles[t].goals[g - 1].label || '');
	}
	return what + ' on goal ' + g + (label ? ' (' + label + ')' : '');
}

/** "**Alice** - 10 kills (+40 on goal 1 (Kills: Man))" - who asked for what. */
function requestSummary(row, scope)
{
	return '**' + row[2] + '** - ' + tileLabelOf(row, scope, parseInt(row[3], 10) - 1)
		+ ' (' + creditText(row, scope) + ')';
}

/** The request's note and proof-link lines, appended to every announcement. */
function noteAndProofLines(row)
{
	var lines = '';
	if (String(row[7] || '').trim())
	{
		lines += '\n' + row[7];
	}
	if (String(row[10] || '').trim())
	{
		lines += '\nProof: ' + String(row[10]).trim().split('\n').join('  ');
	}
	return lines;
}

/**
 * Sends a webhook message, or parks it when this context may not call out. Google
 * forbids external requests inside simple triggers (the Status dropdown's onEdit), so
 * those messages queue and the next full-auth entry point - a client sync, or a menu
 * action - delivers them. The queue is capped; announcements are best-effort.
 */
function sendOrQueueWebhook(webhook, content)
{
	if (!postWebhook(webhook, content))
	{
		// Callers hold the store lock (the Status dropdown, the menu), so this
		// read-modify-write of the queue cannot interleave with another one.
		enqueueWebhooks([{ webhook: webhook, content: content }]);
	}
}

/**
 * Posts one message. Player text (names, notes) can never ping: mentions are off.
 * @return true when Discord took it, or refused it for good (a broken webhook would
 *     otherwise retry forever); false when it should be retried later
 */
function postWebhook(webhook, content)
{
	try
	{
		var code = UrlFetchApp.fetch(webhook, {
			method: 'post',
			contentType: 'application/json',
			payload: JSON.stringify({ content: content, allowed_mentions: { parse: [] } }),
			muteHttpExceptions: true
		}).getResponseCode();
		return code !== 429 && code < 500;
	}
	catch (err)
	{
		return false; // no external requests in this context, or Discord unreachable
	}
}

function enqueueWebhooks(messages)
{
	var props = PropertiesService.getScriptProperties();
	var queue = parseJson(props.getProperty('webhookQueue') || '[]', []);
	props.setProperty('webhookQueue', JSON.stringify(queue.concat(messages).slice(-20)));
}

/**
 * Delivers parked webhook messages. Call only from full-auth contexts, and never while
 * holding the store lock: it takes the lock itself, only to move the queue, and posts
 * outside it. Messages Discord did not take go back on the queue for the next flush.
 */
function flushWebhookQueue()
{
	try
	{
		var taken = withStoreLock(5000, function ()
		{
			var props = PropertiesService.getScriptProperties();
			var raw = props.getProperty('webhookQueue');
			if (raw)
			{
				props.deleteProperty('webhookQueue');
			}
			return parseJson(raw || '[]', []);
		});
		var queue = taken ? taken.value : [];
		var failed = [];
		for (var i = 0; i < queue.length; i++)
		{
			if (!postWebhook(queue[i].webhook, queue[i].content))
			{
				failed.push(queue[i]);
			}
		}
		if (failed.length)
		{
			withStoreLock(5000, function () { enqueueWebhooks(failed); });
		}
	}
	catch (err)
	{
		console.error('Webhook queue flush failed: ' + err);
	}
}

function adjustmentExistsForRequest(requestId)
{
	var values = getSheet(ADJ_SHEET, ADJ_HEADERS).getDataRange().getValues();
	var tag = 'request ' + requestId + ':';
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
 * their row there is tombstoned "left" and parked, so stale relays can't restore it.
 */
function moveMemberIfElsewhere(board, memberId, rows, departures, deferRefresh)
{
	var prefix = boardPrefix(board);
	if (!prefix)
	{
		return;
	}
	for (var key in rows)
	{
		var row = rows[key];
		if (row.member === memberId && row.board !== board && row.board.indexOf(prefix) === 0)
		{
			removeMembers(row.board, [memberId], departures, deferRefresh);
		}
	}
}

/**
 * Clears "left" tombstones for a member rejoining this scope (admin rows untouched).
 * Nothing to clear is the usual case and costs no sheet call.
 * @return the departures, re-read when rows were deleted
 */
function clearLeftTombstones(board, memberId, departures)
{
	var rowNumbers = departures.leftRows[board + '|' + memberId];
	if (!rowNumbers || !rowNumbers.length)
	{
		return departures;
	}
	var sheet = getSheet(REMOVED_SHEET, REMOVED_HEADERS);
	for (var i = rowNumbers.length - 1; i >= 0; i--)
	{
		sheet.deleteRow(rowNumbers[i]);
	}
	return readDepartures();
}

/**
 * Marks members as gone from this team scope. Their store row is deliberately KEPT: it
 * stops counting the moment the mark exists (every reader filters on it), and if the same
 * person comes back their progress on this team comes back with them - the rejoin clears
 * the mark. Nothing they do meanwhile is accepted into this scope.
 */
function removeMembers(board, ids, departures, deferRefresh)
{
	if (!ids.length)
	{
		return;
	}
	departures = departures || readDepartures();
	var removedSheet = getSheet(REMOVED_SHEET, REMOVED_HEADERS);
	var existing = removedFor(board, departures.marks);
	var marked = 0;
	for (var i = 0; i < ids.length; i++)
	{
		var id = String(ids[i]);
		if (!/^[0-9a-f]{16}$/.test(id) || existing[id])
		{
			continue;
		}
		// Explicit text format: an all-digit id would otherwise be float-mangled.
		// Reason "left" marks a self-eviction (player switched teams) - the only
		// kind a later rejoin may clear. Hand-added rows have no reason and stick.
		var range = removedSheet.getRange(removedSheet.getLastRow() + 1, 1, 1, 4);
		range.setNumberFormat('@');
		range.setValues([[board, id, new Date().toISOString(), 'left']]);
		existing[id] = true;
		departures.marks[board + '|' + id] = true;
		marked++;
	}
	if (marked && deferRefresh)
	{
		// Rendered after the sync lock is released, like every other Board tab render.
		deferRefresh(board, true);
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
function refreshBoardView(board, meta)
{
	meta = meta || cachedMeta(board);
	var sheet = getSheet(boardTabName(board), null);
	sheet.clear();

	if (!meta || !meta.tiles)
	{
		sheet.getRange(1, 1).setValue(
			'Waiting for a board. Any player with "Sync via team store" enabled sends it automatically.');
		return;
	}

	// One read per tab for the whole render; tileTotals and lastSyncLine share them.
	var rows = readRows(getSheet(STORE_SHEET, STORE_HEADERS));
	var removed = removedFor(board);
	var totals = tileTotals(board, meta, rows, removed);
	var size = meta.size || Math.round(Math.sqrt(meta.tiles.length));
	sheet.getRange(1, 1).setValue(meta.name || 'Bingo board').setFontWeight('bold').setFontSize(14);
	sheet.getRange(2, 1).setValue('Team: ' + (teamOf(board) || '-') + '   ·   updated ' + new Date().toISOString());
	sheet.getRange(3, 1).setValue(lastSyncLine(board, rows, removed));

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

/**
 * One line naming each member and when their client last reached the store - the first
 * thing to check when someone says their progress is not syncing.
 */
function lastSyncLine(board, rows, removed)
{
	rows = rows || readRows(getSheet(STORE_SHEET, STORE_HEADERS));
	removed = removed || removedFor(board);
	var parts = [];
	for (var key in rows)
	{
		var row = rows[key];
		if (row.board === board && /^[0-9a-f]{16}$/.test(row.member) && !removed[row.member])
		{
			parts.push((row.name || row.member) + ' ' + row.updated.replace('T', ' ').substring(0, 16));
		}
	}
	parts.sort();
	return parts.length ? 'Last sync (UTC): ' + parts.join('   ·   ') : 'No members have synced yet.';
}

/** Per-tile, per-goal totals from stored players and from admin credit. */
function tileTotals(board, meta, rows, removed)
{
	rows = rows || readRows(getSheet(STORE_SHEET, STORE_HEADERS));
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
				// The plain counter always adds up. On a distinct goal it carries admin
				// credit, which has no item names - the plugin counts names + counter too.
				var amount = Number(goals[g].n || 0);
				into[index][g] += amount;
				if (goalMeta.distinct && matched && matched.length)
				{
					// Distinct goals count different items once across the whole team.
					for (var m = 0; m < matched.length; m++)
					{
						distinctSets[index][g][String(matched[m]).toLowerCase()] = true;
					}
					amount += matched.length;
				}
				if (amount > 0)
				{
					contrib[index][g][playerName] = (contrib[index][g][playerName] || 0) + amount;
				}
			}
		}
	}

	var removedIds = removed || removedFor(board);
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
		done.push(tileReached(meta.tiles[t3], tracked[t3], verified[t3]));
	}
	return { tracked: tracked, verified: verified, done: done, verifiedManual: verifiedManual,
		contrib: contrib, manualBy: manualBy };
}

/**
 * The plugin's completion rule (BingoTile.isComplete), so the store, the portal and
 * the announcements agree with the game: a manual goal never completes by count, an
 * ALL tile with a manual goal needs the tick, and an ANY tile needs one counted goal.
 */
function tileReached(tileMeta, tracked, verified)
{
	var goalsMeta = tileMeta.goals || [];
	var anyMode = tileMeta.mode === 'ANY';
	var sawManual = false;
	for (var g = 0; g < goalsMeta.length; g++)
	{
		if (goalsMeta[g].manual)
		{
			sawManual = true;
			continue;
		}
		var target = Number(goalsMeta[g].target || 0);
		var reached = target > 0 && (tracked[g] + verified[g]) >= target;
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

/**
 * Stores the board definition. Returns whether it changed; the caller refreshes the
 * views AFTER the whole request lands - rendering from here would show the store as it
 * was before this request's own progress rows were written, and the render throttle
 * would then swallow the up-to-date pass.
 */
function saveMeta(board, meta)
{
	var json = JSON.stringify(meta);
	var known = cachedMeta(board);
	if (known && JSON.stringify(known) === json)
	{
		return false; // unchanged: the usual case once per client session
	}
	var sheet = getSheet(META_SHEET, META_HEADERS);
	var values = sheet.getDataRange().getValues();
	try
	{
		CacheService.getScriptCache().put('meta_' + storeEpoch() + '_' + board, json, 21600);
	}
	catch (err)
	{
		// Too big for the cache - readers fall back to this sheet.
	}
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0]) === board)
		{
			if (String(values[i][2]) === json)
			{
				return false;
			}
			sheet.getRange(i + 1, 1, 1, 3).setValues([[board, new Date().toISOString(), json]]);
			return true;
		}
	}
	sheet.appendRow([board, new Date().toISOString(), json]);
	return true;
}

/**
 * readMeta through the script cache. Safe because saveMeta is the ONLY writer and
 * writes through, and the epoch in the key orphans every entry when the host resets
 * the store. A cache miss (eviction, size cap) just falls back to the sheet.
 */
function cachedMeta(board, epoch)
{
	var key = 'meta_' + (epoch || storeEpoch()) + '_' + board;
	var cache = CacheService.getScriptCache();
	var hit = cache.get(key);
	if (hit !== null)
	{
		return hit === '' ? null : parseJson(hit, null);
	}
	var meta = readMeta(board);
	try
	{
		// Caching "no board yet" as '' is safe: that state only changes via saveMeta.
		cache.put(key, meta ? JSON.stringify(meta) : '', 21600);
	}
	catch (err)
	{
		// Over the cache's size cap - just serve from the sheet every time.
	}
	return meta;
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

/** This store's generation, starting at 1 and bumped by every Reset store data. */
function storeEpoch()
{
	return cachedConfig('epoch', function ()
	{
		var props = PropertiesService.getScriptProperties();
		var epoch = Number(props.getProperty(EPOCH_PROP) || 0);
		if (!epoch)
		{
			epoch = 1;
			props.setProperty(EPOCH_PROP, String(epoch));
		}
		return epoch;
	});
}

/** A rarely-changing value through the script cache (see CONFIG_CACHE_SECONDS). */
function cachedConfig(name, load)
{
	if (CONFIG_CACHE_SECONDS <= 0)
	{
		return load();
	}
	var cache = CacheService.getScriptCache();
	var hit = cache.get('cfg_' + name);
	if (hit !== null)
	{
		return JSON.parse(hit);
	}
	var value = load();
	try
	{
		cache.put('cfg_' + name, JSON.stringify(value), CONFIG_CACHE_SECONDS);
	}
	catch (err)
	{
		// Too big for the cache (a huge board code): read the sheet every time.
	}
	return value;
}

/** Drops the cached config, so the next read sees the sheet as it is now. */
function clearConfigCache()
{
	var cache = CacheService.getScriptCache();
	['teams', 'boardCode', 'poll', 'epoch', 'reconciled'].forEach(function (name)
	{
		cache.remove('cfg_' + name);
	});
}

// ---------------------------------------------------------------- sheet plumbing

function maybeRefreshViews(board, force)
{
	// Only host-listed teams get a Board tab. A client still carrying last event's team
	// code is rejected by the sync gate, but side paths (a departure mark, Refresh board
	// view over old Meta rows) reach here too and must not spawn tabs for junk codes.
	// The throttle lives in the cache: Properties have a daily quota that a busy event's
	// syncs would eat, and a lost throttle entry only costs one extra render.
	var cache = CacheService.getScriptCache();
	var last = Number(cache.get('lastRefresh_' + board) || 0);
	if (!force && Date.now() - last < REFRESH_THROTTLE_MS)
	{
		return;
	}
	var team = teamOf(board);
	if (team && team !== 'solo' && !hasTeam(readTeamRows(), team))
	{
		return;
	}
	cache.put('lastRefresh_' + board, String(Date.now()), 21600);
	try
	{
		var meta = cachedMeta(board);
		annotateAdjustments(meta);
		refreshBoardView(board, meta);
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
			// Discoverable knobs, one per row, prefilled with the plugin's defaults.
			sheet.appendRow(['Poll interval (seconds)', 120, 'How often each client syncs, in seconds. 60 to 900 - values outside that are clamped, blank uses 120.']);
			// Apps Script cannot reliably learn its own /exec URL (getService().getUrl()
			// 404s for container-bound scripts), so the host pastes it here once.
			sheet.appendRow(['Portal URL (web app /exec)', '', 'Paste the /exec URL of this deployment so the Irons Pub Bingo menu can open the portal.']);
			sheet.setColumnWidth(1, 200);
			sheet.setColumnWidth(3, 460);
			sheet.getRange(2, 3, 2, 1).setFontColor('#888888');
		}
		if (HIDDEN_SHEETS.indexOf(name) >= 0)
		{
			sheet.hideSheet();
		}
	}
	return sheet;
}

/**
 * The board code the host pasted onto the Board code tab, so players with the store URL
 * can load the board without being sent the code separately. Multi-line pastes land one
 * line per row; everything under the instruction row is joined back together and
 * trimmed. '' when the tab is empty.
 */
function readBoardCode()
{
	return cachedConfig('boardCode', loadBoardCode);
}

function loadBoardCode()
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

/**
 * Host-tuned seconds between a client's store polls (Settings tab). 0 = not set, which
 * leaves the plugin on its 120 second default; other values are clamped to 60-900.
 */
function readPollInterval()
{
	return cachedConfig('poll', loadPollInterval);
}

function loadPollInterval()
{
	var values = getSheet(SETTINGS_SHEET, SETTINGS_HEADERS).getDataRange().getValues();
	for (var i = 1; i < values.length; i++)
	{
		if (String(values[i][0] || '').toLowerCase().indexOf('poll') >= 0)
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
			updated: String(values[i][3] || ''),
			data: String(values[i][4] || ''),
			key: String(values[i][5] || '')
		};
	}
	return rows;
}

function writeStoreRow(sheet, rows, key, board, memberId, name, tiles, keyHash)
{
	var updated = new Date().toISOString();
	var data = JSON.stringify(tiles);
	var row = rows[key];
	var rowIndex = row ? row.rowIndex : sheet.getLastRow() + 1;
	var memberKey = (row && row.key) || keyHash || '';
	var range = sheet.getRange(rowIndex, 1, 1, 6);
	// Force plain-text cells: account ids are long hex strings and Sheets would otherwise
	// coerce anything numeric-looking, mangling the member key.
	range.setNumberFormat('@');
	range.setValues([[board, memberId, name, updated, data, memberKey]]);
	// Keep the in-memory map current: respond() reuses it instead of re-reading the tab.
	rows[key] = { rowIndex: rowIndex, board: board, member: memberId,
		name: name, updated: updated, data: data, key: memberKey };
}

/** What the sheet keeps of a member key: a hash, so admins reading it can't sign as them. */
function memberKeyHash(memberKey)
{
	var raw = String(memberKey || '');
	return /^[0-9a-f]{64}$/.test(raw) ? sha256Hex('member-key:' + raw).slice(0, 32) : '';
}

/**
 * Whether a request carrying this key hash may act for the member: every row of theirs
 * that has a key must have this one. A request without a key acts for nobody. Clearing
 * a row's key cell (hidden Store tab) lets the member's next sync claim it again, for a
 * player who somehow got locked out.
 */
function ownsMember(rows, memberId, keyHash)
{
	if (!keyHash || !/^[0-9a-f]{16}$/.test(memberId))
	{
		return false;
	}
	for (var k in rows)
	{
		if (rows[k].member === memberId && rows[k].key && rows[k].key !== keyHash)
		{
			return false;
		}
	}
	return true;
}

/**
 * Text that ends up in sheet cells must never start a formula: a player name such as
 * =IMPORTDATA(...) would run in the host's spreadsheet. Names are trimmed and capped.
 */
function cleanPlayerName(name)
{
	return String(name || '').replace(/^[\s=+\-@]+/, '').trim().slice(0, 40);
}

function cleanCellText(text)
{
	var value = String(text == null ? '' : text);
	return /^[=+\-@]/.test(value) ? "'" + value : value;
}

/** A client's board summary (no official board code pasted), with its text made safe. */
function cleanClientMeta(meta)
{
	var clean = JSON.parse(JSON.stringify(meta || {}));
	clean.name = cleanCellText(clean.name);
	var tiles = clean.tiles || [];
	for (var t = 0; t < tiles.length; t++)
	{
		tiles[t].label = cleanCellText(tiles[t].label);
		var goals = tiles[t].goals || [];
		for (var g = 0; g < goals.length; g++)
		{
			goals[g].label = cleanCellText(goals[g].label);
		}
	}
	return clean;
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
		.addItem('Apply pasted board update', 'applyBoardUpdate')
		.addItem('Reset a tile\'s progress...', 'resetTilePrompt')
		.addItem('Reset store data...', 'resetStoreData')
		.addToUi();
}

/**
 * Menu action: applies a freshly pasted board code right now, without waiting for the
 * next client poll - the same reconciliation, just on demand, with a report.
 */
function applyBoardUpdate()
{
	var result = withStoreLock(30000, function ()
	{
		var code = readBoardCode();
		return reconcileBoardCode(code, code ? sha256Hex(code) : null);
	});
	SpreadsheetApp.getUi().alert(result ? result.value : STORE_BUSY_MESSAGE);
}

/**
 * Runs whenever the pasted board code changed: cross-references the new tiles against
 * the previous code and wipes every member's stored progress on tiles that now TRACK
 * something else - the store-wide twin of the plugin's per-tile signature reset, so a
 * host editing a live board never leaves stale counts leaking into new goals. Tiles
 * that only changed labels, points or targets keep their progress.
 */
function reconcileBoardCode(canonicalCode, canonicalHash)
{
	if (!canonicalHash)
	{
		return 'No board code pasted on the Board code tab.';
	}
	var cache = CacheService.getScriptCache();
	var props = PropertiesService.getScriptProperties();
	if (cache.get('cfg_reconciled') === canonicalHash || props.getProperty('boardSigHash') === canonicalHash)
	{
		cache.put('cfg_reconciled', canonicalHash, 21600);
		return 'Board code unchanged since the last check - nothing to do.';
	}
	var parsed = parseJson(canonicalCode, null);
	if (!parsed || !parsed.tiles)
	{
		return 'The pasted board code does not parse - re-export it from Bingo Forge.';
	}
	var sigs = [];
	for (var t = 0; t < parsed.tiles.length; t++)
	{
		sigs.push(tileTrackingSignature(parsed.tiles[t]));
	}
	// The plugin's id normalization, so only THIS board's rows are ever touched.
	var id = normalizedBoardId(parsed);
	var previous = parseJson(props.getProperty('boardSigs') || 'null', null);
	// Every code hash seen for this id, newest last, so the sync gate can tell an
	// outdated client from a tampered one whatever version it reports.
	var hashes = previous && previous.id === id && previous.hashes ? previous.hashes : [];
	// The current code always sits last: re-pasting an earlier code makes it current
	// again, and the code it replaced becomes the outdated one.
	hashes = hashes.filter(function (h) { return h !== canonicalHash; });
	hashes.push(canonicalHash);
	hashes = hashes.slice(-30);
	props.setProperty('boardSigHash', canonicalHash);
	cache.put('cfg_reconciled', canonicalHash, 21600);
	props.setProperty('boardSigs', JSON.stringify({ id: id, sigs: sigs, hashes: hashes }));
	// The portal and Board tabs show the pasted board right away, not after the
	// first client that runs it happens to sync.
	seedMetaFromBoard(parsed, id);
	if (!previous || !previous.sigs || !id || previous.id !== id)
	{
		// First sighting, or a different board: its progress lives under other keys.
		return 'Board recorded. Nothing reset - a new (or first-seen) board starts fresh anyway.';
	}
	var changed = [];
	var names = [];
	for (var i = 0; i < sigs.length && i < previous.sigs.length; i++)
	{
		if (sigs[i] !== previous.sigs[i])
		{
			changed.push(i);
			names.push((i + 1) + ' - ' + (parsed.tiles[i].label || ''));
		}
	}
	if (!changed.length)
	{
		return 'Board updated. No tile changed what it tracks, so all progress is kept.';
	}
	var rowsTouched = wipeTilesForBoardId(id, changed);
	return 'Board updated. Reset ' + changed.length + ' re-tracked tile(s) on '
		+ rowsTouched + ' member row(s):\n' + names.join('\n');
}

/** Whether the hash belongs to an earlier paste of the current board (same id). */
function isEarlierBoardCode(hash)
{
	if (!hash)
	{
		return false;
	}
	var props = PropertiesService.getScriptProperties();
	var record = parseJson(props.getProperty('boardSigs') || 'null', null);
	var hashes = record && record.hashes ? record.hashes : [];
	return hash !== props.getProperty('boardSigHash') && hashes.indexOf(hash) >= 0;
}

/** The plugin's board id normalization; '' when the board has no id. */
function normalizedBoardId(parsed)
{
	return String(parsed.id == null ? '' : parsed.id).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
}

/**
 * Writes the board's Meta row for every listed team, straight from the pasted code -
 * the same summary a client sends on its first sync (names, targets, goal labels), so
 * the portal and Board tabs follow a board update the moment the host pastes it. Only
 * boards with an id have derivable scope keys; id-less boards wait for a client.
 */
function seedMetaFromBoard(parsed, id)
{
	if (!id || !parsed || !parsed.tiles)
	{
		return;
	}
	var meta = metaFromBoard(parsed);
	var teams = readTeamRows();
	for (var i = 0; i < teams.length; i++)
	{
		saveMeta('id_' + id + '_' + teams[i].code, meta);
	}
}

/** The store-side twin of the plugin's board summary (buildBoardMeta). */
function metaFromBoard(board)
{
	var tiles = board.tiles || [];
	var size = Number(board.size) > 0 ? Number(board.size) : Math.round(Math.sqrt(tiles.length));
	var meta = {
		name: board.name || '',
		size: size,
		diagonals: board.diagonals == null ? true : !!board.diagonals,
		linePoints: Math.max(0, Number(board.linePoints) || 0),
		blackoutPoints: Math.max(0, Number(board.blackoutPoints) || 0),
		tiles: []
	};
	for (var t = 0; t < tiles.length; t++)
	{
		var tile = tiles[t] || {};
		var goals = tile.goals && tile.goals.length ? tile.goals : [{ type: 'MANUAL' }];
		var goalMetas = [];
		for (var g = 0; g < goals.length; g++)
		{
			var goal = goals[g] || {};
			var type = String(goal.type || 'MANUAL').toUpperCase();
			goalMetas.push({
				label: goalShortLabel(goal, type),
				target: goalTarget(goal, type),
				distinct: goalUsesNames(goal, type),
				manual: type === 'MANUAL'
			});
		}
		meta.tiles.push({
			label: tile.label || ('Tile ' + (t + 1)),
			mode: String(tile.mode || 'ALL').toUpperCase() === 'ANY' ? 'ANY' : 'ALL',
			goals: goalMetas
		});
	}
	return meta;
}

function goalTarget(goal, type)
{
	if (type === 'XP')
	{
		return Number(goal.amount) || 0;
	}
	if (type === 'MANUAL')
	{
		return 1;
	}
	return goal.count == null ? 1 : Number(goal.count) || 1;
}

function goalUsesNames(goal, type)
{
	return ((type === 'DROP' || type === 'RAID_PURPLE') && !!goal.distinct)
		|| (type === 'PET' && !!(goal.pets && goal.pets.length));
}

// The label rules below mirror BingoGoal.describe()/shortDescribe() in the plugin.
var MAX_GOAL_LABEL = 46;

function goalShortLabel(goal, type)
{
	if (goal.name && String(goal.name).trim())
	{
		return String(goal.name).trim();
	}
	var full = goalDescribe(goal, type);
	if (full.length <= MAX_GOAL_LABEL)
	{
		return full;
	}
	var npcs = goal.npcs || [];
	var pets = goal.pets || [];
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
			return !pets.length ? 'Any pet'
				: pets.length === 1 ? 'Pet: ' + prettyGlob(pets[0]) : 'Pets (' + pets.length + ')';
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
	var sources = goal.sources || [];
	switch (type)
	{
		case 'DROP':
			var matched = prettyJoin(goal.items);
			if (!matched && goal.itemIds && goal.itemIds.length)
			{
				matched = goal.itemIds.length === 1 ? 'item ' + goal.itemIds[0] : goal.itemIds.length + ' item ids';
			}
			return (goal.distinct ? 'Distinct ' + dropNoun(goal).toLowerCase() : dropNoun(goal)) + ': ' + matched
				+ (sources.length ? ' from ' + prettyJoin(sources) : '');
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
			return 'Drop worth ' + withCommas(Number(goal.amount) || 0) + '+ gp'
				+ (sources.length ? ' from ' + prettyJoin(sources) : '');
		case 'CHAT':
			return readablePattern(String(goal.pattern || '')) || 'Game message';
		default:
			return 'Manual (tick off by hand)';
	}
}

function dropNoun(goal)
{
	var loot = sigList(goal.loot);
	if (loot === 'pickpocket')
	{
		return 'Pickpocket loot';
	}
	if (loot === 'kill')
	{
		return 'Kill drops';
	}
	return 'Drops';
}

function fromSources(goal)
{
	var sources = goal.sources || [];
	if (!sources.length)
	{
		return '';
	}
	return sources.length === 1 ? ' from ' + prettyGlob(sources[0]) : ' from ' + sources.length + ' sources';
}

function raidList(goal)
{
	var all = ['COX', 'TOB', 'TOA'];
	var wanted = [];
	var raids = goal.raids || [];
	for (var i = 0; i < all.length; i++)
	{
		for (var r = 0; r < raids.length; r++)
		{
			if (String(raids[r]).toUpperCase() === all[i])
			{
				wanted.push(all[i]);
				break;
			}
		}
	}
	return (wanted.length ? wanted : all).join(', ');
}

/** The plugin's course display names, keyed the way it resolves them (BingoCourse). */
var COURSE_NAMES = {
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
	var key = String(course || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	return COURSE_NAMES[key] || String(course || 'Agility');
}

/** "HITPOINTS" -> "Hitpoints", matching RuneLite's skill display names. */
function skillName(skill)
{
	var raw = String(skill || '').trim();
	return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'Skill';
}

function prettyGlob(glob)
{
	return String(glob == null ? '' : glob).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim();
}

function prettyJoin(values)
{
	var cleaned = [];
	for (var i = 0; values && i < values.length; i++)
	{
		var clean = prettyGlob(values[i]);
		if (clean)
		{
			cleaned.push(clean);
		}
	}
	return cleaned.join(', ');
}

function withCommas(n)
{
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The literal words of a regex, so "Corrupted challenge duration: [0-6]:..." reads. */
function readablePattern(regex)
{
	var parts = regex.split(/\[[^\]]*\][*+?]?|\([^)]*\)[*+?]?|\\[a-zA-Z]|\{\d+(?:,\d+)?\}|[.*+?^$|]/);
	var literals = [];
	for (var i = 0; i < parts.length; i++)
	{
		var cleaned = parts[i].replace(/\\(.)/g, '$1').replace(/\s+/g, ' ')
			.replace(/^[\s:;,\-]+|[\s:;,\-]+$/g, '');
		if (cleaned.length >= 4)
		{
			literals.push(cleaned);
		}
	}
	return literals.length ? literals.join(' ... ') : null;
}

/** What a tile TRACKS (types and matchers, not targets or labels); plugin's twin. */
function tileTrackingSignature(tile)
{
	var goals = (tile && tile.goals && tile.goals.length) ? tile.goals : [{ type: 'MANUAL' }];
	var parts = [];
	for (var g = 0; g < goals.length; g++)
	{
		var goal = goals[g] || {};
		parts.push([
			String(goal.type || '').toUpperCase(),
			sigList(goal.items), sigList(goal.itemIds), sigList(goal.sources),
			sigList(goal.loot), goal.distinct ? 'distinct' : '',
			sigList(goal.raids), sigList(goal.npcs), sigList(goal.pets),
			String(goal.skill || '').toUpperCase(), String(goal.course || '').toUpperCase(),
			String(goal.pattern || ''), sigList(goal.regions)
		].join('|'));
	}
	return parts.join(';');
}

/** Sorted, so reordering a list (same meaning) never looks like a different goal. */
function sigList(values)
{
	if (!values || !values.length)
	{
		return '';
	}
	var cleaned = [];
	for (var i = 0; i < values.length; i++)
	{
		var value = String(values[i] == null ? '' : values[i]).trim().toLowerCase();
		if (value)
		{
			cleaned.push(value);
		}
	}
	cleaned.sort();
	return cleaned.join(',');
}

/**
 * The timestamp for an admin wipe: past anything a client may legitimately send (clocks
 * up to MAX_CLOCK_SKEW_MS ahead are accepted), so no copy from before the wipe can win.
 * The owner's client adopts the empty tile and stamps its next change after it.
 */
function wipeStamp()
{
	return Date.now() + MAX_CLOCK_SKEW_MS + 1;
}

/** Empties the given tiles in every team scope of the board, resurrection-proof. */
function wipeTilesForBoardId(id, tileIndexes)
{
	var sheet = getSheet(STORE_SHEET, STORE_HEADERS);
	var rows = readRows(sheet);
	var prefix = 'id_' + id + '_';
	var stamp = wipeStamp();
	var wiped = 0;
	for (var key in rows)
	{
		var row = rows[key];
		// Exactly this board: "id_spring_" must not also match board "spring_2"
		// (a team code never contains an underscore, so the rest is one segment).
		if (row.board.indexOf(prefix) !== 0 || row.board.substring(prefix.length).indexOf('_') >= 0)
		{
			continue;
		}
		var tiles = parseJson(row.data, {});
		for (var i = 0; i < tileIndexes.length; i++)
		{
			// A fresh timestamp wins the last-write merge against every cached copy.
			tiles[String(tileIndexes[i])] = { goals: [], manual: false, ts: stamp };
		}
		sheet.getRange(row.rowIndex, 4, 1, 2)
			.setValues([[new Date().toISOString(), JSON.stringify(tiles)]]);
		wiped++;
	}
	console.log('Board update reset ' + tileIndexes.length + ' tile(s) on ' + wiped + ' member row(s)');
	return wiped;
}

/**
 * Menu action: resets the selected tile's progress. Select the tile on a Board <team>
 * tab first - a grid cell or any of its goal-table rows; run from any other tab and it
 * falls back to asking for the team code and tile number.
 */
function resetTilePrompt()
{
	var ui = SpreadsheetApp.getUi();
	var picked = selectedBoardTile();
	if (picked && picked.error)
	{
		ui.alert(picked.error);
		return;
	}
	if (picked)
	{
		if (ui.alert('Reset a tile\'s progress',
			'Reset "' + picked.label + '" for team "' + picked.team + '"?',
			ui.ButtonSet.YES_NO) !== ui.Button.YES)
		{
			return;
		}
		ui.alert(lockedTileReset(picked.team, picked.tileNumber));
		return;
	}
	var answer = ui.prompt('Reset a tile\'s progress',
		'Team code and tile number, separated by a space (e.g. "red 3").\n'
			+ 'Tip: select the tile on its Board tab instead and run this again.',
		ui.ButtonSet.OK_CANCEL);
	if (answer.getSelectedButton() !== ui.Button.OK)
	{
		return;
	}
	var parts = String(answer.getResponseText() || '').trim().toLowerCase().split(/\s+/);
	var team = parts[0] || '';
	var tileNumber = parseInt(parts[1], 10);
	if (!team || isNaN(tileNumber) || tileNumber < 1)
	{
		ui.alert('Could not read that - type the team code, a space, and the tile number.');
		return;
	}
	ui.alert(lockedTileReset(team, tileNumber));
}

/**
 * The tile currently selected on a Board view tab: { team, tileNumber, label }, an
 * { error } when the selection isn't a tile, or null when another tab is active.
 * Works for the grid (rows 4..4+size-1) and the goal table (tile number in column 1).
 */
function selectedBoardTile()
{
	var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
	var name = sheet.getName();
	var team;
	if (name === BOARD_SHEET)
	{
		team = 'solo';
	}
	else if (name.indexOf(BOARD_SHEET + ' ') === 0)
	{
		team = name.substring((BOARD_SHEET + ' ').length);
	}
	else
	{
		return null;
	}
	var scope = latestBoardForTeam(team);
	if (!scope)
	{
		return { error: 'No board found for team "' + team + '".' };
	}
	var cell = SpreadsheetApp.getActiveSpreadsheet().getActiveRange();
	if (!cell)
	{
		return { error: 'Select the tile\'s cell first.' };
	}
	var size = scope.meta.size || Math.round(Math.sqrt(scope.meta.tiles.length));
	var row = cell.getRow();
	var col = cell.getColumn();
	var tileNumber = 0;
	if (row >= 4 && row < 4 + size && col >= 1 && col <= size)
	{
		tileNumber = (row - 4) * size + col;
	}
	else if (row > 4 + size + 2)
	{
		// The goal table: every row carries its tile number in the first column.
		tileNumber = parseInt(sheet.getRange(row, 1).getValue(), 10);
	}
	if (isNaN(tileNumber) || tileNumber < 1 || tileNumber > scope.meta.tiles.length)
	{
		return { error: 'Select a tile in the grid (or one of its goal-table rows) first.' };
	}
	return { team: team, tileNumber: tileNumber,
		label: scope.meta.tiles[tileNumber - 1].label || ('tile ' + tileNumber) };
}

/**
 * Wipes one tile's stored progress for every member of a team. Each member's tile is
 * replaced by an EMPTY state with a fresh timestamp, so the wipe wins the last-write
 * merge against every cached copy - plain deletion would resurrect from teammates.
 * Adjustments rows are the admins' own ledger and are left alone.
 *
 * @return a human-readable summary for the menu alert
 */
function lockedTileReset(team, tileNumber)
{
	var result = withStoreLock(30000, function () { return resetStoreTileProgress(team, tileNumber); });
	return result ? result.value : STORE_BUSY_MESSAGE;
}

function resetStoreTileProgress(team, tileNumber)
{
	var scope = latestBoardForTeam(team);
	if (!scope)
	{
		return 'No board found for team "' + team + '" - check the Teams tab code.';
	}
	if (tileNumber > scope.meta.tiles.length)
	{
		return 'Tile ' + tileNumber + ' does not exist (board has ' + scope.meta.tiles.length + ' tiles).';
	}
	var sheet = getSheet(STORE_SHEET, STORE_HEADERS);
	var rows = readRows(sheet);
	var stamp = wipeStamp();
	var wiped = 0;
	for (var key in rows)
	{
		var row = rows[key];
		if (row.board !== scope.board)
		{
			continue;
		}
		var tiles = parseJson(row.data, {});
		tiles[String(tileNumber - 1)] = { goals: [], manual: false, ts: stamp };
		sheet.getRange(row.rowIndex, 4, 1, 2)
			.setValues([[new Date().toISOString(), JSON.stringify(tiles)]]);
		wiped++;
	}
	try
	{
		refreshBoardView(scope.board, scope.meta);
	}
	catch (err)
	{
		console.error('Board view refresh after tile reset failed: ' + err);
	}
	var label = scope.meta.tiles[tileNumber - 1].label || ('tile ' + tileNumber);
	return 'Reset "' + label + '" for ' + wiped + ' member(s) of team "' + team + '".\n'
		+ 'Any Adjustments rows for this tile still count - delete them there if they should not.';
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
			+ 'Players keep their own tracked progress, but drop everything they cached '
			+ 'about teammates on their next sync, so the old event cannot push itself '
			+ 'back in.\n\nContinue?',
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
		// New generation, so every client drops its cached copy of the old event.
		var props = PropertiesService.getScriptProperties();
		var next = Number(props.getProperty(EPOCH_PROP) || 0) + 1;
		props.deleteAllProperties();
		props.setProperty(EPOCH_PROP, String(next));
		clearConfigCache();
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
	// The pasted board code is the truth; a stale Meta row (an earlier revision, or a
	// team nobody has synced for yet) is rebuilt from it before rendering.
	var code = readBoardCode();
	var parsed = code ? parseJson(code, null) : null;
	if (parsed && parsed.tiles)
	{
		withStoreLock(30000, function () { seedMetaFromBoard(parsed, normalizedBoardId(parsed)); });
	}
	var sheet = getSheet(META_SHEET, META_HEADERS);
	var values = sheet.getDataRange().getValues();
	if (values.length < 2)
	{
		SpreadsheetApp.getUi().alert('No board yet. Paste the board code on the Board code tab, or have a player sync once.');
		return;
	}
	for (var i = 1; i < values.length; i++)
	{
		maybeRefreshViews(String(values[i][0]), true);
	}
}

/**
 * Hand edits: config tabs clear the config cache, the Requests Status column applies the
 * picked status, and a new Adjustments row is stamped so the ledger is self-documenting.
 */
function onEdit(e)
{
	var sheet = e.range.getSheet();
	if ([TEAMS_SHEET, BOARD_CODE_SHEET, SETTINGS_SHEET].indexOf(sheet.getName()) >= 0)
	{
		clearConfigCache();
		return;
	}
	if (sheet.getName() === REQUESTS_SHEET)
	{
		// Admin picked a status from the Status dropdown: apply it - "Done" writes the
		// Adjustments ledger row (once), and the cell gets its status color. A paste
		// or drag-fill over several rows applies to each of them.
		var first = e.range.getColumn();
		if (first > 10 || first + e.range.getNumColumns() - 1 < 10)
		{
			return;
		}
		var values = e.range.getValues();
		var applied = withStoreLock(20000, function ()
		{
			for (var i = 0; i < values.length; i++)
			{
				var rowNumber = e.range.getRow() + i;
				if (rowNumber >= 2)
				{
					setRequestStatus(rowNumber, String(values[i][10 - first] || 'Pending'));
				}
			}
		});
		if (!applied)
		{
			e.range.setNote(STORE_BUSY_MESSAGE + ' Set the status again to apply it.');
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
