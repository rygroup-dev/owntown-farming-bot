// ============ WEB DASHBOARD (zero-dependency) ============
// Serves a live, auto-refreshing dashboard + JSON data endpoint.
// Protected by a simple access key (?key=...).
const http = require('http');

function startDashboard({ port, key, getSnapshot, logger }) {
  const log = logger || (() => {});

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // JSON data endpoint (used by the page; also handy for scripts)
    if (url.pathname === '/data') {
      if (key && url.searchParams.get('key') !== key) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"forbidden"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getSnapshot()));
      return;
    }
    // HTML page
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      if (key && url.searchParams.get('key') !== key) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<h2>403 — add ?key=YOUR_KEY to the URL</h2>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE.replace('__KEY__', key || ''));
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  server.on('error', (e) => log('🖥️ Dashboard error: ' + e.message));
  server.listen(port, '0.0.0.0', () => log(`🖥️ Dashboard on http://0.0.0.0:${port}/?key=${key}`));
  return server;
}

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owntown Bot Dashboard</title>
<style>
:root{--bg:#0b0f17;--card:#141b2b;--line:#243049;--txt:#e6edf6;--mut:#8aa0c0;--grn:#3ddc84;--red:#ff5c5c;--yel:#ffcf5c;--acc:#5cc8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
header h1{font-size:16px;margin:0}.dot{width:10px;height:10px;border-radius:50%;background:var(--red)}.dot.on{background:var(--grn)}
.pill{font-size:12px;color:var(--mut);border:1px solid var(--line);padding:2px 8px;border-radius:99px}
.wrap{padding:16px;max-width:1100px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.card h2{margin:0 0 10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
.row{display:flex;justify-content:space-between;gap:10px;padding:3px 0}
.row b{font-weight:600}.big{font-size:26px;font-weight:700}.grn{color:var(--grn)}.red{color:var(--red)}.yel{color:var(--yel)}.acc{color:var(--acc)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--mut)}
pre{background:#0a0e16;border:1px solid var(--line);border-radius:10px;padding:10px;max-height:280px;overflow:auto;font-size:11.5px;color:#bcd}
.foot{color:var(--mut);font-size:12px;text-align:center;padding:14px}
</style></head><body>
<header><span class="dot" id="dot"></span><h1>🏭 Owntown Bot</h1><span class="pill" id="state">…</span><span class="pill" id="now" style="color:#5cffa0;border-color:#1f9e5a">…</span><span class="pill" id="uptime"></span><span class="pill" id="upd"></span></header>
<div class="wrap"><div class="grid">
 <div class="card"><h2>💰 Wallet & Balance</h2>
   <div class="row"><span>In-game</span><b class="big grn" id="bal">—</b></div>
   <div class="row"><span>Daily earned</span><b id="daily">—</b></div>
   <div class="row"><span>Bank</span><b id="bank">—</b></div>
   <div class="row"><span>Address</span></div><div class="mono" id="addr">—</div>
 </div>
 <div class="card"><h2>📈 Profit</h2>
   <div class="row"><span>Total earned</span><b class="big grn" id="total">—</b></div>
   <div class="row"><span>Rate / hour</span><b class="acc" id="rate">—</b></div>
   <div class="row"><span>QuickSell</span><b id="qs">—</b></div>
   <div class="row"><span>Marketplace</span><b id="mkt">—</b></div>
   <div class="row"><span>PvP</span><b id="pvp">—</b></div>
   <div class="row"><span>Items sold</span><b id="sold">—</b></div>
 </div>
 <div class="card"><h2>🧍 Character</h2>
   <div class="row"><span>Level</span><b id="lvl">—</b></div>
   <div class="row"><span>XP</span><b id="xp">—</b></div>
   <div class="row"><span>HP</span><b id="hp">—</b></div>
   <div class="row"><span>Stamina</span><b id="sta">—</b></div>
   <div class="row"><span>Zone</span><b id="zone">—</b></div>
   <div class="row"><span>Position</span><b id="pos">—</b></div>
   <div class="row"><span>Inventory</span><b id="inv">—</b></div>
 </div>
 <div class="card"><h2>🎯 Live target</h2>
   <div class="row"><span>Doing</span><b class="grn" id="doing">—</b></div>
   <div class="row"><span>Mining node</span><b id="node">—</b></div>
   <div class="row"><span>Monster</span><b id="mon">—</b></div>
 </div>
 <div class="card"><h2>⚙️ Activity</h2>
   <div class="row"><span>⛏ Mined</span><b id="mined">—</b></div>
   <div class="row"><span>🎣 Fished</span><b id="fished">—</b></div>
   <div class="row"><span>⚔ Kills</span><b id="kills">—</b></div>
   <div class="row"><span>🛒 Flips</span><b id="flips">—</b></div>
   <div class="row"><span>🔨 Crafts</span><b id="crafts">—</b></div>
   <div class="row"><span>👹 Boss claims</span><b id="boss">—</b></div>
   <div class="row"><span>⚠️ Errors</span><b id="err">—</b></div>
 </div>
 <div class="card" style="grid-column:1/-1"><h2>🗺️ Live map — posisi karakter</h2><canvas id="map" height="320"></canvas></div>
 <div class="card" style="grid-column:1/-1"><h2>📈 Profit / hour — last 12h</h2><canvas id="chart" height="200"></canvas></div>
 <div class="card" style="grid-column:1/-1"><h2>📊 Market prices</h2><div id="market" class="mono">—</div></div>
 <div class="card" style="grid-column:1/-1"><h2>📜 Recent log</h2><pre id="log">—</pre></div>
</div><div class="foot">auto-refresh 5s · Owntown Farming Bot</div></div>
<script>
const KEY="__KEY__";
let lastData=null;
const $=id=>document.getElementById(id);
function fmt(n){return (n==null?'—':Number(n).toLocaleString())}
async function tick(){
 try{
  const r=await fetch('/data?key='+KEY,{cache:'no-store'});const d=await r.json();
  $('dot').className='dot'+(d.connected?' on':'');
  $('state').textContent=d.connected?(d.paused?'⏸️ paused':'▶️ farming'):'🔴 offline';
  $('uptime').textContent='⏱ '+d.uptime;
  $('upd').textContent='upd '+new Date().toLocaleTimeString();
  $('bal').textContent=fmt(d.balance);
  $('daily').textContent=fmt(d.dailyEarned)+' / '+fmt(d.dailyCap);
  $('bank').textContent=fmt(d.bankBalance);
  $('addr').textContent=d.wallet||'—';
  $('total').textContent=fmt(d.totalEarned);
  $('rate').textContent=fmt(d.rate)+'/h';
  $('qs').textContent='+'+fmt(d.earnedQuick);
  $('mkt').textContent='+'+fmt(d.earnedMarket);
  $('pvp').textContent='+'+fmt(d.pvpEarnings);
  $('sold').textContent=fmt(d.itemsSold);
  $('lvl').textContent=d.level;$('xp').textContent=fmt(d.xp);
  $('hp').textContent=d.hp+' / '+d.maxHp;$('sta').textContent=d.stamina;
  $('zone').textContent=d.zone;$('inv').textContent=d.invCount+' / '+d.carryCap;
  $('pos').textContent='('+d.posX+', '+d.posZ+')';
  const acts={mining:'⛏ Mining',fishing:'🎣 Fishing',combat:'⚔ Combat',pvp:'🥊 PvP',idle:'💤 Idle',walking:'🚶 Walking'};
  const al=acts[d.activity]||('🎮 '+d.activity);
  $('now').textContent=al;$('doing').textContent=al;
  $('node').textContent=d.node;$('mon').textContent=d.monster;
  $('mined').textContent=fmt(d.mined);$('fished').textContent=fmt(d.fished);$('kills').textContent=fmt(d.kills);
  $('flips').textContent=fmt(d.flips);$('crafts').textContent=fmt(d.crafted);$('boss').textContent=fmt(d.bossClaims);
  $('err').textContent=fmt(d.errors);
  $('market').textContent=d.market||'(no data yet)';
  lastData=d;
  drawChart(d.hourly||[]);
  $('log').textContent=(d.log||[]).join('\\n');$('log').scrollTop=$('log').scrollHeight;
 }catch(e){$('state').textContent='⚠️ '+e.message}
}
function drawMap(d){
 const c=$('map');if(!c||!d.map)return;
 const dpr=window.devicePixelRatio||1, W=c.clientWidth||c.parentElement.clientWidth-28, H=320;
 c.width=W*dpr;c.height=H*dpr;c.style.width=W+'px';c.style.height=H+'px';
 const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,W,H);
 const Z=d.map.zones,N=d.map.nodes,M=d.map.monsters;
 const pts=[...Z,...N,...M,{x:d.posX,z:d.posZ}];
 let minX=Math.min(...pts.map(p=>p.x)),maxX=Math.max(...pts.map(p=>p.x));
 let minZ=Math.min(...pts.map(p=>p.z)),maxZ=Math.max(...pts.map(p=>p.z));
 const pad=18, mx=(maxX-minX)||1, mz=(maxZ-minZ)||1;
 const sc=Math.min((W-pad*2)/mx,(H-pad*2)/mz);
 const ox=(W-mx*sc)/2, oz=(H-mz*sc)/2;
 const T=(px,pz)=>[ox+(px-minX)*sc, oz+(pz-minZ)*sc];
 // backdrop grid
 x.fillStyle='#0a0e16';x.fillRect(0,0,W,H);
 x.strokeStyle='#19223a';x.lineWidth=1;
 for(let gx=0;gx<=8;gx++){const px=pad+(W-2*pad)*gx/8;x.beginPath();x.moveTo(px,0);x.lineTo(px,H);x.stroke();}
 for(let gz=0;gz<=6;gz++){const pz=pad+(H-2*pad)*gz/6;x.beginPath();x.moveTo(0,pz);x.lineTo(W,pz);x.stroke();}
 // zones (blue labelled)
 x.font='10px system-ui';x.textBaseline='middle';
 Z.forEach(z=>{const[px,pz]=T(z.x,z.z);x.fillStyle='#2a3c63';x.beginPath();x.arc(px,pz,4,0,7);x.fill();
   x.fillStyle='#7da0d8';x.textAlign='left';x.fillText(z.name,px+7,pz);});
 // mining nodes (orange squares; current = bright)
 N.forEach((n,i)=>{const[px,pz]=T(n.x,n.z);x.fillStyle=(d.nodeIdx===i)?'#ffcf5c':'#7a5a1e';x.fillRect(px-3,pz-3,6,6);});
 // monsters (red dots; current = bright)
 M.forEach((m,i)=>{const[px,pz]=T(m.x,m.z);x.fillStyle=(d.monIdx===i)?'#ff5c5c':'#7a2727';x.beginPath();x.arc(px,pz,3.5,0,7);x.fill();});
 // player (glowing green)
 const[ppx,ppz]=T(d.posX,d.posZ);
 const t=(Date.now()%1500)/1500, r=6+t*8;
 x.beginPath();x.arc(ppx,ppz,r,0,7);x.fillStyle='rgba(61,220,132,'+(0.35*(1-t))+')';x.fill();
 x.beginPath();x.arc(ppx,ppz,6,0,7);x.fillStyle='#3ddc84';x.fill();
 x.strokeStyle='#0a0e16';x.lineWidth=2;x.stroke();
 // legend
 x.font='10px system-ui';x.textAlign='left';
 x.fillStyle='#3ddc84';x.fillText('● you',10,H-26);
 x.fillStyle='#ffcf5c';x.fillText('■ node',60,H-26);
 x.fillStyle='#ff5c5c';x.fillText('● monster',115,H-26);
 x.fillStyle='#7da0d8';x.fillText('● zone',185,H-26);
}
function drawChart(data){
 const c=$('chart');if(!c)return;
 const dpr=window.devicePixelRatio||1, W=c.clientWidth||c.parentElement.clientWidth-28, H=200;
 c.width=W*dpr;c.height=H*dpr;c.style.width=W+'px';c.style.height=H+'px';
 const x=c.getContext('2d');x.scale(dpr,dpr);x.clearRect(0,0,W,H);
 const padL=46,padB=22,padT=10,padR=8;
 const cw=W-padL-padR, ch=H-padT-padB;
 const max=Math.max(1,...data.map(d=>d.v));
 // gridlines + y labels
 x.font='10px system-ui';x.textBaseline='middle';
 for(let i=0;i<=4;i++){const gy=padT+ch*i/4;const val=Math.round(max*(1-i/4));
   x.strokeStyle='#243049';x.beginPath();x.moveTo(padL,gy);x.lineTo(W-padR,gy);x.stroke();
   x.fillStyle='#8aa0c0';x.textAlign='right';x.fillText(val.toLocaleString(),padL-6,gy);}
 const n=data.length, bw=cw/n*0.62, gap=cw/n;
 data.forEach((d,i)=>{
   const bh=Math.max(d.v>0?2:0, ch*d.v/max), bx=padL+gap*i+(gap-bw)/2, by=padT+ch-bh;
   const g=x.createLinearGradient(0,by,0,padT+ch);g.addColorStop(0,'#5cffa0');g.addColorStop(1,'#1f9e5a');
   x.fillStyle=d.v>0?g:'#243049';
   if(x.roundRect){x.beginPath();x.roundRect(bx,by,bw,bh,4);x.fill();}else{x.fillRect(bx,by,bw,bh);}
   x.fillStyle='#8aa0c0';x.textAlign='center';x.fillText(d.h,bx+bw/2,H-padB+12);
   if(d.v>0){x.fillStyle='#e6edf6';x.font='9px system-ui';x.fillText(d.v>=1000?(d.v/1000).toFixed(1)+'k':d.v,bx+bw/2,by-7);x.font='10px system-ui';}
 });
}
tick();setInterval(tick,5000);
(function anim(){ if(lastData)drawMap(lastData); requestAnimationFrame(anim); })();
</script></body></html>`;

module.exports = { startDashboard };
