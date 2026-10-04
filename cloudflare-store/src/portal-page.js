// The player portal: the live board per team, tile details, standings, the team's credit
// requests, and a request form that starts from the tile a player is looking at.
import { HEAD, CSS, SHARED_JS } from './theme.js';

export function portalPage()
{
	return `<!doctype html><html lang="en"><head>${HEAD}<title>Irons Pub Bingo</title><style>${CSS}
.layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,1fr);gap:18px;margin:18px auto 40px}.layout>*{min-width:0}
.teams{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 0}
.team{display:inline-flex;align-items:center;gap:9px;padding:9px 14px;border-radius:11px;border:1px solid var(--line2);background:var(--panel);color:var(--ink2);cursor:pointer;font:600 14px var(--sans)}
.team:hover{border-color:#4a5e75;color:var(--ink)}.team.on{border-color:var(--gold);color:var(--gold2);background:linear-gradient(180deg,#221d12,#17140d)}
.team .pts{font:700 12px var(--sans);color:var(--muted)}.team.on .pts{color:var(--gold)}
.medal{font-size:15px}
.stats{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 14px;color:var(--ink2)}.stats b{color:var(--gold2);font:700 18px var(--serif)}
.goal{padding:10px 0;border-top:1px solid var(--line)}.goal:first-child{border-top:0}
.goal .bar{margin:7px 0 8px}.contrib{display:flex;flex-wrap:wrap;gap:6px}
.detail h2{margin-bottom:6px;overflow-wrap:anywhere}
.stand{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}.stand:first-child{border-top:0}
.stand .n{width:26px;text-align:center;font:700 14px var(--serif);color:var(--muted)}
.req{padding:14px 0;border-top:1px solid var(--line)}.req:first-child{border-top:0}
.req .head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
.req .what{color:var(--ink2);overflow-wrap:anywhere}
.side{display:flex;flex-direction:column;gap:18px}
@media (max-width:960px){.layout{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.teams{gap:6px}.team{padding:7px 10px;font-size:13px}.stats{gap:10px;font-size:13px}.stats b{font-size:16px}}
</style></head><body>
<header class="top"><div class="wrap">
<div class="brand"><img src="/assets/logo.png" alt="Irons Pub"><div><h1>Irons Pub Bingo</h1><div class="sub" id="sub">Loading the board...</div></div></div>
<div class="spacer"></div>
<span class="row small muted" id="live"><span class="dot"></span><span id="updated">Live</span></span>
<button class="btn sm" id="refresh" title="Refresh now">&#8635; Refresh</button>
</div></header>
<div class="wrap">
<div class="teams" id="teams"></div>
<div class="layout">
<section class="card"><div class="stats" id="stats"></div><div id="board"></div></section>
<aside class="side">
<section class="card detail" id="detail"></section>
<section class="card"><h2>Standings</h2><div id="standings"></div></section>
</aside>
<section class="card" style="grid-column:1/-1">
<div class="row" style="margin-bottom:6px"><h2 class="grow" style="margin:0">Credit requests</h2>
<div class="seg" id="reqFilter"></div></div>
<p class="muted small" style="margin:0 0 6px">Requests count once an admin approves them. Link screenshots as proof.</p>
<div id="requests"></div></section>
</div></div>
<div class="toast" id="toast"></div>
<div id="modalRoot"></div>
<script>${SHARED_JS}
var base=location.pathname.replace(/\\/$/,'');var data=null,teamIndex=0,selected=-1,filter='All';
try{teamIndex=+(localStorage.getItem('ipb.team.'+base)||0);}catch(e){}
function toast(text,cls){var d=document.createElement('div');d.className=cls||'';d.textContent=text;document.getElementById('toast').appendChild(d);setTimeout(function(){d.remove();},6000);}
function load(quiet){return fetch(base+'/data').then(function(r){return r.json();}).then(function(j){data=j;render();
document.getElementById('updated').textContent='Updated '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});})
.catch(function(){if(!quiet){toast('Could not load the board. Check your connection.','bad');}});}
function team(){return data.teams[teamIndex]||data.teams[0];}
function ranked(){return data.teams.filter(function(t){return t.points!=null;}).slice().sort(function(a,b){return b.points-a.points;});}
function medal(t){var i=ranked().indexOf(t);return i===0?'&#129351;':i===1?'&#129352;':i===2?'&#129353;':'';}
function render(){if(!data.teams.length){document.getElementById('board').innerHTML='<div class="empty">The host has not set up any teams yet.</div>';document.getElementById('sub').textContent='No teams yet';return;}
if(teamIndex>=data.teams.length){teamIndex=0;}
document.getElementById('sub').textContent=(data.event.name||'Bingo board')+(data.event.size?' \\u00b7 '+data.event.size+'x'+data.event.size:'');
document.title=(data.event.name||'Bingo')+' \\u00b7 Irons Pub Bingo';
var tb=document.getElementById('teams');tb.innerHTML='';data.teams.forEach(function(t,i){var b=document.createElement('button');b.className='team'+(i===teamIndex?' on':'');
b.innerHTML=(medal(t)?'<span class="medal">'+medal(t)+'</span>':'')+esc(t.name)+(t.points!=null?'<span class="pts">'+t.points+' pts</span>':'');
b.onclick=function(){teamIndex=i;selected=-1;try{localStorage.setItem('ipb.team.'+base,i);}catch(e){}render();};tb.appendChild(b);});
var t=team(),boardEl=document.getElementById('board');
if(!t.board){boardEl.innerHTML='<div class="empty">No board for this team yet. It appears once the host pastes the board code or a player syncs.</div>';document.getElementById('stats').innerHTML='';}
else{renderBoard(boardEl,t.board,data.event.diagonals,selected,function(i){selected=i;render();if(innerWidth<960){document.getElementById('detail').scrollIntoView({behavior:'smooth'});}});
document.getElementById('stats').innerHTML='<span><b>'+t.board.done+'</b> / '+t.board.tiles.length+' tiles</span><span><b>'+t.board.lines+'</b> line'+(t.board.lines===1?'':'s')+'</span>'
+(t.points!=null?'<span><b>'+t.points+'</b> points</span>':'')+'<span class="muted">'+t.members.length+' member'+(t.members.length===1?'':'s')+'</span>';}
renderDetail(t);renderStandings();renderRequests(t);}
function renderDetail(t){var el=document.getElementById('detail');
if(!t.board||selected<0||!t.board.tiles[selected]){el.innerHTML='<h2>Pick a tile</h2><p class="muted">Select a tile on the board to see its goals, who contributed what, and to ask an admin for credit the tracker missed.</p>'
+(t.members.length?'<h3 style="margin-top:14px">Team members</h3><div class="contrib">'+t.members.map(function(m){return '<span class="chip">'+esc(m)+'</span>';}).join('')+'</div>':'');return;}
var tile=t.board.tiles[selected];
el.innerHTML='<div class="row" style="align-items:flex-start;gap:12px">'+(iconUrl(tile.icon)?'<img src="'+esc(iconUrl(tile.icon))+'" alt="" style="width:40px;height:40px;object-fit:contain;image-rendering:pixelated" onerror="this.remove()">':'')
+'<div class="grow"><h2>'+esc(tile.label)+'</h2><div class="row" style="gap:6px">'+(tile.done?'<span class="chip done">&#10003; Complete</span>':'')
+(tile.points!=null?'<span class="chip gold">'+tile.points+' pts</span>':'')+(tile.goals.length>1?'<span class="chip">'+(tile.mode==='ANY'?'Complete any goal':'Complete all goals')+'</span>':'')+'</div></div></div>'
+(tile.description?'<p style="color:var(--ink2);overflow-wrap:anywhere">'+esc(tile.description)+'</p>':'')
+'<div style="margin-top:8px">'+goalsHtml(tile)+'</div>'
+'<div class="row" style="margin-top:14px"><button class="btn gold" id="askCredit">Request credit for this tile</button></div>';
document.getElementById('askCredit').onclick=function(){openForm(selected);};}
function renderStandings(){var el=document.getElementById('standings'),list=ranked();
if(!list.length){el.innerHTML='<p class="muted small">Points appear once players sync.</p>';return;}
el.innerHTML=list.map(function(t,i){return '<div class="stand"><span class="n">'+(medal(t)||(i+1))+'</span><span class="grow" style="overflow-wrap:anywhere">'+esc(t.name)+'</span><b class="nowrap" style="color:var(--gold2)">'+t.points+' pts</b></div>';}).join('');}
function renderRequests(t){var seg=document.getElementById('reqFilter'),mine=data.requests.filter(function(r){return r.team===t.code;});
seg.innerHTML='';['All','Pending','Done','Rejected'].forEach(function(f){var n=f==='All'?mine.length:mine.filter(function(r){return r.status===f;}).length;
var b=document.createElement('button');b.className=f===filter?'on':'';b.innerHTML=(f==='Done'?'Approved':f)+(n?' <span class="badge">'+n+'</span>':'');b.onclick=function(){filter=f;renderRequests(t);};seg.appendChild(b);});
var list=filter==='All'?mine:mine.filter(function(r){return r.status===filter;});var el=document.getElementById('requests');
if(!list.length){el.innerHTML='<div class="empty">No requests here.</div>';return;}
el.innerHTML=list.map(function(r){var credit=r.complete?'whole tile':'+'+r.add;
return '<div class="req"><div class="head"><span class="chip '+r.status.toLowerCase()+'">'+(r.status==='Done'?'Approved':r.status)+'</span><b>'+esc(r.player)+'</b>'
+'<span class="what">'+esc(r.tileLabel||('Tile '+r.tile))+(r.goalLabel?' \\u00b7 '+esc(r.goalLabel):'')+' \\u00b7 <b>'+esc(credit)+'</b></span>'
+'<span class="spacer"></span><span class="small muted" title="'+esc(r.when)+'">'+ago(r.when)+'</span></div>'
+(r.note?'<div style="margin:0 0 8px;color:var(--ink2)">'+clampHtml(r.note)+'</div>':'')+linksHtml(r.links)+'</div>';}).join('');fixClamps(el);}
function openForm(tileIndex){var t=team();if(!t.board){return;}var player='';try{player=localStorage.getItem('ipb.player')||'';}catch(e){}
var members=t.members.slice().sort(function(a,b){return a.toLowerCase()<b.toLowerCase()?-1:1;}),known=members.indexOf(player)>=0;
var root=document.getElementById('modalRoot');
root.innerHTML='<div class="modal" id="modal"><div class="card"><h2>Request credit</h2><p class="muted small" style="margin-top:-4px">For progress the tracker missed. An admin reviews it before it counts.</p>'
+'<div class="grid2"><label class="field"><span>Your in-game name</span>'+(members.length?'<select id="fWho">'+(known?'':'<option value="" selected disabled>Pick your name</option>')
+members.map(function(m){return '<option'+(m===player?' selected':'')+'>'+esc(m)+'</option>';}).join('')+'<option value="__other__">Not listed, type it</option></select>':'')
+'<input id="fPlayer" maxlength="40" autocomplete="nickname" placeholder="Your in-game name" value="'+esc(members.length?'':player)+'"'+(members.length?' style="display:none;margin-top:6px"':'')+'>'
+(members.length?'':'<div class="hint">Nobody on this team has synced yet, so type your name.</div>')+'</label>'
+'<label class="field"><span>Team</span><input value="'+esc(t.name)+'" disabled></label></div>'
+'<label class="field" style="margin-top:12px"><span>Tile</span><select id="fTile">'+t.board.tiles.map(function(x,i){return '<option value="'+i+'"'+(i===tileIndex?' selected':'')+'>'+(i+1)+'. '+esc(x.label)+'</option>';}).join('')+'</select></label>'
+'<label class="field" style="margin-top:12px"><span>What to credit</span><select id="fGoal"></select></label>'
+'<label class="field" style="margin-top:12px" id="fAmountWrap"><span>Amount</span><input id="fAmount" type="number" min="1" step="1" placeholder="How many"></label>'
+'<label class="field" style="margin-top:12px"><span>Note for the admin</span><textarea id="fNote" rows="3" maxlength="300" placeholder="What happened, and when"></textarea></label>'
+'<label class="field" style="margin-top:12px"><span>Proof links</span><textarea id="fLinks" rows="2" placeholder="Screenshot links, one per line"></textarea><div class="hint">Discord, Imgur or similar. Up to 5.</div></label>'
+'<div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn ghost" id="fCancel">Cancel</button><button class="btn gold" id="fSend">Send request</button></div></div></div>';
var tileSel=document.getElementById('fTile'),goalSel=document.getElementById('fGoal'),who=document.getElementById('fWho'),typed=document.getElementById('fPlayer');
if(who){who.onchange=function(){var other=who.value==='__other__';typed.style.display=other?'':'none';if(other){typed.focus();}};}
function playerName(){return who&&who.value!=='__other__'?who.value:typed.value.trim();}
function fillGoals(){var tile=t.board.tiles[+tileSel.value],opts='';tile.goals.forEach(function(g,i){if(!g.manual){opts+='<option value="'+(i+1)+'">'+esc(g.label)+' ('+fmt(g.total)+' / '+fmt(g.target)+')</option>';}});
opts+='<option value="complete">The whole tile is complete</option>';goalSel.innerHTML=opts;toggle();}
function toggle(){document.getElementById('fAmountWrap').style.display=goalSel.value==='complete'?'none':'';}
tileSel.onchange=fillGoals;goalSel.onchange=toggle;fillGoals();
document.getElementById('fCancel').onclick=function(){root.innerHTML='';};
document.getElementById('modal').onclick=function(e){if(e.target.id==='modal'){root.innerHTML='';}};
document.getElementById('fSend').onclick=function(){var name=playerName(),complete=goalSel.value==='complete',amount=document.getElementById('fAmount').value;
if(!name){toast(who&&who.value!=='__other__'?'Pick your name.':'Fill in your in-game name.','bad');return;}if(!complete&&!(+amount>0)){toast('Fill in how many to credit, or pick the whole tile.','bad');return;}
try{localStorage.setItem('ipb.player',name);}catch(e){}var btn=this;btn.disabled=true;
fetch(base+'/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fn:'submitFormRequest',args:[{board:t.board.key,player:name,tile:+tileSel.value+1,
goal:complete?'':+goalSel.value,add:complete?'':amount,complete:complete,note:document.getElementById('fNote').value,links:document.getElementById('fLinks').value}]})})
.then(function(r){return r.json();}).then(function(j){btn.disabled=false;if(j.error){toast(j.error,'bad');return;}root.innerHTML='';toast(j.result||'Request sent.','ok');filter='Pending';load(true);})
.catch(function(){btn.disabled=false;toast('Could not send the request. Try again.','bad');});};}
document.getElementById('refresh').onclick=function(){load();};
load();setInterval(function(){if(!document.hidden){load(true);}},60000);
document.addEventListener('visibilitychange',function(){if(!document.hidden){load(true);}});
</script></body></html>`;
}
