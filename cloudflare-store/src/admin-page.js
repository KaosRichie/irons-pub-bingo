// The admin page: review credit requests, give credit, look at each team's board, manage
// teams and the board code, and watch usage. Every choice is picked from the event's own
// teams, tiles, goals and members, so nobody types a tile number.
// The admin password is typed once and kept in this browser's localStorage, never in a URL.
import { HEAD, CSS, SHARED_JS } from './theme.js';

export function adminPage()
{
	return `<!doctype html><html lang="en"><head>${HEAD}<title>Admin \u00b7 Irons Pub Bingo</title><style>${CSS}
.shell{display:grid;grid-template-columns:220px minmax(0,1fr);gap:20px;margin:20px auto 40px}
nav.side{position:sticky;top:92px;align-self:start;display:flex;flex-direction:column;gap:4px}
nav.side button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;font:600 14px var(--sans);color:var(--ink2);background:transparent;border:1px solid transparent;border-radius:10px;padding:10px 12px;cursor:pointer}
nav.side button:hover{background:var(--panel);color:var(--ink)}
nav.side button.on{background:linear-gradient(180deg,#221d12,#17140d);border-color:var(--gold3);color:var(--gold2)}
nav.side .ic{width:20px;text-align:center}nav.side .badge{margin-left:auto}
.ledrow{display:grid;grid-template-columns:120px minmax(0,1.3fr) minmax(0,.9fr) 100px minmax(0,1.4fr) 96px;gap:14px;padding:12px 0;border-top:1px solid var(--line);align-items:start}
.ledrow:first-child{border-top:0}.ledrow.head{font:600 11.5px var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-top:0}
.ledrow>div{overflow-wrap:anywhere;min-width:0}.ledrow .lbl{display:none;font:600 11px var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:3px}
.view{display:flex;flex-direction:column;gap:18px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.toolbar .search{max-width:260px}.toolbar select{max-width:200px}
.reqs{display:flex;flex-direction:column}
.reqrow{display:grid;grid-template-columns:minmax(150px,1.1fr) minmax(170px,1.4fr) minmax(160px,1.6fr) minmax(130px,1fr) 190px;gap:16px;padding:14px 0;border-top:1px solid var(--line);align-items:start}
.reqrow:first-child{border-top:0}.reqrow .lbl{display:none;font:600 11px var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:3px}
.reqrow .acts{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.reqrow .acts .row{gap:6px}.who b{display:block;overflow-wrap:anywhere}.what{overflow-wrap:anywhere}
.boardwrap{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(280px,1fr);gap:18px;align-items:start}
.preview{padding:12px 14px;border-radius:10px;background:rgba(226,173,72,.08);border:1px solid var(--gold3);color:var(--ink);margin-top:14px}
.teamrow{display:grid;grid-template-columns:130px minmax(0,1fr) minmax(0,1.4fr) 40px;gap:10px;align-items:start;padding:10px 0;border-top:1px solid var(--line)}
.teamrow:first-child{border-top:0}.pw{position:relative}.pw input{padding-right:40px}.pw button{position:absolute;right:4px;top:4px}
textarea.code{min-height:320px;font:12.5px/1.5 ui-monospace,Consolas,monospace}
.summary{padding:12px 14px;border-radius:10px;border:1px solid var(--line2);background:var(--bg2)}
.summary.ok{border-color:#2f6a43;background:var(--okbg)}.summary.bad{border-color:#6a2f2f;background:var(--redbg)}
.usage{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:10px}
.usage div{flex:1;min-width:10px;background:linear-gradient(180deg,var(--gold2),var(--gold3));border-radius:5px 5px 2px 2px;position:relative}
.usage div span{position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:10.5px;color:var(--muted);white-space:nowrap}
.big{font:700 34px/1 var(--serif);color:var(--gold2)}
.login{max-width:420px;margin:12vh auto}
.copy{display:flex;gap:8px}.copy input{font:12.5px ui-monospace,Consolas,monospace}
@media (max-width:1100px){.reqrow{grid-template-columns:1fr 1fr}.reqrow .lbl{display:block}.boardwrap{grid-template-columns:1fr}}
@media (max-width:980px){.ledrow{grid-template-columns:1fr 1fr}.ledrow.head{display:none}.ledrow .lbl{display:block}}
@media (max-width:820px){.shell{grid-template-columns:1fr}nav.side{position:static;flex-direction:row;flex-wrap:wrap}nav.side button{width:auto;white-space:nowrap}.teamrow{grid-template-columns:1fr 1fr}}
@media (max-width:560px){.reqrow{grid-template-columns:1fr}}
</style></head><body>
<header class="top"><div class="wrap">
<div class="brand"><img src="/assets/logo.png" alt="Irons Pub"><div><h1>Irons Pub Bingo</h1><div class="sub" id="sub">Admin</div></div></div>
<div class="spacer"></div><a class="btn sm ghost" href="/admin">&#8592; All events</a><span class="chip gold" id="eventChip"></span>
<a class="btn sm" id="portalLink" target="_blank" rel="noopener">Open portal &#8599;</a>
<button class="btn sm ghost" id="signOut" hidden>Sign out</button>
</div></header>
<div class="wrap" id="app"></div>
<div class="toast" id="toast"></div><div id="modalRoot"></div>
<script>${SHARED_JS}
var base=location.pathname.replace(/\\/admin\\/?$/,'');var eventCode=base.split('/').pop();
var token='';try{token=localStorage.getItem('ipb.adminToken')||'';}catch(e){}
var data=null,view='requests',reqFilter='Pending',reqTeam='',reqSearch='',boardTeam=0,boardTile=-1,creditPrefill=null;
document.getElementById('eventChip').textContent='Event: '+eventCode;document.getElementById('portalLink').href=base;
function toast(text,cls){var d=document.createElement('div');d.className=cls||'';d.textContent=text;document.getElementById('toast').appendChild(d);setTimeout(function(){d.remove();},7000);}
function api(body){return fetch(base+'/admin/api',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify(body)})
.then(function(r){if(r.status===401){var e=new Error('Wrong admin password');e.auth=true;throw e;}return r.json();})
.then(function(j){if(j.error){throw new Error(j.error);}if(j.result&&j.result.error){throw new Error(j.result.error);}(j.alerts||[]).forEach(function(a){toast(a,'ok');});return j.result;});}
function confirmBox(title,text,okLabel,danger){return new Promise(function(resolve){var root=document.getElementById('modalRoot');
root.innerHTML='<div class="modal" id="cm"><div class="card"><h2>'+esc(title)+'</h2><p style="color:var(--ink2);white-space:pre-wrap">'+esc(text)+'</p><div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" id="cmNo">Cancel</button><button class="btn '+(danger?'bad':'gold')+'" id="cmYes">'+esc(okLabel)+'</button></div></div></div>';
document.getElementById('cmNo').onclick=function(){root.innerHTML='';resolve(false);};document.getElementById('cmYes').onclick=function(){root.innerHTML='';resolve(true);};});}
function load(){return api({action:'overview'}).then(function(r){data=r;if(data.isNew&&view==='requests'){view='teams';}document.getElementById('signOut').hidden=false;
document.getElementById('sub').textContent='Admin \\u00b7 '+(data.event.name||'No board yet');render();}).catch(function(e){if(e.auth){showLogin(e.message);}else{toast(e.message,'bad');}});}
function showLogin(error){document.getElementById('signOut').hidden=true;document.getElementById('app').innerHTML='<div class="card login"><h2>Admin sign in</h2><p class="muted">Enter the admin password for this store.</p>'
+'<label class="field"><span>Admin password</span><input type="password" id="pw" autocomplete="current-password"></label>'+(error?'<p style="color:var(--red)">'+esc(error)+'</p>':'')
+'<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn gold" id="go">Sign in</button></div></div>';
var go=function(){token=document.getElementById('pw').value;try{localStorage.setItem('ipb.adminToken',token);}catch(e){}load();};
document.getElementById('go').onclick=go;document.getElementById('pw').onkeydown=function(e){if(e.key==='Enter'){go();}};document.getElementById('pw').focus();}
document.getElementById('signOut').onclick=function(){token='';try{localStorage.removeItem('ipb.adminToken');}catch(e){}showLogin();};
var NAV=[['requests','&#128203;','Requests'],['board','&#9638;','Boards'],['credit','&#10010;','Give credit'],['teams','&#9873;','Teams'],['code','&#128220;','Board code'],['settings','&#9881;','Settings'],['usage','&#128200;','Usage']];
function teamName(code){var t=data.teams.find(function(x){return x.code===code;});return t?t.name:code;}
function render(){var pending=data.requests.filter(function(r){return r.status==='Pending';}).length;
document.getElementById('app').innerHTML='<div class="shell"><nav class="side" id="nav"></nav><div class="view" id="view"></div></div>';
var nav=document.getElementById('nav');NAV.forEach(function(n){var b=document.createElement('button');b.className=n[0]===view?'on':'';
b.innerHTML='<span class="ic">'+n[1]+'</span>'+n[2]+(n[0]==='requests'&&pending?'<span class="badge">'+pending+'</span>':'');b.onclick=function(){view=n[0];render();};nav.appendChild(b);});
var vw=document.getElementById('view');({requests:renderRequests,board:renderBoards,credit:renderCredit,teams:renderTeams,code:renderCode,settings:renderSettings,usage:renderUsage})[view](vw);
if(data.isNew){var nb=document.createElement('section');nb.className='card';nb.style.borderColor='var(--gold3)';
nb.innerHTML='<h2 style="color:var(--gold2)">New event</h2><p class="muted" style="margin:0">Nothing is saved for <b>'+esc(eventCode)+'</b> yet. Its portal and store URL show &ldquo;not found&rdquo; until you save something here. Add the teams or paste the board code to create it.</p>';
vw.insertBefore(nb,vw.firstChild);}}
/* ---------------- requests */
function renderRequests(el){var counts={};data.requests.forEach(function(r){counts[r.status]=(counts[r.status]||0)+1;});
el.innerHTML='<section class="card"><h2>Credit requests</h2><div class="toolbar"><div class="seg" id="rf"></div>'
+'<select id="rt"><option value="">All teams</option>'+data.teams.map(function(t){return '<option value="'+esc(t.code)+'"'+(t.code===reqTeam?' selected':'')+'>'+esc(t.name)+'</option>';}).join('')+'</select>'
+'<input class="search" id="rs" placeholder="Search player, tile, note" value="'+esc(reqSearch)+'"></div><div class="reqs" id="rl"></div></section>';
var seg=document.getElementById('rf');[['Pending','Pending'],['Done','Approved'],['Rejected','Rejected'],['All','All']].forEach(function(f){var b=document.createElement('button');b.className=f[0]===reqFilter?'on':'';
var n=f[0]==='All'?data.requests.length:(counts[f[0]]||0);b.innerHTML=f[1]+(n?' <span class="badge">'+n+'</span>':'');b.onclick=function(){reqFilter=f[0];render();};seg.appendChild(b);});
document.getElementById('rt').onchange=function(){reqTeam=this.value;render();};
document.getElementById('rs').oninput=function(){reqSearch=this.value;renderRequestList();};
renderRequestList();}
function renderRequestList(){var el=document.getElementById('rl');var list=data.requests.filter(function(r){return (reqFilter==='All'||r.status===reqFilter)&&(!reqTeam||r.team===reqTeam)
&&(!reqSearch||(r.player+' '+r.tileLabel+' '+(r.goalLabel||'')+' '+r.note).toLowerCase().indexOf(reqSearch.toLowerCase())>=0);});
if(!list.length){el.innerHTML='<div class="empty">'+(reqFilter==='Pending'?'Nothing waiting for review. Nice.':'No requests match.')+'</div>';return;}
el.innerHTML=list.map(function(r){var credit=r.complete?'Whole tile complete':'+'+fmt(r.add)+(r.goalLabel?' on '+r.goalLabel:'');
var st='<span class="chip '+r.status.toLowerCase()+'">'+(r.status==='Done'?'&#10003; Approved':r.status==='Rejected'?'&#10005; Rejected':'&#9203; Pending')+'</span>';
var acts=r.status==='Pending'?'<button class="btn ok sm" data-id="'+esc(r.id)+'" data-st="Done">&#10003; Approve</button><button class="btn bad sm" data-id="'+esc(r.id)+'" data-st="Rejected">&#10005; Reject</button>'
:r.status==='Done'?'<button class="btn bad sm" data-id="'+esc(r.id)+'" data-st="Rejected">Withdraw</button>'
:'<button class="btn ok sm" data-id="'+esc(r.id)+'" data-st="Done">Approve</button><button class="btn sm" data-id="'+esc(r.id)+'" data-st="Pending">Reopen</button>';
return '<div class="reqrow"><div class="who"><span class="lbl">Player</span><b>'+esc(r.player)+'</b><span class="small muted">'+esc(teamName(r.team))+' \\u00b7 <span title="'+esc(r.when)+'">'+ago(r.when)+'</span></span></div>'
+'<div class="what"><span class="lbl">Request</span><b>'+esc(r.tileLabel||('Tile '+r.tile))+'</b><div class="small" style="color:var(--ink2)">'+esc(credit)+'</div></div>'
+'<div><span class="lbl">Note</span>'+clampHtml(r.note)+'</div><div><span class="lbl">Proof</span>'+linksHtml(r.links)+'</div>'
+'<div class="acts">'+st+'<div class="row">'+acts+'</div></div></div>';}).join('');fixClamps(el);
Array.prototype.forEach.call(el.querySelectorAll('button[data-id]'),function(b){b.onclick=function(){setStatus(b.dataset.id,b.dataset.st);};});}
function setStatus(id,status){var r=data.requests.find(function(x){return x.id===id;});
var go=function(){api({action:'setRequestStatus',id:id,status:status}).then(function(){toast((status==='Done'?'Approved ':status==='Rejected'?'Rejected ':'Reopened ')+r.player+"'s request.",'ok');load();}).catch(function(e){toast(e.message,'bad');});};
if(r.status==='Done'&&status!=='Done'){confirmBox('Withdraw this approval?',r.player+"'s credit for "+r.tileLabel+' will be taken back on everyone\\'s next sync, and the team\\'s Discord is told.','Withdraw',true).then(function(ok){if(ok){go();}});}else{go();}}
/* ---------------- boards */
function renderBoards(el){var teams=data.teams.filter(function(t){return t.board;});
if(!teams.length){el.innerHTML='<section class="card"><h2>Boards</h2><div class="empty">No board yet. Paste the board code, or wait for a player to sync.</div></section>';return;}
if(boardTeam>=teams.length){boardTeam=0;}var t=teams[boardTeam];
el.innerHTML='<section class="card"><div class="toolbar"><h2 class="grow" style="margin:0">Boards</h2><div class="seg" id="bt"></div></div>'
+'<div class="row muted small" style="margin-bottom:12px;gap:16px"><span><b style="color:var(--gold2)">'+t.board.done+'</b> / '+t.board.tiles.length+' tiles</span><span><b style="color:var(--gold2)">'+t.board.lines+'</b> lines</span>'
+(t.points!=null?'<span><b style="color:var(--gold2)">'+t.points+'</b> points</span>':'')+'<span>'+t.members.length+' members</span></div>'
+'<div class="boardwrap"><div id="bb"></div><div id="bd"></div></div></section>';
var seg=document.getElementById('bt');teams.forEach(function(x,i){var b=document.createElement('button');b.className=i===boardTeam?'on':'';b.textContent=x.name;b.onclick=function(){boardTeam=i;boardTile=-1;render();};seg.appendChild(b);});
renderBoard(document.getElementById('bb'),t.board,data.event.diagonals,boardTile,function(i){boardTile=i;render();});
var d=document.getElementById('bd');if(boardTile<0){d.innerHTML='<div class="empty">Select a tile to see its progress, give credit, or reset it.</div>';return;}
var tile=t.board.tiles[boardTile];
d.innerHTML='<h2 style="overflow-wrap:anywhere">'+esc(tile.label)+'</h2><div class="row" style="gap:6px;margin-bottom:8px">'+(tile.done?'<span class="chip done">&#10003; Complete</span>':'<span class="chip">In progress</span>')
+(tile.goals.length>1?'<span class="chip">'+(tile.mode==='ANY'?'Any goal':'All goals')+'</span>':'')+(tile.points!=null?'<span class="chip gold">'+tile.points+' pts</span>':'')+'</div>'
+goalsHtml(tile)+'<div class="row" style="margin-top:14px"><button class="btn gold" id="giveCredit">&#10010; Give credit</button><button class="btn bad" id="resetTile">Reset tile progress</button></div>';
document.getElementById('giveCredit').onclick=function(){creditPrefill={team:t.code,tile:boardTile};view='credit';render();};
document.getElementById('resetTile').onclick=function(){confirmBox('Reset '+tile.label+'?','This wipes every '+t.name+' member\\'s tracked progress on this tile. Admin credit on the Give credit page stays.','Reset tile',true).then(function(ok){
if(ok){api({action:'resetTile',team:t.code,tile:boardTile+1}).then(load).catch(function(e){toast(e.message,'bad');});}});};}
/* ---------------- credit */
function renderCredit(el){var teams=data.teams.filter(function(t){return t.board;});var pre=creditPrefill||{};creditPrefill=null;
el.innerHTML='<section class="card"><h2>Give credit</h2><p class="muted" style="margin-top:-4px">For progress the tracker missed. It counts for the team right away and is announced on the team\\'s Discord.</p>'
+(teams.length?'<div class="grid2"><label class="field"><span>Team</span><select id="cTeam">'+teams.map(function(t){return '<option value="'+esc(t.code)+'"'+(t.code===pre.team?' selected':'')+'>'+esc(t.name)+'</option>';}).join('')+'</select></label>'
+'<label class="field"><span>Player</span><select id="cPlayer"></select><div class="hint">Players who have synced to this team.</div></label></div>'
+'<label class="field" style="margin-top:12px"><span>Tile</span><select id="cTile"></select></label>'
+'<div class="grid2" style="margin-top:12px"><label class="field"><span>What to credit</span><select id="cGoal"></select></label>'
+'<label class="field" id="cAmountWrap"><span>Amount</span><input id="cAmount" type="number" step="1" placeholder="e.g. 5"><div class="hint">Use a negative number to correct a mistake.</div></label></div>'
+'<label class="field" style="margin-top:12px"><span>Note</span><input id="cNote" maxlength="200" placeholder="Why, for the record"></label>'
+'<div class="preview" id="cPreview"></div><div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn gold" id="cAdd">Add credit</button></div>'
:'<div class="empty">Credit needs a board. Paste the board code first.</div>')+'</section>'
+'<section class="card"><h2>Credit ledger</h2><div id="ledger"></div></section>';
renderLedger();if(!teams.length){return;}
var teamSel=document.getElementById('cTeam'),tileSel=document.getElementById('cTile'),goalSel=document.getElementById('cGoal');
function team(){return teams.find(function(t){return t.code===teamSel.value;});}
function fillTiles(keep){var t=team();tileSel.innerHTML=t.board.tiles.map(function(x,i){return '<option value="'+i+'">'+(i+1)+'. '+esc(x.label)+(x.done?' \\u2713':'')+'</option>';}).join('');
if(keep!=null){tileSel.value=String(keep);}fillPlayers();fillGoals();}
function fillPlayers(){var t=team(),sel=document.getElementById('cPlayer'),was=sel.value;
sel.innerHTML=t.members.length?'<option value="" selected disabled>Pick a player</option>'+t.members.map(function(m){return '<option'+(m===was?' selected':'')+'>'+esc(m)+'</option>';}).join('')
:'<option value="" selected disabled>Nobody on this team has synced yet</option>';sel.disabled=!t.members.length;}
function fillGoals(){var tile=team().board.tiles[+tileSel.value],opts='';tile.goals.forEach(function(g,i){opts+='<option value="'+(i+1)+'">'+(g.manual?'Tick: ':'')+esc(g.label)+(g.manual?'':' ('+fmt(g.total)+' / '+fmt(g.target)+')')+'</option>';});
goalSel.innerHTML=opts+'<option value="complete">Mark the whole tile complete</option>';update();}
function update(){var complete=goalSel.value==='complete',tile=team().board.tiles[+tileSel.value],g=complete?null:tile.goals[+goalSel.value-1];
var manualGoal=g&&g.manual;document.getElementById('cAmountWrap').style.display=complete||manualGoal?'none':'';
var player=document.getElementById('cPlayer').value.trim(),amount=+document.getElementById('cAmount').value||0;
if(!player||(!complete&&!manualGoal&&!amount)){document.getElementById('cPreview').innerHTML='<span class="muted">'+(!player?'Pick the player':'Fill in an amount')+' to see exactly what this adds.</span>';return;}
document.getElementById('cPreview').innerHTML=complete||manualGoal?'Marks <b>'+esc(tile.label)+'</b> complete for <b>'+esc(team().name)+'</b>, credited to '+esc(player)+'.'
:'Adds <b>'+(amount>=0?'+':'')+amount+'</b> to <b>'+esc(g.label)+'</b> on <b>'+esc(tile.label)+'</b> for <b>'+esc(team().name)+'</b>, credited to '+esc(player)+'. New total: <b>'+fmt(Math.max(0,Math.min(g.target||Infinity,g.raw+amount)))+' / '+fmt(g.target)+'</b>.';}
teamSel.onchange=function(){fillTiles();};tileSel.onchange=fillGoals;goalSel.onchange=update;document.getElementById('cPlayer').onchange=update;document.getElementById('cAmount').oninput=update;
fillTiles(pre.tile);
document.getElementById('cAdd').onclick=function(){var complete=goalSel.value==='complete',tile=team().board.tiles[+tileSel.value],g=complete?null:tile.goals[+goalSel.value-1],manualGoal=g&&g.manual;
var player=document.getElementById('cPlayer').value.trim(),amount=+document.getElementById('cAmount').value;
if(!player){toast('Pick the player.','bad');return;}if(!complete&&!manualGoal&&!amount){toast('Fill in an amount.','bad');return;}
api({action:'addAdjustment',team:teamSel.value,tile:+tileSel.value+1,goal:complete?'':+goalSel.value,player:player,add:complete||manualGoal?'':amount,complete:complete||manualGoal,note:document.getElementById('cNote').value})
.then(function(){toast('Credit added for '+player+'.','ok');load();}).catch(function(e){toast(e.message,'bad');});};}
function renderLedger(){var el=document.getElementById('ledger'),rows=data.adjustments||[];
if(!rows.length){el.innerHTML='<div class="empty">No credit given yet. Approved requests and credit added here appear in this list.</div>';return;}
el.innerHTML='<div class="ledrow head"><div>Team</div><div>Tile</div><div>Player</div><div>Credit</div><div>Note</div><div></div></div>'
+rows.map(function(a){var note=a.fromRequest?'<span class="chip gold" title="Approved credit request">From a request</span> '+clampHtml(a.note):clampHtml(a.note);
return '<div class="ledrow"><div><span class="lbl">Team</span>'+esc(a.team?teamName(a.team):'All teams')+'</div>'
+'<div><span class="lbl">Tile</span><b>'+esc(a.tileLabel)+'</b>'+(!a.complete&&a.goalLabel?'<div class="small muted">'+esc(a.goalLabel)+'</div>':'')
+(a.issues.length?'<div class="small" style="color:var(--red)">&#9888; '+esc(a.issues.join('. '))+'</div>':'')+'</div>'
+'<div><span class="lbl">Player</span>'+esc(a.player)+'</div>'
+'<div class="nowrap"><span class="lbl">Credit</span>'+(a.complete?'<span class="chip done">Complete</span>':'<b style="color:'+(a.add>=0?'var(--gold2)':'var(--red)')+'">'+(a.add>=0?'+':'')+fmt(a.add)+'</b>')+'</div>'
+'<div><span class="lbl">Note</span>'+note+(a.added?'<div class="small muted" title="'+esc(a.added)+'">'+ago(a.added)+(a.by&&a.by!=='approved request'?' \\u00b7 '+esc(a.by):'')+'</div>':'')+'</div>'
+'<div><button class="btn bad sm" data-id="'+esc(a.id)+'">Remove</button></div></div>';}).join('');
fixClamps(el);
Array.prototype.forEach.call(el.querySelectorAll('button[data-id]'),function(b){b.onclick=function(){var a=rows.find(function(x){return x.id===b.dataset.id;});
var what=(a.complete?'Completion of ':((a.add>=0?'+':'')+a.add+' on '))+a.tileLabel+' for '+a.player;
confirmBox('Remove this credit?',what+' is taken back on everyone\\'s next sync, and the team\\'s Discord is told.'+(a.fromRequest?' This came from an approved request: rejecting the request on the Requests page does the same and shows the player why.':''),'Remove',true)
.then(function(ok){if(ok){api({action:'deleteAdjustment',id:a.id}).then(function(){toast('Credit removed.','ok');load();}).catch(function(e){toast(e.message,'bad');});}});};});}
/* ---------------- teams */
function renderTeams(el){var rows=(data.teamRows||[]).map(function(r){return {code:r.code,name:r.name,webhook:r.webhook};});
function draw(){el.innerHTML='<section class="card"><h2>Teams</h2><p class="muted" style="margin-top:-4px">Only listed teams can sync. Players pick their team from this list in the plugin.</p><div id="tr"></div>'
+'<div class="row" style="margin-top:14px"><button class="btn" id="addTeam">&#10010; Add team</button><span class="spacer"></span><button class="btn gold" id="saveTeams">Save teams</button></div></section>';
var box=document.getElementById('tr');box.innerHTML='<div class="teamrow small muted" style="border:0;padding-bottom:0"><b>Code</b><b>Display name</b><b>Discord webhook (optional)</b><span></span></div>'
+rows.map(function(r,i){var info=data.teams.find(function(t){return t.code===String(r.code).trim().toLowerCase();});
return '<div class="teamrow"><input data-i="'+i+'" data-k="code" value="'+esc(r.code)+'" placeholder="red"><div><input data-i="'+i+'" data-k="name" value="'+esc(r.name)+'" placeholder="Red Team">'
+(info&&info.members.length?'<div class="hint">'+info.members.length+' member'+(info.members.length===1?'':'s')+': '+esc(info.members.join(', '))+'</div>':'<div class="hint">No members yet</div>')+'</div>'
+'<div class="pw"><input type="password" data-i="'+i+'" data-k="webhook" value="'+esc(r.webhook)+'" placeholder="https://discord.com/api/webhooks/..."><button class="btn ghost sm" data-eye="'+i+'" title="Show or hide">&#128065;</button></div>'
+'<button class="btn ghost sm" data-del="'+i+'" title="Remove team">&#10005;</button></div>';}).join('');
Array.prototype.forEach.call(box.querySelectorAll('input[data-i]'),function(inp){inp.oninput=function(){rows[+inp.dataset.i][inp.dataset.k]=inp.value;};});
Array.prototype.forEach.call(box.querySelectorAll('[data-eye]'),function(b){b.onclick=function(){var inp=b.previousElementSibling;inp.type=inp.type==='password'?'text':'password';};});
Array.prototype.forEach.call(box.querySelectorAll('[data-del]'),function(b){b.onclick=function(){rows.splice(+b.dataset.del,1);draw();};});
document.getElementById('addTeam').onclick=function(){rows.push({code:'',name:'',webhook:''});draw();};
document.getElementById('saveTeams').onclick=function(){var bad=rows.find(function(r){return r.webhook&&!/^https:\\/\\/(discord|discordapp)\\.com\\/api\\/webhooks\\//.test(r.webhook.trim());});
if(bad){toast('That webhook does not look like a Discord webhook URL: '+bad.webhook,'bad');return;}
api({action:'saveTeams',teams:rows.filter(function(r){return String(r.code).trim();})}).then(function(){toast('Teams saved.','ok');load();}).catch(function(e){toast(e.message,'bad');});};}
draw();}
/* ---------------- board code */
function summarize(code){if(!code.trim()){return {ok:false,message:'No board code pasted yet.'};}var p;try{p=JSON.parse(code);}catch(e){return {ok:false,message:'Not a valid board code: '+e.message};}
if(!p||!Array.isArray(p.tiles)){return {ok:false,message:'This JSON has no tiles. Export the code from Bingo Forge.'};}var n=+p.size||Math.round(Math.sqrt(p.tiles.length));
if(p.size&&p.tiles.length!==n*n){return {ok:false,message:'A '+n+'x'+n+' board needs '+(n*n)+' tiles, this code has '+p.tiles.length+'.'};}
return {ok:true,name:p.name||'Unnamed board',id:p.id,version:p.version,size:n,tiles:p.tiles.length};}
function renderCode(el){var code=data.boardCode.text||'';
el.innerHTML='<section class="card"><h2>Board code</h2><p class="muted" style="margin-top:-4px">Build the board in <a href="https://kaosrichie.github.io/irons-pub-bingo/board-builder.html" target="_blank" rel="noopener">Bingo Forge</a>, export the code and paste it here. Players load it with Import from store.</p>'
+'<textarea class="code" id="code" spellcheck="false" placeholder="Paste the board code here">'+esc(code)+'</textarea><div class="summary" id="sum" style="margin-top:12px"></div>'
+'<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn gold" id="saveCode">Save and apply</button></div></section>';
var ta=document.getElementById('code');function show(){var s=summarize(ta.value),el2=document.getElementById('sum');el2.className='summary '+(s.ok?'ok':'bad');
el2.innerHTML=s.ok?'&#10003; <b>'+esc(s.name)+'</b> \\u00b7 '+s.size+'x'+s.size+' \\u00b7 '+s.tiles+' tiles'+(s.id!=null?' \\u00b7 id <code>'+esc(s.id)+'</code>':' \\u00b7 <span style="color:var(--amber)">no id, so every edit starts a new board</span>')+(s.version!=null?' \\u00b7 version '+esc(s.version):''):'&#9888; '+esc(s.message);}
ta.oninput=show;show();
document.getElementById('saveCode').onclick=function(){var s=summarize(ta.value);if(!s.ok){toast(s.message,'bad');return;}
confirmBox('Save this board code?','Players on an older code are told to reimport it. Tiles that now track something different start over; renamed tiles and changed targets keep their progress.','Save and apply',false)
.then(function(ok){if(ok){api({action:'saveBoardCode',code:ta.value.trim()}).then(load).catch(function(e){toast(e.message,'bad');});}});};}
/* ---------------- settings */
function renderSettings(el){var origin=location.origin;
el.innerHTML='<section class="card"><h2>Links to share</h2><div class="grid2">'
+'<label class="field"><span>Plugin store URL, for every player</span><div class="copy"><input readonly value="'+esc(origin+base)+'"><button class="btn sm" data-copy="'+esc(origin+base)+'">Copy</button></div><div class="hint">Plugin settings, Use team store, Store URL.</div></label>'
+'<label class="field"><span>Player portal</span><div class="copy"><input readonly value="'+esc(origin+base)+'"><button class="btn sm" data-copy="'+esc(origin+base)+'">Copy</button></div><div class="hint">The same address, opened in a browser.</div></label></div></section>'
+'<section class="card"><h2>Sync settings</h2><label class="field" style="max-width:320px"><span>Seconds between syncs</span><input id="poll" type="number" min="60" max="900" value="'+(data.settings.pollSeconds||120)+'"><div class="hint">60 to 900. Lower is fresher, higher uses fewer requests. Completions always sync at once.</div></label>'
+'<div class="row" style="margin-top:14px"><button class="btn gold" id="savePoll">Save</button></div></section>'
+'<section class="card" style="border-color:#6a2f2f"><h2 style="color:#ffb4ac">Danger zone</h2><p class="muted">Clears every team, the board code, all progress, credit and requests for this event. Settings stay. Players keep their own tracked progress.</p>'
+'<div class="row"><input id="wipeCode" placeholder="Type '+esc(eventCode)+' to confirm" style="max-width:280px"><button class="btn bad" id="wipe">Reset event data</button></div></section>';
Array.prototype.forEach.call(el.querySelectorAll('[data-copy]'),function(b){b.onclick=function(){navigator.clipboard.writeText(b.dataset.copy).then(function(){toast('Copied.','ok');});};});
document.getElementById('savePoll').onclick=function(){var v=+document.getElementById('poll').value;if(!(v>=60&&v<=900)){toast('Pick a value from 60 to 900 seconds.','bad');return;}
api({action:'saveSettings',pollSeconds:v}).then(function(){toast('Saved. Players pick it up on their next sync.','ok');load();}).catch(function(e){toast(e.message,'bad');});};
document.getElementById('wipe').onclick=function(){if(document.getElementById('wipeCode').value.trim()!==eventCode){toast('Type the event code to confirm.','bad');return;}
api({action:'resetStore'}).then(function(){toast('Event data cleared.','ok');load();}).catch(function(e){toast(e.message,'bad');});};}
/* ---------------- usage */
function renderUsage(el){var u=data.usage||{days:{}},today=new Date().toISOString().slice(0,10),days=[];
for(var i=13;i>=0;i--){var d=new Date(Date.now()-i*86400000).toISOString().slice(0,10);days.push([d,u.days[d]||0]);}
var max=Math.max.apply(null,days.map(function(x){return x[1];}).concat([1])),todayCount=u.days[today]||0,pct=todayCount/1000;
var players=data.teams.reduce(function(s,t){return s+t.members.length;},0),poll=data.settings.pollSeconds||120;
el.innerHTML='<section class="card"><h2>Requests to this event</h2><div class="grid2"><div><div class="muted small">Today (UTC)</div><div class="big">'+todayCount.toLocaleString()+'</div><div class="small muted">'+pct.toFixed(1)+'% of the free plan\\'s 100,000 a day</div></div>'
+'<div><div class="muted small">Estimate at full activity</div><div class="big">'+Math.round(players*86400/poll).toLocaleString()+'</div><div class="small muted">'+players+' players syncing every '+poll+' s, all day long ('+(players*86400/poll/1000).toFixed(1)+'% of the limit)</div></div></div>'
+'<div class="usage">'+days.map(function(x){return '<div title="'+x[0]+': '+x[1]+' requests" style="height:'+Math.max(2,x[1]/max*100)+'%"><span>'+x[0].slice(5)+'</span></div>';}).join('')+'</div><div style="height:24px"></div>'
+'<p class="muted small">This counts what reaches this event, which is nearly all of the traffic. The free plan\\'s daily limit covers the whole Cloudflare account, every event included. '
+'Cloudflare\\'s own numbers are under Workers &amp; Pages in the <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener">Cloudflare dashboard</a>, on the irons-pub-bingo Worker\\'s Metrics tab. Limits reset at midnight UTC.</p></section>';}
if(token){load();}else{showLogin();}
</script></body></html>`;
}
