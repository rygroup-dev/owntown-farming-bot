// ============ WEB DASHBOARD (zero-dependency, multi-page) ============
// Serves a login-protected, multi-tab, auto-refreshing dashboard + JSON data.
const http = require('http');
const crypto = require('crypto');

function startDashboard({ port, key, user, pass, getSnapshot, logger }) {
  const log = logger || (() => {});
  const authToken = crypto.createHmac('sha256', key).update(`${user}:${pass}`).digest('hex');
  const COOKIE = 'ot_auth';

  function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > -1) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); });
    return out;
  }
  function authed(req, url) {
    if (parseCookies(req)[COOKIE] === authToken) return true;
    if (key && url.searchParams.get('key') === key) return true;
    return false;
  }
  function readBody(req) {
    return new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 4096) req.destroy(); }); req.on('end', () => resolve(b)); });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE.replace('__ERR__', '')); return;
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      if (params.get('user') === user && params.get('pass') === pass) {
        res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${authToken}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`, 'Location': '/' });
        res.end(); log('🖥️ Dashboard login OK'); return;
      }
      log('🖥️ Dashboard login FAILED');
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE.replace('__ERR__', 'Username atau password salah')); return;
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0`, 'Location': '/login' }); res.end(); return;
    }
    if (url.pathname === '/data') {
      if (!authed(req, url)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"forbidden"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSnapshot())); return;
    }
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      if (!authed(req, url)) { res.writeHead(302, { 'Location': '/login' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE); return;
    }
    res.writeHead(404); res.end('not found');
  });

  server.on('error', (e) => log('🖥️ Dashboard error: ' + e.message));
  server.listen(port, '0.0.0.0', () => log(`🖥️ Dashboard on :${port} (login required)`));
  return server;
}

const LOGIN_PAGE = `<!doctype html><html lang="id"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owntown Bot — Login</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,#16233f,#0b0f17);color:#e6edf6;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
.box{background:#141b2b;border:1px solid #243049;border-radius:18px;padding:30px;width:330px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{margin:0 0 4px;font-size:20px}.sub{color:#8aa0c0;font-size:13px;margin-bottom:20px}
label{display:block;font-size:12px;color:#8aa0c0;margin:12px 0 5px}
input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid #243049;background:#0a0e16;color:#e6edf6;font-size:14px}
input:focus{outline:none;border-color:#3ddc84}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:10px;background:linear-gradient(180deg,#3ddc84,#1f9e5a);color:#06210f;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#ff5c5c;font-size:13px;margin-top:12px;min-height:18px;text-align:center}
.logo{font-size:34px;text-align:center;margin-bottom:6px}
</style></head><body>
<form class="box" method="POST" action="/login">
 <div class="logo">🏭</div>
 <h1>Owntown Bot</h1><div class="sub">Monitoring dashboard — login dulu ya</div>
 <label>Username</label><input name="user" autocomplete="username" autofocus>
 <label>Password</label><input name="pass" type="password" autocomplete="current-password">
 <button type="submit">Masuk</button>
 <div class="err">__ERR__</div>
</form></body></html>`;

