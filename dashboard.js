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
<header><span class="dot" id="dot"></span><h1>🏭 Owntown Bot</h1><span class="pill" id="state">…</span><span class="pill" id="uptime"></span><span class="pill" id="upd"></span></header>
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
   <div class="row"><span>Inventory</span><b id="inv">—</b></div>
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
 <div class="card" style="grid-column:1/-1"><h2>📊 Market prices</h2><div id="market" class="mono">—</div></div>
 <div class="card" style="grid-column:1/-1"><h2>📜 Recent log</h2><pre id="log">—</pre></div>
</div><div class="foot">auto-refresh 5s · Owntown Farming Bot</div></div>
<script>
const KEY="__KEY__";
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
  $('mined').textContent=fmt(d.mined);$('fished').textContent=fmt(d.fished);$('kills').textContent=fmt(d.kills);
  $('flips').textContent=fmt(d.flips);$('crafts').textContent=fmt(d.crafted);$('boss').textContent=fmt(d.bossClaims);
  $('err').textContent=fmt(d.errors);
  $('market').textContent=d.market||'(no data yet)';
  $('log').textContent=(d.log||[]).join('\\n');$('log').scrollTop=$('log').scrollHeight;
 }catch(e){$('state').textContent='⚠️ '+e.message}
}
tick();setInterval(tick,5000);
</script></body></html>`;

module.exports = { startDashboard };
