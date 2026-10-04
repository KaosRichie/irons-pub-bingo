// The Iron's Pub look shared by the portal and the admin page: the logo's night-blue ground,
// deep green bingo tiles, gold serif lettering and ember accents.

export const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/assets/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;

export const CSS = `
:root{color-scheme:dark;
--bg:#0c1016;--bg2:#121820;--panel:#161d26;--panel2:#1c2530;--panel3:#232e3b;--line:#2a3644;--line2:#36475a;
--ink:#efe8d6;--ink2:#cfc7b3;--muted:#8f9aa6;--gold:#e2ad48;--gold2:#f7d683;--gold3:#a87522;
--green:#173d29;--green2:#22573a;--green3:#3f9a62;--ember:#e8743b;--red:#e2625a;--redbg:#3a1d1d;
--amber:#e7b04a;--amberbg:#3a2e17;--ok:#62c487;--okbg:#17321f;--radius:12px;
--serif:'Cinzel',Georgia,'Times New Roman',serif;--sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
*{box-sizing:border-box}html,body{margin:0}[hidden]{display:none!important}
body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);min-height:100vh;
background-image:radial-gradient(circle at 12% 18%,rgba(232,116,59,.10) 0 1.5px,transparent 2px),
radial-gradient(circle at 78% 64%,rgba(232,116,59,.08) 0 1.5px,transparent 2px),
radial-gradient(circle at 44% 86%,rgba(247,214,131,.06) 0 1px,transparent 1.5px),
linear-gradient(180deg,#0e141c 0%,#0b0f15 100%);background-size:340px 340px,460px 460px,280px 280px,100% 100%;background-attachment:fixed}
a{color:var(--gold2)}a:hover{color:#fff3c8}
.wrap{max-width:1280px;margin:0 auto;padding:0 20px}
header.top{border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(18,24,32,.96),rgba(12,16,22,.92));position:sticky;top:0;z-index:20;backdrop-filter:blur(6px)}
header.top .wrap{display:flex;align-items:center;gap:14px;min-height:72px;flex-wrap:wrap;padding-top:8px;padding-bottom:8px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand img{width:48px;height:48px;border-radius:10px;box-shadow:0 0 0 1px var(--gold3),0 4px 18px rgba(0,0,0,.5)}
.brand h1{font:700 22px/1.1 var(--serif);margin:0;letter-spacing:.04em;
background:linear-gradient(180deg,var(--gold2),var(--gold) 55%,var(--gold3));-webkit-background-clip:text;background-clip:text;color:transparent}
.brand .sub{color:var(--muted);font-size:13px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
.spacer{flex:1}
h2{font:700 18px/1.2 var(--serif);color:var(--gold2);letter-spacing:.03em;margin:0 0 12px}
h3{font:600 15px/1.3 var(--sans);margin:0 0 8px;color:var(--ink)}
.card{background:linear-gradient(180deg,var(--panel),#141a22);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.muted{color:var(--muted)}.small{font-size:12.5px}.nowrap{white-space:nowrap}
.btn{font:600 13.5px/1 var(--sans);display:inline-flex;align-items:center;gap:7px;padding:9px 14px;border-radius:9px;
border:1px solid var(--line2);background:var(--panel2);color:var(--ink);cursor:pointer;text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s,transform .05s}
.btn:hover{background:var(--panel3);border-color:#4a5e75;color:var(--ink)}.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.gold{background:linear-gradient(180deg,#f0c463,#d49a32);border-color:#f3cf7c;color:#1d1406}
.btn.gold:hover{background:linear-gradient(180deg,#f7d27a,#dea73e);color:#1d1406}
.btn.ok{background:var(--okbg);border-color:#2f6a43;color:#bdf0cf}.btn.ok:hover{background:#1d4029}
.btn.bad{background:var(--redbg);border-color:#6a2f2f;color:#ffc9c4}.btn.bad:hover{background:#4a2424}
.btn.ghost{background:transparent;border-color:transparent;color:var(--muted)}.btn.ghost:hover{color:var(--ink);background:var(--panel2)}
.btn.sm{padding:6px 10px;font-size:12.5px;border-radius:8px}
input,select,textarea{font:inherit;color:var(--ink);background:var(--bg2);border:1px solid var(--line2);border-radius:9px;padding:9px 11px;outline:none;width:100%;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(226,173,72,.18)}
select{appearance:none;-webkit-appearance:none;padding-right:34px;cursor:pointer;
background-image:linear-gradient(45deg,transparent 50%,var(--gold) 50%),linear-gradient(135deg,var(--gold) 50%,transparent 50%);
background-position:calc(100% - 18px) 55%,calc(100% - 13px) 55%;background-size:5px 5px;background-repeat:no-repeat}
option,optgroup{background:#1c2530;color:var(--ink)}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--gold);padding:0}
label.field{display:block}label.field>span{display:block;font-size:12.5px;font-weight:600;color:var(--ink2);margin:0 0 6px}
.hint{font-size:12.5px;color:var(--muted);margin-top:5px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.chip{display:inline-flex;align-items:center;gap:6px;font:600 12px/1 var(--sans);padding:5px 9px;border-radius:999px;border:1px solid var(--line2);background:var(--panel2);color:var(--ink2);white-space:nowrap}
.chip.pending{background:var(--amberbg);border-color:#6b5320;color:#ffe2a3}
.chip.done{background:var(--okbg);border-color:#2f6a43;color:#bdf0cf}
.chip.rejected{background:var(--redbg);border-color:#6a2f2f;color:#ffc9c4}
.chip.gold{background:rgba(226,173,72,.14);border-color:var(--gold3);color:var(--gold2)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(98,196,135,.6);animation:pulse 2.2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(98,196,135,.55)}70%{box-shadow:0 0 0 8px rgba(98,196,135,0)}100%{box-shadow:0 0 0 0 rgba(98,196,135,0)}}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:10px;overflow:hidden;background:var(--bg2)}
.seg button{font:600 13px/1 var(--sans);color:var(--muted);background:transparent;border:0;padding:9px 13px;cursor:pointer;display:inline-flex;gap:7px;align-items:center}
.seg button+button{border-left:1px solid var(--line2)}
.seg button.on{color:#1d1406;background:linear-gradient(180deg,#f0c463,#d49a32)}
.badge{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--ember);color:#fff;font:700 11.5px/20px var(--sans);text-align:center}
.seg button.on .badge{background:#1d1406;color:var(--gold2)}
.bar{height:8px;background:#0b1016;border:1px solid var(--line);border-radius:999px;overflow:hidden}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--gold3),var(--gold),var(--gold2));border-radius:999px}
.bar.full>i{background:linear-gradient(90deg,#2e7a4c,var(--green3),#7fdc9f)}
.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.clamp.open{-webkit-line-clamp:unset;display:block}
.more{font:600 12px var(--sans);color:var(--gold2);background:none;border:0;padding:2px 0;cursor:pointer}
.links{display:flex;flex-wrap:wrap;gap:6px}
.link{display:inline-flex;align-items:center;gap:5px;max-width:220px;font:600 12px/1 var(--sans);padding:6px 9px;border-radius:8px;background:rgba(226,173,72,.10);border:1px solid var(--gold3);color:var(--gold2);text-decoration:none}
.link span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.link:hover{background:rgba(226,173,72,.2);color:#fff3c8}
.empty{padding:28px;text-align:center;color:var(--muted);border:1px dashed var(--line2);border-radius:var(--radius)}
.toast{position:fixed;right:18px;bottom:18px;z-index:99;display:flex;flex-direction:column;gap:8px;max-width:min(440px,calc(100vw - 36px))}
.toast div{background:var(--panel2);border:1px solid var(--line2);border-left:4px solid var(--gold);border-radius:10px;padding:12px 14px;box-shadow:0 12px 30px rgba(0,0,0,.45);white-space:pre-wrap;overflow-wrap:anywhere;animation:in .2s ease-out}
.toast div.bad{border-left-color:var(--red)}.toast div.ok{border-left-color:var(--ok)}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.modal{position:fixed;inset:0;background:rgba(5,8,12,.72);display:flex;align-items:center;justify-content:center;padding:18px;z-index:50}
.modal .card{width:min(560px,100%);max-height:calc(100vh - 36px);overflow:auto}
/* board */
.board{position:relative;display:grid;gap:8px;user-select:none}
.tile{position:relative;aspect-ratio:1;border-radius:10px;border:1px solid #243243;padding:8px;cursor:pointer;overflow:hidden;
background:linear-gradient(160deg,#16202b,#101820);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;text-align:center;
transition:transform .12s,border-color .12s,box-shadow .12s}
.tile:hover{transform:translateY(-2px);border-color:#4a6078;box-shadow:0 8px 18px rgba(0,0,0,.35)}
.tile.sel{border-color:var(--gold);box-shadow:0 0 0 2px rgba(226,173,72,.45)}
.tile.done{background:linear-gradient(160deg,#245c3c,#173d29 70%);border-color:#4aa36c}
.tile.done::after{content:'';position:absolute;inset:0;border-radius:10px;box-shadow:inset 0 0 0 1px rgba(247,214,131,.35)}
.tile img{width:36%;max-width:44px;aspect-ratio:1;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 2px 2px rgba(0,0,0,.6))}
.tile{min-width:0}.tile .name{font:600 12px/1.25 var(--sans);color:var(--ink);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:break-word;hyphens:auto;max-width:100%}
.tile .num{position:absolute;top:5px;left:7px;font:700 10.5px var(--sans);color:var(--muted)}
.tile .check{position:absolute;top:5px;right:6px;width:18px;height:18px;border-radius:50%;background:var(--gold);color:#1d1406;font:800 11px/18px var(--sans)}
.tile .prog{position:absolute;left:8px;right:8px;bottom:7px;height:4px;border-radius:9px;background:rgba(0,0,0,.45);overflow:hidden}
.tile .prog i{display:block;height:100%;background:linear-gradient(90deg,var(--gold3),var(--gold2))}
.lines{position:absolute;inset:0;pointer-events:none;overflow:visible}
.lines line{stroke:var(--gold2);stroke-width:2.5;stroke-linecap:round;opacity:.55;filter:drop-shadow(0 0 4px rgba(247,214,131,.5))}
@media (max-width:640px){.tile{padding:4px 4px 10px;gap:3px;border-radius:8px}.tile .name{font-size:10px;line-height:1.2;-webkit-line-clamp:2}.tile .num{display:none}.tile .check{width:14px;height:14px;font-size:9px;line-height:14px;top:3px;right:3px}.tile .prog{bottom:4px;left:5px;right:5px;height:3px}.tile img{width:30%}.board{gap:4px}.wrap{padding:0 12px}.card{padding:14px}}
`;