const PAGE = `<!doctype html><html lang="id"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owntown Bot Dashboard</title>
<style>
:root{--bg:#0b0f17;--card:#141b2b;--line:#243049;--txt:#e6edf6;--mut:#8aa0c0;--grn:#3ddc84;--red:#ff5c5c;--yel:#ffcf5c;--acc:#5cc8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5;flex-wrap:wrap}
header h1{font-size:16px;margin:0}.dot{width:10px;height:10px;border-radius:50%;background:var(--red)}.dot.on{background:var(--grn)}
.pill{font-size:12px;color:var(--mut);border:1px solid var(--line);padding:2px 8px;border-radius:99px;white-space:nowrap}
nav{display:flex;gap:6px;overflow-x:auto;padding:10px 16px;border-bottom:1px solid var(--line);position:sticky;top:51px;background:var(--bg);z-index:4}
nav button{background:var(--card);border:1px solid var(--line);color:var(--mut);padding:8px 14px;border-radius:99px;cursor:pointer;font-size:13px;white-space:nowrap}
nav button.active{background:var(--grn);color:#06210f;border-color:var(--grn);font-weight:700}
.wrap{padding:16px;max-width:1100px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.card h2{margin:0 0 10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
.row{display:flex;justify-content:space-between;gap:10px;padding:3px 0}
.big{font-size:26px;font-weight:700}.grn{color:var(--grn)}.red{color:var(--red)}.yel{color:var(--yel)}.acc{color:var(--acc)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--mut)}
pre{background:#0a0e16;border:1px solid var(--line);border-radius:10px;padding:10px;max-height:380px;overflow:auto;font-size:11.5px;color:#bcd;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--mut);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card)}
td{padding:6px 8px;border-bottom:1px solid #1a2336}
.tw{max-height:460px;overflow:auto}
.foot{color:var(--mut);font-size:12px;text-align:center;padding:14px}
canvas{width:100%}
section{display:none}section.active{display:block}
.tag{font-size:11px;padding:1px 7px;border-radius:99px}.tag.mkt{background:#1e3a5f;color:#8fd}.tag.qs{background:#3a2f1e;color:#fd8}
</style></head><body>
<header>
 <span class="dot" id="dot"></span><h1>🏭 Owntown Bot</h1>
 <span class="pill" id="state">…</span><span class="pill grn" id="now" style="border-color:#1f9e5a">…</span>
 <span class="pill" id="uptime"></span><span class="pill" id="upd"></span>
 <a href="/logout" class="pill" style="margin-left:auto;text-decoration:none;color:#ff8a8a;border-color:#5a2a2a">logout</a>
</header>
<nav id="nav">
 <button class="active" data-t="overview">📊 Overview</button>
 <button data-t="activity">🎮 Activity</button>
 <button data-t="trading">🛒 Trading</button>
 <button data-t="inventory">🎒 Inventory</button>
 <button data-t="logs">📜 Logs</button>
 <button data-t="settings">⚙️ Settings</button>
</nav>
<div class="wrap">

 <section id="overview" class="active"><div class="grid">
  <div class="card"><h2>💰 Wallet & Balance</h2>
    <div class="row"><span>In-game</span><b class="big grn" id="bal">—</b></div>
    <div class="row"><span>Daily</span><b id="daily">—</b></div>
    <div class="row"><span>Bank</span><b id="bank">—</b></div>
    <div class="row"><span>Address</span></div><div class="mono" id="addr">—</div></div>
  <div class="card"><h2>📈 Profit</h2>
    <div class="row"><span>Total</span><b class="big grn" id="total">—</b></div>
    <div class="row"><span>Rate/h</span><b class="acc" id="rate">—</b></div>
    <div class="row"><span>QuickSell</span><b id="qs">—</b></div>
    <div class="row"><span>Marketplace</span><b id="mkt">—</b></div>
    <div class="row"><span>PvP</span><b id="pvp">—</b></div>
    <div class="row"><span>Items sold</span><b id="sold">—</b></div></div>
  <div class="card"><h2>🧍 Character</h2>
    <div class="row"><span>Level</span><b id="lvl">—</b></div>
    <div class="row"><span>XP</span><b id="xp">—</b></div>
    <div class="row"><span>HP</span><b id="hp">—</b></div>
    <div class="row"><span>Stamina</span><b id="sta">—</b></div>
    <div class="row"><span>Inventory</span><b id="inv">—</b></div></div>
  <div class="card"><h2>🩺 System</h2>
    <div class="row"><span>Schedule</span><b id="sched">—</b></div>
    <div class="row"><span>Errors</span><b id="err">—</b></div>
    <div class="row"><span>Memory</span><b id="mem">—</b></div>
    <div class="row"><span>Zone</span><b id="zone2">—</b></div></div>
  <div class="card" style="grid-column:1/-1"><h2>📈 Profit / hour — last 12h</h2><canvas id="chart" height="200"></canvas></div>
 </div></section>

 <section id="activity"><div class="grid">
  <div class="card"><h2>🎯 Live</h2>
    <div class="row"><span>Doing</span><b class="grn" id="doing">—</b></div>
    <div class="row"><span>Zone</span><b id="zone">—</b></div>
    <div class="row"><span>Position</span><b id="pos">—</b></div>
    <div class="row"><span>Mining node</span><b id="node">—</b></div>
    <div class="row"><span>Monster</span><b id="mon">—</b></div></div>
  <div class="card" style="grid-column:1/-1"><h2>🗺️ Live map</h2><canvas id="map" height="340"></canvas></div>
 </div></section>

 <section id="trading"><div class="grid">
  <div class="card"><h2>💵 Income breakdown</h2>
    <div class="row"><span>QuickSell</span><b id="t_qs">—</b></div>
    <div class="row"><span>Marketplace</span><b id="t_mkt">—</b></div>
    <div class="row"><span>PvP</span><b id="t_pvp">—</b></div>
    <div class="row"><span>Property</span><b id="t_prop">—</b></div>
    <div class="row"><span>Listed / Canceled</span><b id="t_lc">—</b></div></div>
  <div class="card"><h2>📊 Market prices</h2><div id="market" class="mono">—</div></div>
  <div class="card" style="grid-column:1/-1"><h2>🏷️ Sedang dijual (listing aktif)</h2><div class="tw">
    <table><thead><tr><th>Item</th><th>Qty</th><th>Harga</th></tr></thead>
    <tbody id="listings"><tr><td colspan="3" style="color:var(--mut)">tidak ada listing aktif</td></tr></tbody></table></div></div>
  <div class="card" style="grid-column:1/-1"><h2>🧾 Transaksi terakhir (terjual)</h2><div class="tw">
    <table><thead><tr><th>Waktu</th><th>Item</th><th>Qty</th><th>Harga</th><th>Total</th><th></th></tr></thead>
    <tbody id="trades"><tr><td colspan="6" style="color:var(--mut)">belum ada penjualan</td></tr></tbody></table></div></div>
 </div></section>

 <section id="inventory"><div class="grid">
  <div class="card"><h2>🎒 Ringkasan</h2>
    <div class="row"><span>Stacks</span><b id="i_count">—</b></div>
    <div class="row"><span>Estimasi nilai</span><b class="grn" id="i_val">—</b></div></div>
  <div class="card" style="grid-column:1/-1"><h2>📦 Isi tas</h2><div class="tw">
    <table><thead><tr><th>Item</th><th>Qty</th><th>~Nilai</th></tr></thead>
    <tbody id="invtable"><tr><td colspan="3" style="color:var(--mut)">kosong</td></tr></tbody></table></div></div>
 </div></section>

 <section id="logs"><div class="grid">
  <div class="card" style="grid-column:1/-1"><h2>⚠️ Errors</h2><pre id="errlog">—</pre></div>
  <div class="card" style="grid-column:1/-1"><h2>📜 Activity log</h2><pre id="log">—</pre></div>
 </div></section>

 <section id="settings"><div class="grid">
  <div class="card"><h2>⚙️ Konfigurasi</h2>
    <div class="row"><span>Anti-detect schedule</span><b id="s_sched">—</b></div>
    <div class="row"><span>Jitter</span><b id="s_jit">—</b></div>
    <div class="row"><span>Report interval</span><b id="s_rep">—</b></div>
    <div class="row"><span>Watchdog</span><b id="s_wd">—</b></div>
    <div class="row"><span>Notif profit-only</span><b id="s_po">—</b></div>
    <div class="row"><span>Daily cap</span><b id="s_cap">—</b></div>
    <div class="row"><span>Auto-flip</span><b id="s_flip">—</b></div>
    <div class="row"><span>Balance reserve</span><b id="s_res">—</b></div>
    <div class="row"><span>Auto-powerup</span><b id="s_pwr">—</b></div></div>
  <div class="card"><h2>🤖 Kontrol via Telegram</h2>
    <div class="mono" style="line-height:1.9">/start · /stop · /status · /balance<br>/inventory · /income · /health<br>/errors · /logs · /schedule · /ping<br>/pause · /resume · /restart · /update</div>
    <p style="color:var(--mut);font-size:12px;margin:10px 0 0">Edit setting via <code>.env</code> di VPS lalu /restart.</p></div>
 </div></section>

</div><div class="foot">auto-refresh 5s · Owntown Farming Bot</div>
<script>
let lastData=null;
const $=id=>document.getElementById(id);
function fmt(n){return (n==null?'—':Number(n).toLocaleString())}
function esc(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}

document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>{
 document.querySelectorAll('#nav button').forEach(x=>x.classList.remove('active'));
 document.querySelectorAll('section').forEach(x=>x.classList.remove('active'));
 b.classList.add('active');$(b.dataset.t).classList.add('active');
});

async function tick(){
 try{
  const r=await fetch('/data',{cache:'no-store'});
  if(r.status===403){location.href='/login';return}
  const d=await r.json();lastData=d;
  $('dot').className='dot'+(d.connected?' on':'');
  $('state').textContent=d.connected?(d.paused?'⏸️ paused':'▶️ farming'):'🔴 offline';
  $('uptime').textContent='⏱ '+d.uptime;$('upd').textContent='upd '+new Date().toLocaleTimeString();
  const acts={mining:'⛏ Mining',fishing:'🎣 Fishing',combat:'⚔ Combat',pvp:'🥊 PvP',idle:'💤 Idle',offline:'🔴 Offline'};
  const al=acts[d.activity]||('🎮 '+d.activity);
  $('now').textContent=al;$('doing').textContent=al;
  // overview
  $('bal').textContent=fmt(d.balance);$('daily').textContent=fmt(d.dailyEarned)+' / '+fmt(d.dailyCap);
  $('bank').textContent=fmt(d.bankBalance);$('addr').textContent=d.wallet||'—';
  $('total').textContent=fmt(d.totalEarned);$('rate').textContent=fmt(d.rate)+'/h';
  $('qs').textContent='+'+fmt(d.earnedQuick);$('mkt').textContent='+'+fmt(d.earnedMarket);
  $('pvp').textContent='+'+fmt(d.pvpEarnings);$('sold').textContent=fmt(d.itemsSold);
  $('lvl').textContent=d.level;$('xp').textContent=fmt(d.xp);$('hp').textContent=d.hp+' / '+d.maxHp;
  $('sta').textContent=d.stamina;$('inv').textContent=d.invCount+' / '+d.carryCap;
  $('sched').textContent=d.schedule;$('err').textContent=d.errors+' (streak '+d.errorsStreak+')';
  $('mem').textContent=d.memMB+' MB';$('zone2').textContent=d.zone;
  // activity
  $('zone').textContent=d.zone;$('pos').textContent='('+d.posX+', '+d.posZ+')';
  $('node').textContent=d.node;$('mon').textContent=d.monster;
  // trading
  $('t_qs').textContent='+'+fmt(d.earnedQuick);$('t_mkt').textContent='+'+fmt(d.earnedMarket);
  $('t_pvp').textContent='+'+fmt(d.pvpEarnings);$('t_prop').textContent='+'+fmt(d.propertyEarnings);
  $('t_lc').textContent=fmt(d.listed)+' / '+fmt(d.canceled);
  $('market').textContent=d.market||'(no data yet)';
  $('listings').innerHTML=(d.listings&&d.listings.length)?d.listings.map(l=>'<tr><td>'+esc(l.name)+'</td><td>'+l.qty+'</td><td class="yel">'+fmt(l.price)+'</td></tr>').join(''):'<tr><td colspan="3" style="color:var(--mut)">tidak ada listing aktif</td></tr>';
  $('trades').innerHTML=(d.trades&&d.trades.length)?d.trades.map(t=>'<tr><td>'+new Date(t.t).toLocaleTimeString()+'</td><td>'+esc(t.name)+'</td><td>'+t.qty+'</td><td>'+fmt(t.price)+'</td><td class="grn">+'+fmt(t.total)+'</td><td><span class="tag '+(t.method==='quickSell'?'qs':'mkt')+'">'+(t.method==='quickSell'?'QS':'MKT')+'</span></td></tr>').join(''):'<tr><td colspan="6" style="color:var(--mut)">belum ada penjualan</td></tr>';
  // inventory
  $('i_count').textContent=d.invCount+' / '+d.carryCap;
  const ival=(d.inventory||[]).reduce((s,i)=>s+i.value,0);$('i_val').textContent=fmt(ival)+' OTWN';
  $('invtable').innerHTML=(d.inventory&&d.inventory.length)?d.inventory.slice().sort((a,b)=>b.value-a.value).map(i=>'<tr><td>'+esc(i.name)+'</td><td>'+i.qty+'</td><td>'+fmt(i.value)+'</td></tr>').join(''):'<tr><td colspan="3" style="color:var(--mut)">kosong</td></tr>';
  // logs
  $('log').textContent=(d.log||[]).join('\\n');$('log').scrollTop=$('log').scrollHeight;
  const errs=(d.log||[]).filter(l=>/ERR|❌|💥|⚠️|fail/i.test(l));
  $('errlog').textContent=errs.length?errs.join('\\n'):'none 🎉';
  // settings
  const s=d.settings||{};
  $('s_sched').textContent=s.schedule;$('s_jit').textContent='±'+s.jitter+'%';
  $('s_rep').textContent=s.reportMin+' min';$('s_wd').textContent=s.watchdogMin+' min';
  $('s_po').textContent=s.profitOnly?'ON':'OFF';$('s_cap').textContent=fmt(s.dailyCap);
  $('s_flip').textContent=s.flip;$('s_res').textContent=fmt(s.reserve);$('s_pwr').textContent=s.powerup;
  drawChart(d.hourly||[]);
 }catch(e){$('state').textContent='⚠️ '+e.message}
}
function drawMap(d){
 const c=$('map');if(!c||!d.map||!c.clientWidth)return;
 const dpr=window.devicePixelRatio||1,W=c.clientWidth,H=340;
 c.width=W*dpr;c.height=H*dpr;c.style.height=H+'px';
 const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,W,H);
 const Z=d.map.zones,N=d.map.nodes,M=d.map.monsters;
 const pts=Z.concat(N,M,[{x:d.posX,z:d.posZ}]);
 let minX=Math.min.apply(0,pts.map(p=>p.x)),maxX=Math.max.apply(0,pts.map(p=>p.x));
 let minZ=Math.min.apply(0,pts.map(p=>p.z)),maxZ=Math.max.apply(0,pts.map(p=>p.z));
 const pad=18,mx=(maxX-minX)||1,mz=(maxZ-minZ)||1,sc=Math.min((W-pad*2)/mx,(H-pad*2)/mz);
 const ox=(W-mx*sc)/2,oz=(H-mz*sc)/2,T=(px,pz)=>[ox+(px-minX)*sc,oz+(pz-minZ)*sc];
 x.fillStyle='#0a0e16';x.fillRect(0,0,W,H);x.strokeStyle='#19223a';
 for(let g=0;g<=8;g++){const p=pad+(W-2*pad)*g/8;x.beginPath();x.moveTo(p,0);x.lineTo(p,H);x.stroke();}
 for(let g=0;g<=6;g++){const p=pad+(H-2*pad)*g/6;x.beginPath();x.moveTo(0,p);x.lineTo(W,p);x.stroke();}
 x.font='10px system-ui';x.textBaseline='middle';
 Z.forEach(z=>{const a=T(z.x,z.z);x.fillStyle='#2a3c63';x.beginPath();x.arc(a[0],a[1],4,0,7);x.fill();x.fillStyle='#7da0d8';x.textAlign='left';x.fillText(z.name,a[0]+7,a[1]);});
 N.forEach((n,i)=>{const a=T(n.x,n.z);x.fillStyle=(d.nodeIdx===i)?'#ffcf5c':'#7a5a1e';x.fillRect(a[0]-3,a[1]-3,6,6);});
 M.forEach((m,i)=>{const a=T(m.x,m.z);x.fillStyle=(d.monIdx===i)?'#ff5c5c':'#7a2727';x.beginPath();x.arc(a[0],a[1],3.5,0,7);x.fill();});
 const pp=T(d.posX,d.posZ),t=(Date.now()%1500)/1500;
 x.beginPath();x.arc(pp[0],pp[1],6+t*8,0,7);x.fillStyle='rgba(61,220,132,'+(0.35*(1-t))+')';x.fill();
 x.beginPath();x.arc(pp[0],pp[1],6,0,7);x.fillStyle='#3ddc84';x.fill();x.strokeStyle='#0a0e16';x.lineWidth=2;x.stroke();
}
function drawChart(data){
 const c=$('chart');if(!c||!c.clientWidth)return;
 const dpr=window.devicePixelRatio||1,W=c.clientWidth,H=200;
 c.width=W*dpr;c.height=H*dpr;c.style.height=H+'px';
 const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,W,H);
 const padL=46,padB=22,padT=10,padR=8,cw=W-padL-padR,ch=H-padT-padB;
 const max=Math.max.apply(0,[1].concat(data.map(d=>d.v)));
 x.font='10px system-ui';x.textBaseline='middle';
 for(let i=0;i<=4;i++){const gy=padT+ch*i/4,val=Math.round(max*(1-i/4));
   x.strokeStyle='#243049';x.beginPath();x.moveTo(padL,gy);x.lineTo(W-padR,gy);x.stroke();
   x.fillStyle='#8aa0c0';x.textAlign='right';x.fillText(val.toLocaleString(),padL-6,gy);}
 const n=data.length||1,gap=cw/n,bw=gap*0.62;
 data.forEach((d,i)=>{const bh=Math.max(d.v>0?2:0,ch*d.v/max),bx=padL+gap*i+(gap-bw)/2,by=padT+ch-bh;
   const g=x.createLinearGradient(0,by,0,padT+ch);g.addColorStop(0,'#5cffa0');g.addColorStop(1,'#1f9e5a');
   x.fillStyle=d.v>0?g:'#243049';if(x.roundRect){x.beginPath();x.roundRect(bx,by,bw,bh,4);x.fill();}else x.fillRect(bx,by,bw,bh);
   x.fillStyle='#8aa0c0';x.textAlign='center';x.fillText(d.h,bx+bw/2,H-padB+12);
   if(d.v>0){x.fillStyle='#e6edf6';x.font='9px system-ui';x.fillText(d.v>=1000?(d.v/1000).toFixed(1)+'k':d.v,bx+bw/2,by-7);x.font='10px system-ui';}});
}
tick();setInterval(tick,5000);
(function anim(){ if(lastData)drawMap(lastData); requestAnimationFrame(anim); })();
</script></body></html>`;

module.exports = { startDashboard };
