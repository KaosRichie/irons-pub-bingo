// The top-level admin page: every event on this Worker, with links to each event's admin
// page and portal, a box to start a new event, and deleting one. Same password and sign-in
// as the event admin pages (kept in this browser's localStorage, never in a URL).
import { HEAD, CSS, SHARED_JS } from './theme.js';

export function topAdminPage()
{
	return `<!doctype html><html lang="en"><head>${HEAD}<title>Events · Irons Pub Bingo</title><style>${CSS}
.view{display:flex;flex-direction:column;gap:18px;margin:20px auto 40px}
.evrow{display:grid;grid-template-columns:minmax(0,1.6fr) 80px 80px 90px 100px minmax(0,1fr) 230px;gap:14px;padding:12px 0;border-top:1px solid var(--line);align-items:center}
.evrow:first-child{border-top:0}.evrow.head{font:600 11.5px var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-top:0}
.evrow>div{min-width:0;overflow-wrap:anywhere}.evrow .lbl{display:none;font:600 11px var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:3px}
.evrow .acts{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.evrow b{font-family:var(--serif)}.code{font:12.5px ui-monospace,Consolas,monospace;color:var(--muted)}
.newrow{display:flex;gap:10px;flex-wrap:wrap}.newrow input{max-width:300px}
.login{max-width:420px;margin:12vh auto}
@media (max-width:980px){.evrow{grid-template-columns:1fr 1fr}.evrow.head{display:none}.evrow .lbl{display:block}.evrow .acts{grid-column:1/-1;justify-content:flex-start}}
</style></head><body>
<header class="top"><div class="wrap">
<div class="brand"><img src="/assets/logo.png" alt="Irons Pub"><div><h1>Irons Pub Bingo</h1><div class="sub">All events</div></div></div>
<div class="spacer"></div><button class="btn sm ghost" id="signOut" hidden>Sign out</button>
</div></header>
<div class="wrap" id="app"></div>
<div class="toast" id="toast"></div><div id="modalRoot"></div>
<script>${SHARED_JS}
var token='';try{token=localStorage.getItem('ipb.adminToken')||'';}catch(e){}
function toast(text,cls){var d=document.createElement('div');d.className=cls||'';d.textContent=text;document.getElementById('toast').appendChild(d);setTimeout(function(){d.remove();},7000);}
function call(url,body){return fetch(url,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify(body)})
.then(function(r){if(r.status===401){var e=new Error('Wrong admin password');e.auth=true;throw e;}return r.json();})
.then(function(j){if(j.error){throw new Error(j.error);}if(j.result&&j.result.error){throw new Error(j.result.error);}return j.result;});}
function ago(iso){if(!iso){return '';}var s=Math.max(0,(Date.now()-Date.parse(iso))/1000);
return s<90?'just now':s<5400?Math.round(s/60)+' min ago':s<129600?Math.round(s/3600)+' h ago':Math.round(s/86400)+' days ago';}
function load(){return call('/admin/api',{action:'list'}).then(function(events){document.getElementById('signOut').hidden=false;render(events||[]);})
.catch(function(e){if(e.auth){showLogin(e.message);}else{toast(e.message,'bad');}});}
function showLogin(error){document.getElementById('signOut').hidden=true;document.getElementById('app').innerHTML='<div class="card login"><h2>Admin sign in</h2><p class="muted">Enter the admin password for this store.</p>'
+'<label class="field"><span>Admin password</span><input type="password" id="pw" autocomplete="current-password"></label>'+(error?'<p style="color:var(--red)">'+esc(error)+'</p>':'')
+'<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn gold" id="go">Sign in</button></div></div>';
var go=function(){token=document.getElementById('pw').value;try{localStorage.setItem('ipb.adminToken',token);}catch(e){}load();};
document.getElementById('go').onclick=go;document.getElementById('pw').onkeydown=function(e){if(e.key==='Enter'){go();}};document.getElementById('pw').focus();}
document.getElementById('signOut').onclick=function(){token='';try{localStorage.removeItem('ipb.adminToken');}catch(e){}showLogin();};
function render(events){var app=document.getElementById('app');
app.innerHTML='<div class="view"><section class="card"><h2>New event</h2><p class="muted" style="margin-top:-4px">Pick a code of 3 to 40 lowercase letters, digits and hyphens. The event exists once you save something on its admin page.</p>'
+'<div class="newrow"><input id="newCode" placeholder="summer-2026" maxlength="40"><button class="btn gold" id="create">Open its admin page</button></div></section>'
+'<section class="card"><h2>Events</h2><div id="list"></div><p class="small muted" style="margin-top:12px">Numbers update while an event is in use.</p></section></div>';
var input=document.getElementById('newCode');var open=function(){var code=input.value.trim().toLowerCase();
if(!/^[a-z0-9-]{3,40}$/.test(code)){toast('Use 3 to 40 lowercase letters, digits and hyphens.','bad');return;}location.href='/e/'+code+'/admin';};
document.getElementById('create').onclick=open;input.onkeydown=function(e){if(e.key==='Enter'){open();}};
var list=document.getElementById('list');
if(!events.length){list.innerHTML='<div class="empty">No events yet.</div>';return;}
list.innerHTML='<div class="evrow head"><div>Event</div><div>Teams</div><div>Players</div><div>Pending</div><div>Requests today</div><div>Last activity</div><div></div></div>'
+events.map(function(ev){return '<div class="evrow"><div><b>'+esc(ev.name||'No board yet')+'</b><div class="code">'+esc(ev.code)+'</div></div>'
+'<div><span class="lbl">Teams</span>'+(ev.teams||0)+'</div><div><span class="lbl">Players</span>'+(ev.players||0)+'</div>'
+'<div><span class="lbl">Pending</span>'+(ev.pending?'<span class="chip pending">'+ev.pending+'</span>':'0')+'</div>'
+'<div><span class="lbl">Requests today</span>'+(ev.requestsToday||0)+'</div>'
+'<div><span class="lbl">Last activity</span>'+esc(ago(ev.lastActivity))+'</div>'
+'<div class="acts"><a class="btn sm gold" href="/e/'+esc(ev.code)+'/admin">Admin</a><a class="btn sm" href="/e/'+esc(ev.code)+'" target="_blank" rel="noopener">Portal &#8599;</a>'
+'<button class="btn sm bad" data-del="'+esc(ev.code)+'">Delete</button></div></div>';}).join('');
Array.prototype.forEach.call(list.querySelectorAll('button[data-del]'),function(b){b.onclick=function(){askDelete(b.dataset.del);};});}
function askDelete(code){var root=document.getElementById('modalRoot');
root.innerHTML='<div class="modal"><div class="card"><h2>Delete '+esc(code)+'?</h2><p style="color:var(--ink2)">This deletes the whole event: teams, board code, synced progress, credit and requests. Players keep their own progress in the plugin.</p>'
+'<label class="field"><span>Type the event code to confirm</span><input id="delCode" placeholder="'+esc(code)+'"></label>'
+'<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" id="delNo">Cancel</button><button class="btn bad" id="delYes">Delete event</button></div></div></div>';
document.getElementById('delNo').onclick=function(){root.innerHTML='';};
document.getElementById('delYes').onclick=function(){if(document.getElementById('delCode').value.trim()!==code){toast('Type '+code+' to confirm.','bad');return;}
root.innerHTML='';call('/e/'+code+'/admin/api',{action:'deleteEvent'}).then(function(){toast('Deleted '+code+'.','ok');load();}).catch(function(e){toast(e.message,'bad');});};}
if(token){load();}else{showLogin();}
</script></body></html>`;
}