// Client helpers both pages use: escaping, links, time, and the board grid.
export const SHARED_JS = `
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function host(u){try{return new URL(u).hostname.replace(/^www\\./,'');}catch(e){return 'link';}}
function linksHtml(links){if(!links||!links.length){return '<span class="muted small">No proof</span>';}
return '<div class="links">'+links.map(function(u){return '<a class="link" href="'+esc(u)+'" target="_blank" rel="noopener noreferrer" title="'+esc(u)+'">&#128279;<span>'+esc(host(u))+'</span></a>';}).join('')+'</div>';}
function ago(iso){var t=Date.parse(iso);if(isNaN(t)){return '';}var s=Math.max(0,(Date.now()-t)/1000);
if(s<60){return 'just now';}if(s<3600){return Math.floor(s/60)+' min ago';}if(s<86400){return Math.floor(s/3600)+' h ago';}
return Math.floor(s/86400)+' d ago';}
function fmt(n){n=Number(n)||0;return n>=10000?(Math.round(n/100)/10)+'k':String(n);}
function clampHtml(text){if(!text){return '<span class="muted small">-</span>';}
return '<div class="clamp">'+esc(text)+'</div><button class="more" hidden onclick="var c=this.previousElementSibling;c.classList.toggle(\\'open\\');this.textContent=c.classList.contains(\\'open\\')?\\'Show less\\':\\'Show more\\'">Show more</button>';}
function fixClamps(root){Array.prototype.forEach.call((root||document).querySelectorAll('.clamp:not(.open)'),function(c){var b=c.nextElementSibling;if(b&&b.classList.contains('more')){b.hidden=c.scrollHeight<=c.clientHeight+2;}});}
addEventListener('resize',function(){fixClamps();});
function iconUrl(icon){if(icon==null||icon===''){return null;}var s=String(icon).trim();
if(/^\\d+$/.test(s)){return 'https://static.runelite.net/cache/item/icon/'+s+'.png';}
s=s.charAt(0).toUpperCase()+s.slice(1);return 'https://oldschool.runescape.wiki/images/'+encodeURIComponent(s.replace(/ /g,'_'))+'.png';}
function tileFraction(tile){var best=0;tile.goals.forEach(function(g){if(!g.manual&&g.target>0){best=Math.max(best,Math.min(1,g.total/g.target));}});return tile.done?1:best;}
function doneLines(board,diagonals){var n=board.size,d=board.tiles.map(function(t){return t.done;}),out=[];
for(var r=0;r<n;r++){var ok=true;for(var c=0;c<n;c++){ok=ok&&d[r*n+c];}if(ok){out.push([0,r,n-1,r]);}}
for(var c2=0;c2<n;c2++){var ok2=true;for(var r2=0;r2<n;r2++){ok2=ok2&&d[r2*n+c2];}if(ok2){out.push([c2,0,c2,n-1]);}}
if(diagonals){var a=true,b=true;for(var i=0;i<n;i++){a=a&&d[i*n+i];b=b&&d[i*n+(n-1-i)];}if(a){out.push([0,0,n-1,n-1]);}if(b){out.push([n-1,0,0,n-1]);}}
return out;}
function renderBoard(el,board,diagonals,selected,onPick){
// Updates the tiles in place when the board is the same shape, so a click or a refresh never
// rebuilds the icons: re-created images can blank for a frame while the browser redraws them.
var tiles=Array.prototype.filter.call(el.children,function(c){return c.classList.contains('tile');});
var reuse=el.classList.contains('board')&&tiles.length===board.tiles.length;
if(!reuse){el.innerHTML='';el.className='board';tiles=[];}
el.style.gridTemplateColumns='repeat('+board.size+',minmax(0,1fr))';el._pick=onPick;
board.tiles.forEach(function(tile,i){var d=tiles[i];
if(!d){d=document.createElement('div');d.tabIndex=0;d.setAttribute('role','button');
d.onclick=function(){el._pick(i);};d.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();el._pick(i);}};el.appendChild(d);}
d.className='tile'+(tile.done?' done':'')+(i===selected?' sel':'');
d.setAttribute('aria-label',tile.label+(tile.done?', complete':''));
var url=iconUrl(tile.icon),frac=tileFraction(tile);
var html='<span class="num">'+(i+1)+'</span>'+(tile.done?'<span class="check">&#10003;</span>':'')
+(url?'<img alt="" loading="lazy" src="'+esc(url)+'" onerror="this.remove()">':'')
+'<span class="name">'+esc(tile.label)+'</span>'+(!tile.done&&frac>0?'<span class="prog"><i style="width:'+(frac*100).toFixed(0)+'%"></i></span>':'');
if(d._html!==html){d.innerHTML=html;d._html=html;}});
var old=el.querySelector('svg.lines');if(old){old.remove();}
var lines=doneLines(board,diagonals);if(!lines.length){return;}
var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','lines');
svg.setAttribute('viewBox','0 0 '+board.size+' '+board.size);svg.setAttribute('preserveAspectRatio','none');
lines.forEach(function(l){var ln=document.createElementNS('http://www.w3.org/2000/svg','line');
ln.setAttribute('x1',l[0]+.5);ln.setAttribute('y1',l[1]+.5);ln.setAttribute('x2',l[2]+.5);ln.setAttribute('y2',l[3]+.5);
ln.setAttribute('vector-effect','non-scaling-stroke');svg.appendChild(ln);});el.appendChild(svg);}
function goalsHtml(tile){return tile.goals.map(function(g){
if(g.manual){return '<div class="goal"><div class="row"><b class="grow">'+esc(g.label)+'</b>'+(tile.done?'<span class="chip done">Ticked</span>':'<span class="chip">Needs an admin tick</span>')+'</div>'
+(tile.tickedBy.length?'<div class="small muted">Ticked by '+esc(tile.tickedBy.join(', '))+'</div>':'')+'</div>';}
var frac=g.target>0?Math.min(1,g.total/g.target):0;
return '<div class="goal"><div class="row"><b class="grow" style="overflow-wrap:anywhere">'+esc(g.label)+'</b><span class="nowrap">'+fmt(g.total)+' / '+fmt(g.target)+'</span></div>'
+'<div class="bar'+(frac>=1?' full':'')+'"><i style="width:'+(frac*100).toFixed(1)+'%"></i></div>'
+(g.contributors.length?'<div class="contrib">'+g.contributors.map(function(c){var v=/\\(verified\\)$/.test(c.name);
return '<span class="chip'+(v?' gold':'')+'" title="'+(v?'Credited by an admin':'Tracked by the plugin')+'">'+esc(c.name.replace(/ \\(verified\\)$/,''))+(v?' &#10003;':'')+' <b>'+fmt(c.amount)+'</b></span>';}).join('')+'</div>':'<div class="small muted">No progress yet</div>')+'</div>';}).join('');}
`;
