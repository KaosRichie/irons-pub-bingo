// The admin page: edits the tabs admins used in the Google Sheet and runs its menu actions.
// The admin token is typed once and kept in this browser's localStorage, never in the URL.
export const ADMIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Irons Pub Bingo admin</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#dddcd6;--accent:#b5651d;--ok:#2e7d32;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#18181a;--card:#222225;--ink:#ececee;--muted:#9a9aa1;--line:#38383d;--accent:#e09a4f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0 12px 0 0}main{padding:16px 20px;max-width:1200px}
input,select,textarea,button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 8px}
button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}.tabs button.on{border-color:var(--accent);color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
.scroll{overflow-x:auto}table{border-collapse:collapse;min-width:100%}td,th{border:1px solid var(--line);padding:0;vertical-align:top}
th{background:var(--bg);font-weight:600;padding:4px 6px;text-align:left;white-space:nowrap}
td input,td select{border:0;border-radius:0;width:100%;min-width:90px;background:transparent}
td.ro{padding:4px 6px;white-space:pre-wrap}textarea{width:100%;min-height:260px;font-family:ui-monospace,monospace;font-size:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.muted{color:var(--muted)}
#log{white-space:pre-wrap;font-size:13px}#log .bad{color:var(--bad)}#log .ok{color:var(--ok)}
</style></head><body>
<header><h1>Irons Pub Bingo admin</h1>
<input id="token" type="password" placeholder="Admin token" size="28">
<button class="primary" id="load">Load</button><span class="muted" id="event"></span></header>
<main>
<div class="tabs" id="tabs"></div>
<div class="card" id="editor"><span class="muted">Enter the admin token and press Load.</span></div>
<div class="card"><div class="row">
<button data-act="applyBoardUpdate">Apply pasted board update</button>
<button data-act="refreshViews">Refresh board views</button>
<span class="muted">Reset a tile:</span><input id="rtTeam" placeholder="team code" size="10"><input id="rtTile" placeholder="tile #" size="5">
<button data-act="resetTile">Reset tile</button>
<button data-act="resetStore">Reset store data...</button></div></div>
<div class="card"><div id="log" class="muted">Messages appear here.</div></div>
</main>
<script>
var EDITABLE=["Teams","Board code","Settings","Adjustments","Requests"];
var current=null,rows=[];
var api=location.pathname.replace(/\\/admin\\/?$/,"")+"/admin/api";
document.getElementById("event").textContent="Event: "+location.pathname.split("/")[2];
var tokenBox=document.getElementById("token");
try{tokenBox.value=localStorage.getItem("ipbToken")||"";}catch(e){}
function log(text,cls){var el=document.getElementById("log");el.className="";el.innerHTML="";var d=document.createElement("div");d.className=cls||"";d.textContent=text;el.appendChild(d);}
function call(body){try{localStorage.setItem("ipbToken",tokenBox.value);}catch(e){}
return fetch(api,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+tokenBox.value},body:JSON.stringify(body)})
.then(function(r){return r.json();}).then(function(j){if(j.error){throw new Error(j.error);}if(j.alerts&&j.alerts.length){log(j.alerts.join("\\n\\n"),"ok");}return j.result;});}
function loadTabs(){return call({action:"tabs"}).then(function(list){var box=document.getElementById("tabs");box.innerHTML="";
list.filter(function(t){return !t.hidden;}).forEach(function(t){var b=document.createElement("button");b.textContent=t.name;b.onclick=function(){openTab(t.name);};if(t.name===current){b.className="on";}box.appendChild(b);});
if(!current){openTab("Requests");}}).catch(function(e){log(e.message,"bad");});}
function openTab(name){current=name;call({action:"getTab",name:name}).then(function(data){rows=data||[];render();loadTabsQuiet();}).catch(function(e){log(e.message,"bad");});}
function loadTabsQuiet(){Array.prototype.forEach.call(document.querySelectorAll("#tabs button"),function(b){b.className=b.textContent===current?"on":"";});}
function render(){var ed=document.getElementById("editor");ed.innerHTML="";var editable=EDITABLE.indexOf(current)>=0;
var title=document.createElement("h3");title.style.margin="0 0 10px";title.textContent=current+(editable?"":" (read only)");ed.appendChild(title);
if(current==="Board code"){var ta=document.createElement("textarea");ta.value=rows.slice(1).map(function(r){return r[0]==null?"":String(r[0]);}).join("\\n");ed.appendChild(ta);
var save=document.createElement("button");save.className="primary";save.textContent="Save board code";save.onclick=function(){var head=rows[0]||["Paste the board code below"];saveTab([head,[ta.value.trim()]]);};
var row=document.createElement("div");row.className="row";row.style.marginTop="8px";row.appendChild(save);ed.appendChild(row);return;}
var width=rows.reduce(function(m,r){return Math.max(m,(r||[]).length);},1);var wrap=document.createElement("div");wrap.className="scroll";var table=document.createElement("table");
rows.forEach(function(r,i){var tr=document.createElement("tr");for(var c=0;c<width;c++){var v=r&&r[c]!=null?String(r[c]):"";
if(i===0){var th=document.createElement("th");th.textContent=v;tr.appendChild(th);continue;}
var td=document.createElement("td");if(!editable){td.className="ro";td.textContent=v;}
else if(current==="Requests"&&c===9){var s=document.createElement("select");["Pending","Done","Rejected"].forEach(function(o){var op=document.createElement("option");op.textContent=o;if((v||"Pending")===o){op.selected=true;}s.appendChild(op);});s.dataset.r=i;s.dataset.c=c;td.appendChild(s);}
else{var inp=document.createElement("input");inp.value=v;inp.dataset.r=i;inp.dataset.c=c;td.appendChild(inp);}tr.appendChild(td);}table.appendChild(tr);});
wrap.appendChild(table);ed.appendChild(wrap);if(!editable){return;}
var bar=document.createElement("div");bar.className="row";bar.style.marginTop="10px";
var add=document.createElement("button");add.textContent="Add row";add.onclick=function(){collect();rows.push(new Array(width).fill(""));render();};
var save2=document.createElement("button");save2.className="primary";save2.textContent="Save "+current;save2.onclick=function(){collect();saveTab(rows);};
bar.appendChild(add);bar.appendChild(save2);ed.appendChild(bar);}
function collect(){Array.prototype.forEach.call(document.querySelectorAll("#editor [data-r]"),function(el){var r=+el.dataset.r,c=+el.dataset.c;while(rows[r].length<=c){rows[r].push("");}rows[r][c]=el.value;});}
function saveTab(data){call({action:"setTab",name:current,rows:data}).then(function(res){if(res&&res.error){throw new Error(res.error);}log("Saved "+current+" ("+(res?res.changed:0)+" changed row(s)).","ok");openTab(current);}).catch(function(e){log(e.message,"bad");});}
document.getElementById("load").onclick=function(){current=null;loadTabs();};
Array.prototype.forEach.call(document.querySelectorAll("[data-act]"),function(b){b.onclick=function(){var act=b.dataset.act;var body={action:act};
if(act==="resetTile"){body.team=document.getElementById("rtTeam").value;body.tile=document.getElementById("rtTile").value;if(!confirm("Reset tile "+body.tile+" for team "+body.team+"?")){return;}}
if(act==="resetStore"&&!confirm("This clears ALL event data except Settings. Continue?")){return;}
call(body).then(function(){if(current){openTab(current);}loadTabs();}).catch(function(e){log(e.message,"bad");});};});
</script></body></html>`;
