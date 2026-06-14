const io = require('socket.io-client');
const fs = require('fs');
const https = require('https');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { config, persistEnv } = require('./config');
const { Telegram } = require('./telegram');
const { startDashboard } = require('./dashboard');
const crypto = require('crypto');
const { ErrorBus } = require('./errorbus');
const selfheal = require('./selfheal');
const path = require('path');
const errorBus = new ErrorBus(path.join(__dirname, 'errors.json'));
const autopatch = require('./autopatch');
const patchLimiter = new autopatch.RateLimiter(10 * 60000, 60 * 60000, 1, 3); // max 1/10min, 3/hour
const BACKUP_DIR = path.join(__dirname, '.autopatch-backups');
const PENDING_PATCH = path.join(__dirname, '.autopatch-pending.json');
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}

// ============ CONFIG (env-driven, see .env) ============
const TOKEN_PATH = config.tokenPath;
const GAME_HOST = config.gameHost;
let WALLET_ADDR = config.walletAddress;
const WALLET_FILE = config.walletFile;
const LOG = config.logPath;
let MY_PLAYER_ID = config.playerId; // auto-detected at runtime if blank
try { fs.writeFileSync(LOG, ''); } catch (e) { /* log dir may be missing; fall back to stdout */ }

// circular ring buffer of recent log lines (for /log command)
const LOG_RING = [];
const LOG_RING_MAX = 200;

function log(m) {
  const l = new Date().toISOString().slice(11,19) + ' | ' + m;
  try { fs.appendFileSync(LOG, l + '\n'); } catch (e) { /* ignore fs errors */ }
  process.stdout.write(l + '\n');
  LOG_RING.push(l);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
}

// ============ TELEGRAM ============
const tg = new Telegram({
  token: config.telegramToken,
  chatId: config.telegramChatId,
  logger: log,
  onChatIdLearned: (id) => persistEnv('TELEGRAM_CHAT_ID', id),
});
function notify(m) { tg.send(m); }                                   // always (profit reports, command replies, critical)
function notifySys(m) { if (!config.notifyProfitOnly) tg.send(m); }  // routine/system events — muted when profit-only

// ── Central error capture (L1) + runtime self-heal (L2) + autopatch trigger (L3) ──
// category 'reconnect' = connection noise (ping/transport/auth timeout), counted
// separately from farming errors so /status is honest.
function reportError({ code, context, expected, zone, category }) {
  if (category === 'reconnect') { stats.reconnects++; }
  else { stats.errors++; stats.consecutiveErrors++; }
  const entry = errorBus.record({ code, context, expected, zone });
  const alreadyPatched = entry.status === 'patched'; // never downgrade or re-patch a patched sig

  const action = selfheal.decide({ code: entry.code, zone, count: entry.count });
  if (action) {
    applySelfHeal(action);
    if (!alreadyPatched) errorBus.setStatus(entry.sig, 'self-healed', action.type);
  }

  const recipe = autopatch.selectRecipe({ code: entry.code, zone, count: entry.count });
  if (recipe && !alreadyPatched && patchLimiter.tryAcquire(Date.now())) {
    runAutoPatch(recipe, entry);
  }
  return entry;
}

function applySelfHeal(action) {
  if (action.type === 'blacklist-zone' && !ZONE_BLACKLIST.includes(action.zone)) {
    ZONE_BLACKLIST.push(action.zone);
    log(`🩹 self-heal: avoid zone ${action.zone}`);
  } else if (action.type === 'tune-reconnect-runtime') {
    RECONNECT_BACKOFF_MS = Math.min(120000, Math.round(RECONNECT_BACKOFF_MS * 1.5));
    log(`🩹 self-heal: reconnect backoff → ${RECONNECT_BACKOFF_MS}ms`);
  }
}

// ── AutoPatch runtime (Layer 3): apply recipe to bot.js source, restart, verify ──
function runAutoPatch(recipe, entry) {
  const res = autopatch.applyRecipe(recipe, { sourcePath: path.join(__dirname, 'bot.js'), backupDir: BACKUP_DIR, entry });
  if (!res.ok) {
    log(`🔧 autopatch ${recipe.name} FAILED parse-check — not applied (${res.error})`);
    notify(`🔧 <b>AutoPatch aborted</b>\nRecipe: ${recipe.name}\nError: ${res.error}`);
    return;
  }
  // Record a pending patch so the next boot verifies connect within 60s, else rolls back.
  try { fs.writeFileSync(PENDING_PATCH, JSON.stringify({ recipe: recipe.name, sig: entry.sig, backup: res.backup, at: Date.now() })); } catch {}
  errorBus.setStatus(entry.sig, 'patched', recipe.name);
  log(`🔧 autopatch ${recipe.name} applied → restarting to verify`);
  notify(`🔧 <b>AutoPatch applied</b>\nRecipe: ${recipe.name}\nError: ${entry.code} (×${entry.count})\nRestarting to verify…`);
  setTimeout(() => process.exit(0), 1500); // systemd Restart=always brings it back patched
}

// Boot-time verification of any pending patch: connected within 60s → keep; else rollback + restart.
function verifyPendingPatchOnBoot() {
  let pend;
  try { pend = JSON.parse(fs.readFileSync(PENDING_PATCH, 'utf8')); } catch { return; }
  const deadline = Date.now() + 60000;
  const iv = setInterval(() => {
    if (connected) {
      clearInterval(iv);
      try { fs.unlinkSync(PENDING_PATCH); } catch {}
      log(`✅ autopatch ${pend.recipe} verified (connected)`);
      notify(`✅ <b>AutoPatch verified</b>: ${pend.recipe} — connection OK`);
    } else if (Date.now() > deadline) {
      clearInterval(iv);
      try {
        fs.copyFileSync(pend.backup, path.join(__dirname, 'bot.js'));
        fs.unlinkSync(PENDING_PATCH);
        log(`↩️ autopatch ${pend.recipe} ROLLED BACK (no connect in 60s)`);
        notify(`↩️ <b>AutoPatch rolled back</b>: ${pend.recipe} — no connect in 60s. Restarting clean.`);
        setTimeout(() => process.exit(0), 1500);
      } catch (e) { log('rollback error: ' + e.message); }
    }
  }, 3000);
}

// ============ AUTOPILOT STATE ============
let paused = false;
let stopped = false;          // true = game session fully off (user plays manually); no auto-reconnect
let currentActivity = 'idle'; // live: what the bot is doing right now
let lastActivity = Date.now();        // updated on any meaningful game result
let activeSocket = null;              // current live socket (for watchdog/commands)
let lastCycleStart = Date.now();
let retryTimer = null;                // single pending (re)connect timer
function touchActivity() { lastActivity = Date.now(); }
function scheduleStart(ms) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; startBot(); }, ms);
}

log('=== OWNTOWN PROFIT FARMER v23.0 ===');
log('FULL FEATURED: PvP + Property + Shop + Crafting + Bank + Vehicle + Smart Sell');

// ============ CONSTANTS ============
const WALK_SPEED = 0.4;
const MAX_WALK_STEPS = 5000;
let DAILY_EARN_CAP = 5000;  // fallback only; real per-account cap comes from server via player:state → dailyEarnCap
const CARRY_CAP = 56;
const MARKET_INTERVAL = 3500;
const LOW_DURABILITY = 30;
const FISHING_TIMEOUT = 120000;
// === AUTOPATCH:TIMEOUTS:START ===
let REST_TIMEOUT = 20000;
let AUTH_TIMEOUT = 20000;
// === AUTOPATCH:TIMEOUTS:END ===
// === AUTOPATCH:RECONNECT:START ===
let RECONNECT_BACKOFF_MS = 30000;
// === AUTOPATCH:RECONNECT:END ===
// === AUTOPATCH:ZONE_BLACKLIST:START ===
const ZONE_BLACKLIST = [];
// === AUTOPATCH:ZONE_BLACKLIST:END ===
// === AUTOPATCH:ERROR_HANDLERS:START ===
const KNOWN_ERROR_CODES = ['COOLDOWN', 'NO_TARGET', 'WRONG_ZONE'];
// === AUTOPATCH:ERROR_HANDLERS:END ===
const UNDERCUT_PCT = 0.08;
const LOW_STAMINA = 30;
const FATIGUE_THRESHOLD = 0.80;
const LOW_HP = 50;
const HEAL_HP = 80;

// ============ PRICE FLOORS ============
const PRICE_FLOOR = {
  fish_sun_carp: 2000, fish_moon_koi: 500, fish_void_angler: 300,
  fish_abyssal_lantern: 300, fish_golden_koi: 300, fish_silver_darter: 30,
  mat_resonance_core: 5000, mat_raw_resonite: 10, mat_circuit_scrap: 10,
  mat_iron_shard: 5, mat_carbon_fiber: 5, wpn_arc_baton: 500, wpn_rail_lance: 2000,
};

const QUICKSELL = {
  mat_raw_resonite: 6, mat_circuit_scrap: 3, mat_iron_shard: 2,
  mat_carbon_fiber: 2, mat_resonance_core: 50,
  fish_silver_darter: 4, fish_sun_carp: 3, fish_moon_koi: 10,
  fish_void_angler: 15, fish_abyssal_lantern: 20, fish_golden_koi: 15,
  wpn_arc_baton: 100, wpn_rail_lance: 200,
};

// ============ ITEM CATEGORIES ============
const KEEP = new Set([
  'tool_pulse_pick','cos_coastal_tee','cos_palm_sneakers',
  'kit_repair','med_patch','food_ember_skewer','food_volt_noodles',
  'pet_demon_salamander','pet_golden_whale','pet_sea_dragon',
  'permit_redline','cos_miner_vest','cos_redline_vest'
]);

const MARKETPLACE_ONLY = new Set([
  'fish_sun_carp','fish_moon_koi','fish_void_angler',
  'fish_abyssal_lantern','fish_golden_koi','fish_silver_darter',
  'mat_resonance_core','wpn_arc_baton','wpn_rail_lance'
]);

const SAFE_QUICKSELL = new Set([
  'mat_raw_resonite','mat_circuit_scrap','mat_iron_shard','mat_carbon_fiber'
]);

const FOOD_ITEMS = new Set([
  'food_ember_skewer','food_volt_noodles','med_patch',
  'fish_silver_darter','fish_sun_carp','fish_moon_koi'
]);

// ============ GEAR RECIPES ============
const GEAR_RECIPES = {
  'craft_rail_lance': { needs: { mat_raw_resonite: 4, mat_circuit_scrap: 2, mat_resonance_core: 1 }, fee: 25 },
  'craft_repair_kit': { needs: { mat_iron_shard: 2, mat_carbon_fiber: 1 }, fee: 5 },
  'craft_tide_helm': { needs: { mat_iron_shard: 5, mat_circuit_scrap: 3 }, fee: 50 },
  'craft_reef_plate': { needs: { mat_iron_shard: 8, mat_carbon_fiber: 4 }, fee: 80 },
  'craft_dune_boots': { needs: { mat_iron_shard: 3, mat_carbon_fiber: 2 }, fee: 30 },
};

// ============ MONSTER SPAWNS ============
const MONSTERS = [
  { id: 'mon_1', defId: 'faultborn_stray', pos: {x:-100,z:-120} },
  { id: 'mon_2', defId: 'faultborn_stray', pos: {x:-115,z:-135} },
  { id: 'mon_3', defId: 'faultborn_stray', pos: {x:-90,z:-150} },
  { id: 'mon_4', defId: 'faultborn_stray', pos: {x:-130,z:-115} },
  { id: 'mon_5', defId: 'rift_brute', pos: {x:-150,z:-145} },
  { id: 'mon_6', defId: 'rift_brute', pos: {x:-125,z:-165} },
];

// ============ MINING NODES ============
const MINING_NODES = [
  { id: 'node_dw_1', pos: {x:75,z:-95} },
  { id: 'node_dw_2', pos: {x:95,z:-110} },
  { id: 'node_dw_3', pos: {x:120,z:-90} },
  { id: 'node_dw_4', pos: {x:140,z:-120} },
  { id: 'node_dw_5', pos: {x:110,z:-145} },
  { id: 'node_dw_6', pos: {x:80,z:-155} },
  { id: 'node_dw_7', pos: {x:150,z:-150} },
  { id: 'node_dw_8', pos: {x:135,z:-165} },
];

// ============ ZONE TARGETS ============
const ZONE_TARGETS = {
  deepworks: {x:75, z:-95},
  pond: {x:-148.5, z:0},
  redline_a: {x:-100, z:-120},
  residential: {x:-75, z:0},
  spawn_plaza: {x:0, z:0},
  clinic: {x:-60, z:-30},
  food_row: {x:20, z:55},
  market: {x:25, z:-15},
  garage: {x:45, z:-30},
  arena: {x:194, z:-185},
  property: {x:30, z:40},
};

const WAYPOINTS_BASE = {
  fishing:[{x:0,z:0},{x:-80,z:0},{x:-148.5,z:0}],
};

const EXPECTED_ZONE = {
  mining: 'deepworks',
  fishing: 'pond',
  combat: 'redline_a',
  pvp: 'arena',
};

const ACTIONS = {
  mining:{count:15,interval:3500},
  fishing:{count:5,interval:25000},
  combat:{count:5,interval:3000},
  pvp:{count:3,interval:5000},
};

// ============ STATE ============
let stats = {
  mined:0,fished:0,fought:0,kills:0,xp:0,items:0,
  soldQuick:0,soldMarket:0,earnedQuick:0,earnedMarket:0,
  listed:0,canceled:0,crafted:0,repaired:0,errors:0,reconnects:0,
  consecutiveErrors:0,startTime:Date.now(),cycles:0,
  wrongZone:0,fishingTimeouts:0,fatigueDrops:0,restCount:0,
  currentNodeIdx:0,currentMonsterIdx:0,foodEaten:0,
  bossFights:0,bossClaims:0,worldBossActive:false,
  pvpQueued:0,pvpFights:0,pvpWins:0,pvpClaims:0,pvpEarnings:0,
  propertyBought:0,propertySold:0,propertyEarnings:0,
  bankDeposits:0,bankWithdrawals:0,bankBalance:0,
  gearCrafted:0,vehiclesBought:0,notifications:0,
  itemsBought:0,itemsFlipped:0,flipProfit:0,
  clinicHeals:0,portalEntries:0,
  totalRevenue:0,totalItemsSold:0,avgPrices:{},priceSamples:{},
  holdCount:0,holdValue:0,
};
let balance=0,level=1,stamina=100,hp=100,dailyEarned=0,maxHp=100;
let lockedBalance=0,withdrawableBalance=0,prevBalance=null;
const BALANCE_DROP_ALERT=20;   // report any spendable-balance drop >= this to Telegram
let inventory=[],inventoryReady=false,connected=false;
let pos={x:0,z:0},zone='unknown',fishingActive=false;
let myActiveListings=[];
let marketPrices = {};
let marketHistory = [];
let fatigueMultiplier = 1.0;
let worldBossState = null;
let bankInfo = null;
let pvpState = null;
let economyLedger = [];
let notifications = [];

// ============ REST API ============
function apiRequest(method, path, body, token, timeoutMs = REST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({
      hostname: GAME_HOST, path, method, headers, timeout: timeoutMs
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function apiGet(path, token, timeoutMs) { return apiRequest('GET', path, null, token, timeoutMs); }
async function apiPost(path, body, token, timeoutMs) { return apiRequest('POST', path, body, token, timeoutMs); }

// ============ AUTH ============
function loadSecretKey() {
  // Priority: WALLET_PRIVATE_KEY env (base58) -> WALLET_FILE json {private_key}
  let b58 = config.walletPrivateKey;
  if (!b58 && WALLET_FILE) {
    try { b58 = JSON.parse(fs.readFileSync(WALLET_FILE)).private_key; } catch (e) { /* ignore */ }
  }
  if (!b58) throw new Error('No wallet configured — set WALLET_PRIVATE_KEY (base58) in .env');
  const secretKey = bs58.decode(b58);
  if (secretKey.length === 32) {
    // 32-byte seed -> expand to full 64-byte nacl keypair
    return nacl.sign.keyPair.fromSeed(secretKey).secretKey;
  }
  if (secretKey.length !== 64) throw new Error(`Bad private key length ${secretKey.length} (expect 32 or 64 bytes base58)`);
  return secretKey;
}

async function authenticate() {
  const secretKey = loadSecretKey();
  // derive address from key if not provided
  if (!WALLET_ADDR) {
    WALLET_ADDR = bs58.encode(secretKey.slice(32));
    log(`🔑 Derived wallet address: ${WALLET_ADDR}`);
  }
  const challenge = await apiPost('/api/auth/challenge', { wallet: WALLET_ADDR }, undefined, AUTH_TIMEOUT);
  // Guard against flaky/502 challenge responses — don't sign garbage
  if (challenge.status !== 200 || !challenge.data || typeof challenge.data !== 'object') {
    throw new Error(`Challenge failed (status ${challenge.status}): ${typeof challenge.data === 'string' ? challenge.data.slice(0,80) : JSON.stringify(challenge.data)}`);
  }
  const nonce = challenge.data.nonce || challenge.data.challenge;
  if (!nonce) throw new Error('Challenge returned no nonce: ' + JSON.stringify(challenge.data).slice(0,120));
  const message = challenge.data.message || ('owntown_auth:' + nonce);
  const sig = nacl.sign.detached(Buffer.from(message), secretKey);
  const result = await apiPost('/api/auth/verify', { wallet: WALLET_ADDR, nonce, signature: bs58.encode(sig) }, undefined, AUTH_TIMEOUT);
  if (!result.data.token) throw new Error('Auth failed: ' + JSON.stringify(result.data));
  try { fs.writeFileSync(TOKEN_PATH, result.data.token); } catch (e) { /* ignore */ }
  log('🔑 Authenticated! Token valid until ' + new Date(JSON.parse(Buffer.from(result.data.token.split('.')[1],'base64')).exp*1000).toISOString());
  return result.data.token;
}

function getToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf-8').trim(); } catch { return null; }
}

function isTokenExpired(tok) {
  try {
    const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64'));
    return Date.now() >= (payload.exp * 1000 - 60000);
  } catch { return true; }
}

let token = getToken();

// ============ MARKET INTELLIGENCE ============
function scanMarketPrices(listings) {
  const best = {};
  const counts = {};
  for(const l of listings) {
    if(l.status !== 'active') continue;
    const ppu = Math.round(l.price / (l.qty || 1));
    if(!best[l.defId] || ppu < best[l.defId]) best[l.defId] = ppu;
    counts[l.defId] = (counts[l.defId] || 0) + 1;
  }
  marketPrices = best;
  marketHistory.push({ time: Date.now(), prices: {...best}, counts: {...counts} });
  if(marketHistory.length > 100) marketHistory.shift();
  for(const [defId, price] of Object.entries(best)) {
    if(!stats.avgPrices[defId]) {
      stats.avgPrices[defId] = price;
      stats.priceSamples[defId] = 1;
    } else {
      stats.priceSamples[defId]++;
      stats.avgPrices[defId] = Math.round(stats.avgPrices[defId] * 0.9 + price * 0.1);
    }
  }
}

function getMarketDepth(defId) {
  const last = marketHistory[marketHistory.length - 1];
  return last ? (last.counts[defId] || 0) : 0;
}

function getPriceTrend(defId) {
  if(marketHistory.length < 3) return 'stable';
  const recent = marketHistory.slice(-3).map(h => h.prices[defId]).filter(Boolean);
  if(recent.length < 2) return 'stable';
  const avg = recent.reduce((a,b) => a+b, 0) / recent.length;
  const latest = recent[recent.length - 1];
  const change = (latest - avg) / avg;
  if(change > 0.1) return 'rising';
  if(change < -0.1) return 'falling';
  return 'stable';
}

function getSellDecision(defId, qty) {
  const floor = PRICE_FLOOR[defId] || 1;
  const qsPrice = QUICKSELL[defId] || 1;
  const mktPrice = marketPrices[defId];
  const depth = getMarketDepth(defId);
  const trend = getPriceTrend(defId);

  if(MARKETPLACE_ONLY.has(defId)) {
    if(!mktPrice || mktPrice < floor) return { action: 'HOLD', reason: `market ${mktPrice||0} < floor ${floor}`, floor };
    const undercut = Math.max(floor, Math.floor(mktPrice * (1 - UNDERCUT_PCT)));
    if(trend === 'falling' && qty > 3 && depth > 10) return { action: 'HOLD', reason: `falling, ${depth} listings`, floor };
    return { action: 'MARKETPLACE', price: undercut, marketBest: mktPrice, depth, trend };
  }

  if(SAFE_QUICKSELL.has(defId)) {
    if(mktPrice && mktPrice > qsPrice * 3) {
      return { action: 'MARKETPLACE', price: Math.max(floor, Math.floor(mktPrice * (1 - UNDERCUT_PCT))), marketBest: mktPrice, depth, trend };
    }
    return { action: 'QUICKSELL', price: qsPrice };
  }

  if(mktPrice && mktPrice > floor) {
    return { action: 'MARKETPLACE', price: Math.max(floor, Math.floor(mktPrice * (1 - UNDERCUT_PCT))), marketBest: mktPrice, depth, trend };
  }

  if(!mktPrice && floor > qsPrice * 2) return { action: 'HOLD', reason: 'no market data', floor };
  return { action: 'QUICKSELL', price: qsPrice };
}

// ---- trade history + pending-sale notifier ----
let tradeLog = [];      // {t, defId, qty, method, price, total}
let pendingSales = [];  // batched for Telegram digest
let lastCreditAt = 0;   // dedup: explicit result credits vs toast echoes

// ---- hourly profit tracking (for dashboard chart) ----
let hourlyProfit = {}; // hourKey (epoch hours) -> OTWN earned that hour
function bucketEarn(amount) {
  if(!amount || amount <= 0) return;
  const k = Math.floor(Date.now() / 3600000);
  hourlyProfit[k] = (hourlyProfit[k] || 0) + amount;
  const keys = Object.keys(hourlyProfit).map(Number).sort((a,b)=>a-b);
  while(keys.length > 48) delete hourlyProfit[keys.shift()]; // keep ~2 days
}
function getHourly(n = 12) {
  const cur = Math.floor(Date.now() / 3600000);
  const out = [];
  for(let i = n - 1; i >= 0; i--) {
    const k = cur - i;
    const d = new Date(k * 3600000);
    out.push({ h: String(d.getHours()).padStart(2,'0'), v: Math.round(hourlyProfit[k] || 0) });
  }
  return out;
}

function recordSale(defId, qty, method, price) {
  const total = price * qty;
  stats.totalRevenue += total;
  stats.totalItemsSold += qty;
  if(method === 'quickSell') { stats.soldQuick += qty; stats.earnedQuick += total; }
  else { stats.soldMarket += qty; stats.earnedMarket += total; }
  bucketEarn(total);
  const rec = { t: Date.now(), defId, qty, method, price, total };
  tradeLog.push(rec); if (tradeLog.length > 120) tradeLog.shift();
  pendingSales.push(rec);
  lastCreditAt = Date.now();
  log(`💰 ${method==='quickSell'?'QS':'MKT'} ${defId} x${qty} @${price} = ${total} OTWN`);
}
function cleanName(id) { return String(id).replace(/^(mat_|fish_|wpn_|tool_|cos_|food_|med_|kit_|pet_|permit_)/, '').replace(/_/g, ' '); }

function getProfitSummary() {
  const mins = Math.floor((Date.now() - stats.startTime) / 60000);
  const hours = mins / 60;
  const totalEarned = stats.earnedQuick + stats.earnedMarket + stats.pvpEarnings + stats.propertyEarnings;
  const rate = hours > 0 ? Math.round(totalEarned / hours) : 0;
  let heldValue = 0;
  for(const item of inventory) {
    const floor = PRICE_FLOOR[item.defId] || QUICKSELL[item.defId] || 1;
    heldValue += floor * item.qty;
  }
  return { totalEarned, rate, heldValue, qsEarned: stats.earnedQuick, mktEarned: stats.earnedMarket, itemsSold: stats.totalItemsSold, holdCount: stats.holdCount, hours: hours.toFixed(1) };
}

// ============ CRAFTING (v23: ALL RECIPES) ============
function tryCraft(sock) {
  for(const [recipeId, recipe] of Object.entries(GEAR_RECIPES)) {
    let canCraft = true;
    for(const [mat, qty] of Object.entries(recipe.needs)) {
      const item = inventory.find(i => i.defId === mat && i.qty >= qty);
      if(!item) { canCraft = false; break; }
    }
    if(canCraft && balance >= recipe.fee) {
      sock.emit('inventory:craft', { recipeId });
      stats.crafted++;
      log(`🔨 Crafting ${recipeId} (fee: ${recipe.fee} OTWN)`);
      notify(`🔨 <b>Craft</b> ${recipeId}\n💸 Fee: ${recipe.fee} OTWN`);
      return true;
    }
  }
  return false;
}

// ============ FOOD/HEALING (v23: SMART) ============
function tryEatFood(sock) {
  // Priority: med_patch > food items > fish
  const food = inventory.find(i => i.defId === 'med_patch') ||
               inventory.find(i => i.defId === 'food_ember_skewer') ||
               inventory.find(i => i.defId === 'food_volt_noodles') ||
               inventory.find(i => FOOD_ITEMS.has(i.defId));
  if(food) {
    sock.emit('inventory:use', { instanceId: food.instanceId });
    stats.foodEaten++;
    log(`🍖 Used ${food.defId} for healing`);
    return true;
  }
  return false;
}

// ============ CLINIC HEALING ============
function tryClinicHeal(sock) {
  if(zone === 'clinic' && hp < HEAL_HP && balance >= 10) {
    sock.emit('shop:clinicHeal');
    stats.clinicHeals++;
    notify(`🏥 <b>Clinic heal</b> @HP ${hp} · ~10 OTWN`);
    log(`🏥 Clinic heal at HP:${hp}`);
    return true;
  }
  return false;
}

// ============ BUY FOOD FROM SHOP ============
function tryBuyFood(sock) {
  if(balance >= 50 && zone === 'food_row') {
    const foodCount = inventory.filter(i => FOOD_ITEMS.has(i.defId)).reduce((s,i) => s + i.qty, 0);
    if(foodCount < 5) {
      const fqty = Math.min(5, Math.floor(balance / 10));
      sock.emit('shop:foodBuy', { defId: 'food_ember_skewer', qty: fqty });
      stats.itemsBought++;
      notify(`🛒 <b>Beli food</b> food_ember_skewer x${fqty} · ~${fqty*10} OTWN`);
      log(`🛒 Buying food from shop`);
      return true;
    }
  }
  return false;
}

// ============ BANK (v23: AUTO DEPOSIT/WITHDRAW) ============
async function checkBank(tok) {
  try {
    const res = await apiGet('/api/bank/status', tok);
    if(res.status === 200 && res.data) {
      bankInfo = res.data;
      stats.bankBalance = res.data.withdrawable || 0;
      log(`🏦 Bank: ${res.data.withdrawable?.toFixed(2)} OTWN (min: ${res.data.minWithdraw}, fee: ${res.data.feePercent}%)`);
      return res.data;
    }
  } catch(e) { log(`🏦 Bank check failed: ${e.message}`); }
  return null;
}

async function bankDeposit(sock, amount) {
  if(balance > amount && amount >= 100) {
    sock.emit('bank:deposit', { amount });
    stats.bankDeposits++;
    log(`🏦 Depositing ${amount} OTWN to bank`);
  }
}

async function bankWithdraw(sock, amount) {
  if(bankInfo && bankInfo.withdrawable >= amount && amount >= (bankInfo.minWithdraw || 5000)) {
    sock.emit('bank:withdraw', { amount });
    stats.bankWithdrawals++;
    log(`🏦 Withdrawing ${amount} OTWN from bank`);
  }
}

// ============ ECONOMY LEDGER ============
function checkLedger(sock) {
  sock.emit('economy:ledger');
}

// ============ PvP ARENA (v23: NEW!) ============
function pvpQueue(sock) {
  if(level >= 5 && stamina >= 30) {
    sock.emit('pvp:queue');
    stats.pvpQueued++;
    log(`⚔️ PvP: Queued for arena`);
    return true;
  }
  log(`⚔️ PvP: Need Lv5+ and 30+ stamina (Lv${level} STA:${stamina})`);
  return false;
}

function pvpAttack(sock) {
  sock.emit('pvp:attack');
  stats.pvpFights++;
  log(`⚔️ PvP: Attacking!`);
}

function pvpClaim(sock) {
  sock.emit('pvp:claim');
  log(`⚔️ PvP: Claiming rewards`);
}

function pvpLeave(sock) {
  sock.emit('pvp:leave');
  log(`⚔️ PvP: Left arena`);
}

// ============ PROPERTY (v23: NEW!) ============
function checkProperty(sock) {
  sock.emit('property:info', {});
}

function propertyBuy(sock, propertyId) {
  sock.emit('property:buy', { propertyId });
  stats.propertyBought++;
  log(`🏠 Buying property ${propertyId}`);
}

function propertySell(sock, propertyId, price) {
  sock.emit('property:sell', { propertyId, price });
  log(`🏠 Listing property ${propertyId} @${price}`);
}

function propertyPark(sock, propertyId, vehicleId) {
  sock.emit('property:park', { propertyId, vehicleId });
  log(`🏠 Parking vehicle at property`);
}

// ============ VEHICLE (v23: NEW!) ============
function vehicleBuy(sock, defId) {
  if(balance >= 500) {
    sock.emit('vehicle:buy', { defId });
    stats.vehiclesBought++;
    log(`🚗 Buying vehicle ${defId}`);
    notify(`🚗 <b>Beli kendaraan</b> ${defId} · ≥500 OTWN`);
  }
}

// ============ MARKET FLIP (measured, balance-safe, daily-capped) ============
let lastFlipTime = 0;
let buySpentToday = 0;
let buyDay = new Date().toISOString().slice(0, 10);

function spendableBalance() { return balance - config.balanceReserve; }
function rolloverBuyDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== buyDay) { buyDay = today; buySpentToday = 0; }
}
// gate every purchase: respects reserve AND daily buy cap
function canSpend(amount) {
  rolloverBuyDay();
  return spendableBalance() >= amount && (buySpentToday + amount) <= config.dailyBuyCap;
}
function recordSpend(amount) { rolloverBuyDay(); buySpentToday += amount; }

function checkFlipOpportunities(sock, listings) {
  if(!config.flipEnabled) return false;
  if(!MY_PLAYER_ID) return false; // don't flip until we know our own id (avoid buying own listings)
  if(Date.now() - lastFlipTime < config.flipCooldownSec * 1000) return false;
  let bestFlip = null, bestProfit = 0;
  for(const l of listings) {
    if(l.sellerPlayerId === MY_PLAYER_ID || l.status !== 'active') continue;
    if(!l.qty || l.qty < 1) continue;
    const marketPrice = marketPrices[l.defId];
    if(!marketPrice || marketPrice < 5) continue;
    const ppu = l.price / l.qty;
    const listingFee = Math.max(5, Math.round(l.price * 0.05));
    const resaleRevenue = Math.round(marketPrice * l.qty * 0.92); // after ~8% resale fee
    const totalCost = l.price + listingFee;
    const profit = resaleRevenue - totalCost;
    // aggressive: buy if priced under flipUnderprice of market, within budget + reserve
    if(ppu < marketPrice * config.flipUnderprice && l.price <= config.flipMaxCost &&
       profit >= config.flipMinProfit && canSpend(totalCost)) {
      if(profit > bestProfit) { bestProfit = profit; bestFlip = { listing: l, ppu, marketPrice, profit, totalCost }; }
    }
  }
  if(bestFlip) {
    const l = bestFlip.listing;
    log(`🔄 FLIP: ${l.defId} x${l.qty} @${l.price} (ppu:${bestFlip.ppu.toFixed(1)} mkt:${bestFlip.marketPrice} profit:${bestFlip.profit})`);
    notify(`🔄 <b>Flip beli</b> ${cleanName(l.defId)} x${l.qty} @${l.price}\n<i>market ${bestFlip.marketPrice} · est profit +${bestFlip.profit}</i>`);
    sock.emit('marketplace:buy', { listingId: l.id });
    stats.itemsBought++; stats.itemsFlipped++;
    recordSpend(bestFlip.totalCost);
    lastFlipTime = Date.now();
    return true;
  }
  return false;
}

// ============ AUTO-POWERUP (buy items that help leveling / sustained farming) ============
// item -> { maxPrice: max OTWN/unit, maxQty: stop buying once we hold this many, equip?: weapon slot }
const POWERUP_WANTS = {
  kit_repair:        { maxPrice: 60,   maxQty: 5 },   // keep mining tool repaired
  med_patch:         { maxPrice: 70,   maxQty: 6 },   // heal HP
  food_ember_skewer: { maxPrice: 35,   maxQty: 10 },  // stamina -> more actions
  food_volt_noodles: { maxPrice: 35,   maxQty: 10 },
  wpn_rail_lance:    { maxPrice: 2500, maxQty: 1, equip: true }, // stronger weapon -> more kills -> XP
};
let lastPowerupTime = 0;
function invCount(defId) { return inventory.filter(i => i.defId === defId).reduce((s, i) => s + i.qty, 0); }

function checkPowerupBuys(sock, listings) {
  if(!config.powerupEnabled || !MY_PLAYER_ID) return false;
  if(Date.now() - lastPowerupTime < 15000) return false;
  for(const [defId, want] of Object.entries(POWERUP_WANTS)) {
    if(invCount(defId) >= want.maxQty) continue;
    // cheapest active listing of this item within budget
    let best = null;
    for(const l of listings) {
      if(l.sellerPlayerId === MY_PLAYER_ID || l.status !== 'active' || l.defId !== defId) continue;
      const ppu = l.price / (l.qty || 1);
      if(ppu <= want.maxPrice && canSpend(l.price)) {
        if(!best || l.price < best.price) best = l;
      }
    }
    if(best) {
      log(`🆙 POWERUP buy: ${defId} x${best.qty} @${best.price}`);
      notify(`🆙 <b>Beli powerup</b> ${cleanName(defId)} x${best.qty||1} @${best.price}`);
      sock.emit('marketplace:buy', { listingId: best.id });
      stats.itemsBought++;
      recordSpend(best.price);
      if(want.equip) pendingEquip = defId; // try to equip after it lands in inventory
      lastPowerupTime = Date.now();
      return true;
    }
  }
  return false;
}
let pendingEquip = null;
function tryEquipPending(sock) {
  if(!pendingEquip) return;
  const item = inventory.find(i => i.defId === pendingEquip && i.instanceId);
  if(item) {
    sock.emit('equipment:set', { instanceId: item.instanceId, slot: 'weapon' });
    log(`🗡️ Equip ${pendingEquip}`);
    notify(`🗡️ <b>Equip</b> ${cleanName(pendingEquip)}`);
    pendingEquip = null;
  }
}

// ============ WORLD BOSS (v23: FULL) ============
function handleWorldBoss(sock) {
  if(worldBossState && worldBossState.phase === 'active') {
    if(!stats.worldBossActive) {
      stats.worldBossActive = true;
      log(`👹 WORLD BOSS ACTIVE! Entering...`);
      sock.emit('worldboss:enter');
    }
  }
}

function claimBoss(sock) {
  sock.emit('worldboss:claim');
  stats.bossClaims++;
  log(`🏆 Claiming world boss reward`);
}

function leaveBoss(sock) {
  sock.emit('worldboss:leave');
  stats.worldBossActive = false;
  log(`👹 Left world boss`);
}

// ============ PORTAL (v23: NEW!) ============
function enterPortal(sock) {
  sock.emit('portal:enter');
  stats.portalEntries++;
  log(`🌀 Entering portal`);
}

// ============ NOTIFICATION (v23: NEW!) ============
function readNotification(sock, notifId) {
  sock.emit('notification:read', { id: notifId });
}

// ============ PROFILE (v23: NEW!) ============
async function updateProfile(tok) {
  try {
    const res = await apiPost('/api/profile', { name: 'Elaina' }, tok);
    if(res.status === 200) log(`👤 Profile updated`);
  } catch(e) { /* silent */ }
}

// ============ WALKING ============
function walkStaged(sock, wps, idx, cb) {
  if(!connected) return;
  if(idx >= wps.length) { cb(); return; }
  const wp = wps[idx];
  let step = 0;
  log(`  WP${idx+1}/${wps.length}:(${wp.x},${wp.z}) from(${pos.x.toFixed(1)},${pos.z.toFixed(1)})`);
  const iv = setInterval(() => {
    if(!connected) { clearInterval(iv); return; }
    const dx = wp.x - pos.x, dz = wp.z - pos.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if(dist < 2 || step >= MAX_WALK_STEPS) {
      clearInterval(iv);
      if(step > 0) log(`  Arrived WP${idx+1} zone:${zone} steps:${step}`);
      for(let i = 0; i < 5; i++) sock.emit('player:input', {pos:{x:wp.x,y:0,z:wp.z},rotY:0,anim:'idle'});
      setTimeout(() => walkStaged(sock, wps, idx+1, cb), 1000);
      return;
    }
    pos.x += (dx/dist) * WALK_SPEED;
    pos.z += (dz/dist) * WALK_SPEED;
    sock.emit('player:input', {pos:{x:pos.x,y:0,z:pos.z},rotY:Math.atan2(dx,dz),anim:'walk'});
    step++;
  }, 100);
}

function walkDirect(sock, target, cb) {
  if(!connected) { cb(); return; }
  let step = 0;
  log(`  Walk direct to (${target.x},${target.z}) from(${pos.x.toFixed(1)},${pos.z.toFixed(1)})`);
  const iv = setInterval(() => {
    if(!connected) { clearInterval(iv); return; }
    const dx = target.x - pos.x, dz = target.z - pos.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if(dist < 5 || step >= MAX_WALK_STEPS) {
      clearInterval(iv);
      log(`  Direct walk done zone:${zone} steps:${step}`);
      for(let i = 0; i < 5; i++) sock.emit('player:input', {pos:{x:target.x,y:0,z:target.z},rotY:0,anim:'idle'});
      setTimeout(cb, 1000);
      return;
    }
    pos.x += (dx/dist) * WALK_SPEED;
    pos.z += (dz/dist) * WALK_SPEED;
    sock.emit('player:input', {pos:{x:pos.x,y:0,z:pos.z},rotY:Math.atan2(dx,dz),anim:'walk'});
    step++;
  }, 100);
}

// ============ SMART SELL (v23) ============
function doSellPhase(sock, cb) {
  if(dailyEarned >= DAILY_EARN_CAP) log(`⚠️ Over cap ${dailyEarned}/${DAILY_EARN_CAP} — still attempting sales`);
  if(inventory.length === 0) { log('💰 Empty'); cb(); return; }

  tryCraft(sock);

  let totalValue = 0;
  for(const item of inventory) {
    const floor = PRICE_FLOOR[item.defId] || QUICKSELL[item.defId] || 1;
    totalValue += floor * item.qty;
  }
  log(`💰 SELL — ${inventory.length} stacks (value: ~${totalValue} OTWN), daily ${dailyEarned}/${DAILY_EARN_CAP}`);

  const oldListings = [...myActiveListings];
  function cancelNext(idx) {
    if(idx >= oldListings.length) { freshSell(sock, cb); return; }
    sock.emit('marketplace:cancel', { listingId: oldListings[idx].id });
    log(`🔄 Cancel: ${oldListings[idx].defId} @${oldListings[idx].price}`);
    stats.canceled++;
    setTimeout(() => cancelNext(idx + 1), 1500);
  }
  if(oldListings.length > 0) { log(`🔄 Cancel ${oldListings.length} old listings...`); cancelNext(0); }
  else freshSell(sock, cb);
}

function freshSell(sock, cb) {
  const toMarket = [], toQuickSell = [], toHold = [];

  for(const item of inventory) {
    if(KEEP.has(item.defId) || item.qty < 1 || item.status === 'locked') continue;
    const decision = getSellDecision(item.defId, item.qty);
    if(decision.action === 'HOLD') {
      toHold.push({ defId: item.defId, qty: item.qty, reason: decision.reason });
      stats.holdCount++;
      stats.holdValue += (decision.floor || 1) * item.qty;
    } else if(decision.action === 'MARKETPLACE') {
      toMarket.push({
        instanceId: item.instanceId, defId: item.defId, qty: item.qty,
        price: decision.price, marketBest: decision.marketBest,
        depth: decision.depth, trend: decision.trend
      });
    } else {
      toQuickSell.push({ instanceId: item.instanceId, defId: item.defId, qty: item.qty });
    }
  }

  toMarket.sort((a,b) => b.price - a.price);
  const marketVal = toMarket.reduce((s,i) => s + i.price * i.qty, 0);
  const qsVal = toQuickSell.reduce((s,i) => s + (QUICKSELL[i.defId]||1) * i.qty, 0);
  const holdVal = toHold.reduce((s,i) => s + (PRICE_FLOOR[i.defId]||1) * i.qty, 0);

  log(`📊 Market: ${toMarket.length} stacks (~${marketVal} OTWN)`);
  log(`📊 QS: ${toQuickSell.length} stacks (~${qsVal} OTWN)`);
  log(`📊 HOLD: ${toHold.length} stacks (~${holdVal} OTWN)`);
  for(const m of toMarket) log(`  📋 ${m.defId} → market @${m.price} (best:${m.marketBest} depth:${m.depth} trend:${m.trend})`);
  for(const h of toHold) log(`  ⏸️ ${h.defId} x${h.qty} — HOLD (${h.reason})`);

  function listNext(idx) {
    if(idx >= toMarket.length || !connected) {
      if(toQuickSell.length > 0) {
        const safeQS = toQuickSell.filter(i => SAFE_QUICKSELL.has(i.defId));
        const blockedQS = toQuickSell.filter(i => !SAFE_QUICKSELL.has(i.defId));
        if(blockedQS.length > 0) {
          log(`🛑 BLOCKED ${blockedQS.length} items from QS (too valuable)`);
          for(const b of blockedQS) log(`  ⏸️ ${b.defId} x${b.qty} — HOLD`);
        }
        if(safeQS.length > 0) {
          const n = quickSellSafe(sock, safeQS);
          log(`💰 QuickSell ${n} safe stacks (targeted — valuables protected)`);
        }
      }
      setTimeout(() => {
        const p = getProfitSummary();
        log(`💰 Done: QS +${stats.earnedQuick} MKT +${stats.earnedMarket} Total: ${p.totalEarned}`);
        cb();
      }, 3000);
      return;
    }
    const m = toMarket[idx];
    sock.emit('marketplace:list', { instanceId: m.instanceId, qty: 1, price: m.price });
    log(`📋 ${m.defId} @${m.price} (best:${m.marketBest})`);
    setTimeout(() => listNext(idx + 1), MARKET_INTERVAL);
  }

  if(toMarket.length > 0) { log(`📋 Listing ${toMarket.length} items...`); listNext(0); }
  else if(toQuickSell.length > 0) {
    const safeQS = toQuickSell.filter(i => SAFE_QUICKSELL.has(i.defId));
    if(safeQS.length > 0) { const n = quickSellSafe(sock, safeQS); log(`💰 QuickSell ${n} safe stacks (targeted)`); }
    setTimeout(() => { log(`💰 Done: QS +${stats.earnedQuick}`); cb(); }, 3000);
  }
  else if(toHold.length > 0) { log(`⏸️ All ${toHold.length} stacks on HOLD`); cb(); }
  else { log('💰 Nothing sellable'); cb(); }
}

// Targeted terminal-sell of ONLY safe cheap mats, per item instance.
// NEVER use marketplace:sellAll — the server applies it to the WHOLE inventory
// (sells everything except gear/tools/vehicles at terminal price), which dumps
// valuable fish/cores (e.g. Sun Carp, Resonance Core) for a few OTWN.
function quickSellSafe(sock, items) {
  let n = 0;
  for(const it of items) {
    if(!SAFE_QUICKSELL.has(it.defId) || !it.instanceId) continue;
    sock.emit('marketplace:quickSell', { instanceId: it.instanceId, qty: it.qty || 1 });
    n++;
  }
  return n;
}

// ============ ACTIONS (v23: ENHANCED) ============
function doActions(sock, type) {
  if(!connected) return;
  currentActivity = type;
  const cfg = ACTIONS[type];
  let count = 0;
  let lastCatchTime = Date.now();

  const currentMon = MONSTERS[stats.currentMonsterIdx % MONSTERS.length];
  const currentNode = MINING_NODES[stats.currentNodeIdx % MINING_NODES.length];

  log(`Start ${type} (max ${cfg.count}) zone:${zone} ${type==='combat'?'mon:'+currentMon.id:''} ${type==='mining'?'node:'+currentNode.id:''}`);

  const iv = setInterval(() => {
    if(!connected) { clearInterval(iv); return; }

    if(stats.consecutiveErrors >= 5) {
      clearInterval(iv); log(`⚠️ err skip`); stats.consecutiveErrors = 0;
      setTimeout(() => runNextCycle(sock), 2000); return;
    }

    // Fatigue check for mining
    if(fatigueMultiplier < FATIGUE_THRESHOLD && type === 'mining') {
      clearInterval(iv);
      log(`⚠️ Fatigue ${fatigueMultiplier} < ${FATIGUE_THRESHOLD} — switching activity`);
      stats.restCount++;
      setTimeout(() => runNextCycle(sock), 2000);
      return;
    }

    // HP check — eat food if low
    if(hp < LOW_HP) {
      tryEatFood(sock);
    }

    // Fishing timeout
    if(type === 'fishing' && fishingActive && Date.now() - lastCatchTime > FISHING_TIMEOUT) {
      clearInterval(iv);
      log(`🎣 TIMEOUT — skip`);
      stats.fishingTimeouts++;
      fishingActive = false;
      setTimeout(() => runNextCycle(sock), 2000);
      return;
    }

    if(count >= cfg.count) {
      clearInterval(iv);
      if(type === 'mining') {
        stats.currentNodeIdx = (stats.currentNodeIdx + 1) % MINING_NODES.length;
        log(`⛏ Rotated to node: ${MINING_NODES[stats.currentNodeIdx].id}`);
      }
      if(type === 'combat') {
        stats.currentMonsterIdx = (stats.currentMonsterIdx + 1) % MONSTERS.length;
        log(`⚔ Rotated to monster: ${MONSTERS[stats.currentMonsterIdx].id}`);
      }
      setTimeout(() => {
        log(`📊 ${type}:⛏${stats.mined} 🎣${stats.fished} ⚔${stats.kills} +${stats.xp}XP Lv${level} Bal:${balance.toFixed(2)}`);
        setTimeout(() => runNextCycle(sock), 3000);
      }, 2000);
      return;
    }

    if(type === 'mining') {
      sock.emit('mining:start', { nodeId: currentNode.id });
      count++;
    }
    else if(type === 'fishing') {
      if(!fishingActive) {
        sock.emit('fishing:cast', { spotId: 'fish_dock' });
        lastCatchTime = Date.now();
        count++;
      } else {
        if(Date.now() - lastCatchTime > FISHING_TIMEOUT) {
          log(`🎣 STUCK — force reset`);
          fishingActive = false;
          stats.fishingTimeouts++;
        }
      }
    }
    else if(type === 'combat') {
      sock.emit('combat:attack', { monsterId: currentMon.id });
      count++;
    }
    else if(type === 'pvp') {
      pvpAttack(sock);
      count++;
    }
  }, cfg.interval);
}

// ============ CYCLE (v23: ADDS PVP + SHOP + BANK) ============
function runNextCycle(sock) {
  if(!connected) return;
  lastCycleStart = Date.now();
  if(paused) {
    // Idle while paused; re-check shortly. Watchdog won't fire because paused is excluded.
    setTimeout(() => runNextCycle(sock), 5000);
    return;
  }
  if(stats.consecutiveErrors >= 10) {
    log(`⚠️ ${stats.consecutiveErrors} err — reconnect`);
    sock.disconnect();
    scheduleStart(5000);
    return;
  }

  // Stamina check
  if(stamina < LOW_STAMINA) {
    log(`⚠️ Stamina ${stamina} < ${LOW_STAMINA} — eating food`);
    tryEatFood(sock);
  }

  // HP check — go to clinic if very low
  if(hp < LOW_HP && zone !== 'clinic') {
    log(`⚠️ HP ${hp} < ${LOW_HP} — heading to clinic`);
    walkDirect(sock, ZONE_TARGETS.clinic, () => {
      tryClinicHeal(sock);
      setTimeout(() => runNextCycle(sock), 2000);
    });
    return;
  }

  // World boss check
  handleWorldBoss(sock);

  stats.cycles++;

  // v23: Enhanced cycle order with PvP and sell phases
  const order = ['sell', 'mining', 'fishing', 'combat', 'pvp', 'mining', 'fishing', 'combat'];
  const type = order[(stats.cycles - 1) % order.length];

  // Sell phase — ENABLED: list/quicksell inventory to generate income (marketplace is global)
  if(type === 'sell') {
    checkLedger(sock);
    doSellPhase(sock, () => { setTimeout(() => runNextCycle(sock), 1500); });
    return;
  }

  // Skip PvP if not enough level/stamina
  if(type === 'pvp' && (level < 5 || stamina < 30)) {
    log(`⚔️ PvP skip: Lv${level} STA:${stamina}`);
    stats.cycles++;
    setTimeout(() => runNextCycle(sock), 1000);
    return;
  }

  log(`\n=== Cycle ${stats.cycles}: ${type.toUpperCase()} ===`);

  let waypoints;
  if(type === 'mining') waypoints = getMiningWaypoints();
  else if(type === 'combat') waypoints = getCombatWaypoints();
  else if(type === 'pvp') {
    // Walk to arena
    waypoints = [{x:0,z:0}, {x:-80,z:0}, {x:ZONE_TARGETS.arena.x, z:ZONE_TARGETS.arena.z}];
  }
  else waypoints = WAYPOINTS_BASE[type] || [{x:0,z:0}];

  walkStaged(sock, waypoints, 0, () => {
    if(!connected) return;
    const expected = EXPECTED_ZONE[type];
    if(expected && zone !== expected && zone !== 'unknown') {
      log(`⚠️ WRONG ZONE: expected ${expected}, got ${zone}`);
      stats.wrongZone++;
      reportError({ code: 'WRONG_ZONE', expected, zone, context: `expected ${expected}, got ${zone}` });
      // Landed in a known-bad respawn zone repeatedly → skip this cycle to let position settle instead of walk-retrying.
      if (ZONE_BLACKLIST.includes(zone)) { log(`⛔ landed in blacklisted ${zone} — skip cycle`); setTimeout(() => runNextCycle(sock), 2000); return; }
      const target = ZONE_TARGETS[expected];
      if(target) {
        log(`🔄 Retrying walk to ${expected}...`);
        walkDirect(sock, target, () => {
          if(zone !== expected) {
            log(`⚠️ Still wrong zone (${zone}), skip cycle`);
            setTimeout(() => runNextCycle(sock), 2000);
            return;
          }
          startAction(sock, type);
        });
        return;
      }
    }
    startAction(sock, type);
  });
}

function getMiningWaypoints() {
  const node = MINING_NODES[stats.currentNodeIdx % MINING_NODES.length];
  return [{x:0,z:0}, {x:node.pos.x, z:node.pos.z}];
}

function getCombatWaypoints() {
  const mon = MONSTERS[stats.currentMonsterIdx % MONSTERS.length];
  return [{x:0,z:0}, {x:-80,z:0}, {x:mon.pos.x, z:mon.pos.z}];
}

function startAction(sock, type) {
  if(type === 'combat') {
    const mon = MONSTERS[stats.currentMonsterIdx % MONSTERS.length];
    walkDirect(sock, mon.pos, () => doActions(sock, type));
  }
  else if(type === 'mining') {
    const node = MINING_NODES[stats.currentNodeIdx % MINING_NODES.length];
    walkDirect(sock, node.pos, () => doActions(sock, type));
  }
  else if(type === 'pvp') {
    pvpQueue(sock);
    doActions(sock, type);
  }
  else doActions(sock, type);
}

// ============ MAIN BOT ============
let fundingNotified = false;
async function startBot() {
  if (stopped) { log('⏹️ startBot skipped — bot is stopped'); return; }
  // single-socket guard: cancel pending retry + tear down any old socket
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (activeSocket) { try { activeSocket.removeAllListeners(); activeSocket.disconnect(); } catch (e) {} activeSocket = null; }
  connected = false;
  inventoryReady = false;
  if(!token || isTokenExpired(token)) {
    try { token = await authenticate(); }
    catch(e) {
      log('❌ Auth failed: ' + e.message);
      if (/timeout/i.test(e.message)) reportError({ code: 'AUTH_TIMEOUT', context: 'auth request timeout', category: 'reconnect' });
      // Auto-detect "needs funding": wallet must hold >= required OTWN to play
      const m = e.message.match(/INSUFFICIENT_OTWN.*?"required":(\d+)/) || (e.message.includes('INSUFFICIENT_OTWN') ? [null, '5000'] : null);
      if (m) {
        if (!fundingNotified) {
          fundingNotified = true;
          notify(`⛽ <b>Wallet needs funding</b>\nHold at least <b>${m[1]} $OTWN</b> to enter Player Mode.\nWallet: <code>${WALLET_ADDR}</code>\nI'll keep checking every 5 min and auto-start once funded.`);
        }
        scheduleStart(300000); // slow 5-min retry while unfunded
        return;
      }
      fundingNotified = false;
      scheduleStart(30000);
      return;
    }
    fundingNotified = false; // auth succeeded -> reset for next time
  }

  const socket = io('https://' + GAME_HOST, { auth: { token }, transports: ['polling'], upgrade: false, reconnection: false });

  // === PLAYER STATE ===
  socket.on('player:correction', (d) => { if(d.pos) { pos.x = d.pos.x; pos.z = d.pos.z; } });
  socket.on('player:state', (d) => {
    if(d.zone) zone = d.zone;
    if(d.lockedBalance !== undefined) lockedBalance = d.lockedBalance;
    if(d.withdrawableBalance !== undefined) withdrawableBalance = d.withdrawableBalance;
    if(d.gameBalance !== undefined) {
      if(prevBalance !== null && d.gameBalance < prevBalance) {
        const drop = +(prevBalance - d.gameBalance).toFixed(2);
        if(drop >= BALANCE_DROP_ALERT) {
          // If locked went up by ~the same amount, the money is escrowed in
          // market listings (recoverable), not actually spent.
          const lockedHint = lockedBalance > 0 ? `\n🔒 Locked (listing/escrow): <b>${lockedBalance}</b> — kemungkinan dana ke-hold di listing, bukan hilang` : '';
          notify(`📉 <b>Saldo turun ${drop} OTWN</b>\n💰 Spendable: <b>${d.gameBalance.toFixed(0)}</b> (dari ${prevBalance.toFixed(0)})${lockedHint}\n🏦 Withdrawable: ${withdrawableBalance}`);
        }
      }
      prevBalance = d.gameBalance;
      balance = d.gameBalance;
    }
    if(d.level !== undefined) {
      if(level && d.level > level) notifySys(`⬆️ <b>Level up!</b> Now level ${d.level}`);
      level = d.level;
    }
    if(d.stamina !== undefined) stamina = d.stamina;
    if(d.dailyEarnedOtwn !== undefined) dailyEarned = d.dailyEarnedOtwn;
    if(d.dailyEarnCap !== undefined && d.dailyEarnCap !== DAILY_EARN_CAP) {
      DAILY_EARN_CAP = d.dailyEarnCap;
      log(`📊 Server daily earn cap: ${DAILY_EARN_CAP} OTWN`);
    }
    if(d.hp !== undefined) hp = d.hp;
    if(d.maxHp !== undefined) maxHp = d.maxHp;
    // auto-detect our player id (used by flip/listing logic)
    const pid = d.playerId || d.id || d.playerID;
    if(pid && !MY_PLAYER_ID) { MY_PLAYER_ID = String(pid); log(`🆔 Detected player id: ${MY_PLAYER_ID}`); }
  });

  // === INVENTORY ===
  socket.on('inventory:update', (d) => {
    inventory = (d.items || []).filter(i => i.qty > 0);
    if(!inventoryReady) { inventoryReady = true; log(`📦 ${inventory.length} stacks`); }
    const tool = d.items.find(i => i.defId === 'tool_pulse_pick');
    if(tool && tool.durability !== null && tool.durability < LOW_DURABILITY && tool.instanceId) {
      log(`🔧 Repair dur:${tool.durability}`);
      socket.emit('inventory:repair', { instanceId: tool.instanceId });
      stats.repaired++;
    }
    tryEquipPending(socket); // equip a just-bought weapon once it lands in inventory
  });

  // === MARKETPLACE ===
  socket.on('marketplace:update', (d) => {
    if(d.listings) {
      myActiveListings = d.listings.filter(l => l.sellerPlayerId === MY_PLAYER_ID && l.status === 'active');
      scanMarketPrices(d.listings);
      // smart auto-buy: flip underpriced for profit, then buy powerup/upgrade items
      if(!checkFlipOpportunities(socket, d.listings)) checkPowerupBuys(socket, d.listings);
    }
  });

  // === MINING ===
  socket.on('mining:result', (d) => {
    touchActivity();
    stats.mined++; stats.xp += d.xpGained || 0; stats.items += d.qty || 0; stats.consecutiveErrors = 0;
    if(d.fatigueMultiplier !== undefined) fatigueMultiplier = d.fatigueMultiplier;
    if(d.fatigueMultiplier < 0.95) stats.fatigueDrops++;
    const sp = getSellDecision(d.defId, d.qty);
    log(`⛏ ${d.itemName} x${d.qty} +${d.xpGained}XP STA:${Math.round(d.stamina||0)} ${d.fatigueMultiplier<0.95?'⚠️fatigue':''} → ${sp.action}${sp.price?'@'+sp.price:''}`);
  });
  socket.on('mining:error', (d) => {
    reportError({ code: d.code, context: `mining ${d.code}` });
    if(d.code !== 'COOLDOWN') log(`⛏ ERR:${d.code}`);
  });

  // === FISHING ===
  socket.on('fishing:cast', (d) => { fishingActive = true; log(`🎣 Wait ${Math.round(d.waitMs/1000)}s`); });
  socket.on('fishing:result', (d) => {
    touchActivity();
    fishingActive = false; stats.fished++; stats.xp += d.xp || d.xpGained || 0; stats.items += d.qty || 1; stats.consecutiveErrors = 0;
    const sp = getSellDecision(d.defId || 'fish', d.qty || 1);
    log(`🎣 ${d.itemName||d.defId||'fish'} x${d.qty||1} +${d.xp||d.xpGained||0}XP → ${sp.action}${sp.price?'@'+sp.price:''}${sp.reason?' ('+sp.reason+')':''}`);
  });
  socket.on('fishing:error', (d) => { fishingActive = false; reportError({ code: d.code, context: `fishing ${d.code}`, zone }); log(`🎣 ERR:${d.code}`); });

  // === COMBAT ===
  socket.on('combat:result', (d) => {
    touchActivity();
    stats.fought++; stats.xp += d.xpGained || 0; stats.consecutiveErrors = 0;
    if(d.playerHp !== undefined) hp = d.playerHp;
    if(d.counterDamage > 0) log(`⚔ HIT:${d.damage} HP:${d.monsterHp} MY_HP:${hp} COUNTER:${d.counterDamage}`);
    if(d.killed) { stats.kills++; log(`⚔ KILL! +${d.xpGained}XP`); }
  });
  socket.on('combat:error', (d) => {
    reportError({ code: d.code, context: `combat ${d.code}` });
    if(d.code === 'NO_TARGET') {
      stats.currentMonsterIdx = (stats.currentMonsterIdx + 1) % MONSTERS.length;
      log(`⚔ NO_TARGET → next monster: ${MONSTERS[stats.currentMonsterIdx].id}`);
    } else if(d.code !== 'COOLDOWN') {
      log(`⚔ ERR:${d.code}`);
    }
  });
  socket.on('combat:drop', (d) => { stats.items++; log(`⚔ DROP: ${d.itemName} x${d.qty}`); });

  // === WORLD BOSS (v23: FULL) ===
  socket.on('worldboss:state', (d) => {
    worldBossState = d;
    if(d.phase === 'active' && !stats.worldBossActive) {
      stats.worldBossActive = true;
      log(`👹 WORLD BOSS ACTIVE! ${d.name || ''} HP:${d.hp}/${d.maxHp}`);
      notifySys(`👹 <b>World Boss spawned!</b> ${d.name || ''} — auto-entering`);
      socket.emit('worldboss:enter');
    }
    if(d.phase === 'dead') {
      log(`👹 WORLD BOSS DEAD! Claiming...`);
      claimBoss(socket);
    }
  });
  socket.on('worldboss:result', (d) => {
    if(d.claimed) {
      stats.bossClaims++;
      log(`🏆 BOSS CLAIMED! Rank #${d.rank} Reward: ${d.reward || '?'}`);
    }
  });

  // === PvP ARENA (v23: NEW!) ===
  socket.on('pvp:state', (d) => {
    pvpState = d;
    log(`⚔️ PvP state: ${d.status || d.phase || 'unknown'} ${d.opponent ? 'vs '+d.opponent : ''}`);
    if(d.hp !== undefined) hp = d.hp;
  });
  socket.on('pvp:hit', (d) => {
    log(`⚔️ PvP HIT: ${d.damage} to ${d.target} HP:${d.targetHp}`);
    if(d.playerHp !== undefined) hp = d.playerHp;
  });
  socket.on('pvp:result', (d) => {
    stats.pvpFights++;
    if(d.won) {
      stats.pvpWins++;
      const reward = d.reward || d.otwn || 0;
      stats.pvpEarnings += reward;
      bucketEarn(reward);
      log(`⚔️ PvP WIN! +${reward} OTWN +${d.xp||0}XP`);
    } else {
      log(`⚔️ PvP LOSS ${d.xp ? '+'+d.xp+'XP' : ''}`);
    }
  });
  socket.on('pvp:leaderboard', (d) => {
    if(d.entries) log(`⚔️ PvP leaderboard: ${d.entries.length} players, top: ${d.entries[0]?.name || '?'}`);
  });
  socket.on('pvp:leaderboardData', (d) => {
    if(d.entries) log(`⚔️ PvP leaderboard data: ${d.entries.length} entries`);
  });

  // === PROPERTY (v23: NEW!) ===
  socket.on('property:info', (d) => {
    log(`🏠 Property info: ${d.properties?.length || 0} owned, ${d.available?.length || 0} available`);
  });
  socket.on('property:infoResult', (d) => {
    log(`🏠 Property result: ${JSON.stringify(d).substring(0, 200)}`);
  });
  socket.on('property:result', (d) => {
    if(d.ok) {
      log(`🏠 Property action OK: ${d.action || 'unknown'}`);
      if(d.action === 'buy') stats.propertyBought++;
      if(d.action === 'sell') stats.propertySold++;
      if(d.earnings) { stats.propertyEarnings += d.earnings; bucketEarn(d.earnings); }
    } else {
      log(`🏠 Property fail: ${d.code || d.message}`);
    }
  });
  socket.on('property:entered', (d) => {
    log(`🏠 Entered property: ${d.propertyId || d.name || '?'}`);
  });

  // === SHOP (v23: NEW!) ===
  socket.on('shop:result', (d) => {
    if(d.ok) {
      log(`🛒 Shop OK: ${d.item || d.action || 'bought'}`);
      stats.itemsBought++;
    } else {
      log(`🛒 Shop fail: ${d.code || d.message}`);
    }
  });

  // === ECONOMY (v23: NEW!) ===
  socket.on('economy:ledger', (d) => {
    if(d.entries) {
      economyLedger = d.entries;
      const recent = d.entries.slice(0, 5);
      log(`📊 Ledger: ${d.entries.length} entries, recent: ${recent.map(e => `${e.type}:${e.amount}`).join(', ')}`);
    }
  });

  // === PORTAL ===
  socket.on('portal:enter', (d) => {
    log(`🌀 Portal entered: ${d.destination || d.zone || '?'}`);
    stats.portalEntries++;
  });

  // === NOTIFICATIONS (v23: NEW!) ===
  socket.on('notification', (d) => {
    notifications.push(d);
    stats.notifications++;
    if(d.type === 'pvp_challenge' || d.type === 'boss_spawn') {
      log(`🔔 Notif: ${d.type} — ${d.message || ''}`);
    }
  });

  // === ADS (v23: NEW!) ===
  socket.on('ads:update', (d) => {
    if(d.ads) log(`📢 Ads update: ${d.ads.length} ads`);
  });

  // === CHAT (v23: NEW!) ===
  socket.on('chat:message', (d) => {
    // Silent — too noisy
  });
  socket.on('chat:history', (d) => {
    if(d.messages) log(`💬 Chat history: ${d.messages.length} messages`);
  });

  // === CRAFTING ===
  socket.on('inventory:craft', (d) => {
    stats.crafted++;
    log(`🔨 Crafted: ${JSON.stringify(d).substring(0, 100)}`);
  });

  // === REPAIR ===
  socket.on('inventory:repair', (d) => { log('🔧 Repaired!'); });

  // === MARKETPLACE RESULTS ===
  socket.on('marketplace:result', (d) => {
    log(`🔍 MKT result: ${JSON.stringify(d).substring(0, 300)}`);
    if(d.ok) {
      if(d.action === 'cancel') { stats.canceled++; log(`✅ Canceled`); }
      else if(d.credited) {
        const defId = d.defId || d.itemId || 'quicksell';
        const qty = d.count || d.qty || 1;
        recordSale(defId, qty, 'quickSell', d.credited);
      }
      // v23: Track buy results
      if(d.action === 'buy' && d.listingId) {
        stats.itemsBought++;
        log(`🛒 Bought listing ${d.listingId}`);
      }
    } else log(`💰 Fail: ${d.code || d.message}`);
  });

  socket.on('marketplace:quickSell:result', (d) => {
    if(d.credited) {
      const defId = d.defId || d.itemId || 'quicksell';
      const qty = d.count || d.qty || 1;
      recordSale(defId, qty, 'quickSell', d.credited);
    }
  });

  ['marketplace:list:result', 'marketplace:listed'].forEach(evt => {
    socket.on(evt, (d) => { stats.listed++; log(`📋 Listed! ${JSON.stringify(d).substring(0, 100)}`); });
  });

  socket.on('marketplace:sellAll:result', (d) => {
    log(`🔍 sellAll result: ${JSON.stringify(d).substring(0, 300)}`);
    if(d.credited) {
      recordSale('sellAll-bulk', d.count || d.items || 1, 'quickSell', d.credited);
    }
    if(d.items && Array.isArray(d.items)) {
      for(const item of d.items) {
        if(item.credited) {
          recordSale(item.defId || 'item', item.qty || 1, 'quickSell', item.credited);
        }
      }
    }
  });

  // === TOAST TRACKER ===
  socket.on('toast', (d) => {
    if(d.kind === 'success') {
      const msg = (d.message || '').toLowerCase();
      // Capture PASSIVE market sales (a buyer bought our listing) which only arrive via toast.
      // Guard: skip if an explicit result credit fired in the last 3.5s (avoids double-count of sellAll/quicksell).
      if((msg.includes('sold') || msg.includes('received')) && Date.now() - lastCreditAt > 3500) {
        const m = d.message.match(/(\d[\d,]*)\s*\$?OTWN/);
        if(m) { const amount = parseInt(m[1].replace(/,/g, '')); if(amount > 0) recordSale('market-sale', 1, 'marketplace', amount); }
      }
      if(msg.includes('list')) stats.listed++;
      if(msg.includes('pvp') || msg.includes('arena')) {
        log(`⚔️ PvP toast: ${d.message}`);
      }
      if(msg.includes('property') || msg.includes('house')) {
        log(`🏠 Property toast: ${d.message}`);
      }
    }
  });

  // === CONNECTION ===
  socket.on('connect', () => {
    connected = true;
    touchActivity();
    if(retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    log('Connected!');
    notifySys(`🟢 <b>Connected</b> — farming dimulai 🎮\n<i>${GAME_HOST}</i>`);
    activeSocket = socket;
    let started = false;
    socket.on('player:correction', function onCorr(d) {
      if(!started && d.pos) {
        pos.x = d.pos.x; pos.z = d.pos.z; started = true;
        socket.removeListener('player:correction', onCorr);
        log(`Pos:(${pos.x.toFixed(1)},${pos.z.toFixed(1)}) zone:${zone}`);
        waitForInventory(socket, () => {
          // v23: Initial setup after connect
          checkLedger(socket);
          checkBank(token);
          runNextCycle(socket);
        });
      }
    });
    setTimeout(() => {
      if(!started) {
        started = true;
        waitForInventory(socket, () => runNextCycle(socket));
      }
    }, 3000);
  });

  socket.on('disconnect', (reason) => {
    log('Disconnected! reason: ' + reason);
    connected = false;
    if (stopped) { log('⏹️ stopped — not reconnecting'); return; }
    reportError({ code: reason, context: 'socket disconnect', category: 'reconnect' });
    notifySys(`🔴 <b>Disconnected</b> — auto-reconnect in ${Math.round(RECONNECT_BACKOFF_MS/1000)}s`);
    scheduleStart(RECONNECT_BACKOFF_MS);
  });

  socket.on('connect_error', (err) => {
    log('⚠️ connect_error: ' + (err && err.message || err));
    if (stopped) return;
    reportError({ code: (err && err.message) || 'connect_error', context: 'connect_error', category: 'reconnect' });
    // clear token so the next attempt re-authenticates (covers stale/expired/rejected tokens)
    token = null;
    try { socket.disconnect(); } catch {}
    scheduleStart(5000);
  });

  function waitForInventory(sock, cb) {
    if(inventoryReady) { cb(); return; }
    log('⏳ Wait inv...');
    let w = 0;
    const iv = setInterval(() => {
      w += 500;
      if(inventoryReady || w > 5000) { clearInterval(iv); cb(); }
    }, 500);
  }
}

// ============ STATUS SUMMARY (shared by report + /status) ============
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function buildStatusText() {
  const p = getProfitSummary();
  const conn = connected ? '🟢' : '🔴';
  const state = paused ? '⏸️ paused' : (connected ? '▶️ farming' : '⏳ offline');
  const up = fmtUptime(Date.now() - stats.startTime);
  return [
    `${conn} <b>OWNTOWN BOT</b> · ${state}`,
    `<i>⏱ ${up}  ·  📍 ${zone}  ·  🧍 Lv ${level}</i>`,
    ``,
    `💰 <b>Profit</b>`,
    '<pre>' +
      `Total      ${fmt(p.totalEarned)} OTWN\n` +
      `Rate       ${fmt(p.rate)} /h\n` +
      `QuickSell  +${fmt(stats.earnedQuick)}\n` +
      `Market     +${fmt(stats.earnedMarket)}\n` +
      `PvP        +${fmt(stats.pvpEarnings)}\n` +
      `Items sold ${fmt(p.itemsSold)}` +
    '</pre>',
    `🏦 <b>Wallet</b>`,
    '<pre>' +
      `Balance    ${fmt(Math.round(balance))}\n` +
      `Bank       ${fmt(stats.bankBalance)}\n` +
      `Daily      ${fmt(dailyEarned)} / ${fmt(DAILY_EARN_CAP)}` +
    '</pre>',
    `🎒 <b>Character & Activity</b>`,
    `❤️ ${hp}/${maxHp}   ⚡ ${stamina}   📦 ${inventory.length}/${CARRY_CAP}   ⏸ held ${stats.holdCount}`,
    `⛏ ${fmt(stats.mined)}  🎣 ${fmt(stats.fished)}  ⚔ ${fmt(stats.kills)}  🛒 ${fmt(stats.itemsBought)}  🔨 ${fmt(stats.crafted)}  👹 ${fmt(stats.bossClaims)}`,
    `${stats.errors ? '⚠️' : '✅'} errors ${stats.errors}   🌀 wrongzone ${stats.wrongZone}`,
  ].join('\n');
}

// ============ DASHBOARD SNAPSHOT ============
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
}
function getSnapshot() {
  const p = getProfitSummary();
  const market = Object.entries(marketPrices).filter(([k]) => PRICE_FLOOR[k])
    .map(([k, v]) => { const t = getPriceTrend(k); const i = t === 'rising' ? '📈' : t === 'falling' ? '📉' : '➡️'; return `${k.replace('mat_', '').replace('fish_', '')}:${v}${i}`; }).join('  ');
  return {
    connected, paused, uptime: fmtUptime(Date.now() - stats.startTime),
    wallet: WALLET_ADDR, balance, dailyEarned, dailyCap: DAILY_EARN_CAP, bankBalance: stats.bankBalance,
    totalEarned: p.totalEarned, rate: p.rate, earnedQuick: stats.earnedQuick, earnedMarket: stats.earnedMarket,
    pvpEarnings: stats.pvpEarnings, itemsSold: stats.totalItemsSold,
    level, xp: stats.xp, hp, maxHp, stamina, zone, invCount: inventory.length, carryCap: CARRY_CAP,
    activity: paused ? 'paused' : (stopped ? 'stopped (manual play)' : (connected ? currentActivity : 'offline')),
    posX: Math.round(pos.x), posZ: Math.round(pos.z),
    node: MINING_NODES[stats.currentNodeIdx % MINING_NODES.length].id,
    monster: MONSTERS[stats.currentMonsterIdx % MONSTERS.length].id,
    nodeIdx: stats.currentNodeIdx % MINING_NODES.length,
    monIdx: stats.currentMonsterIdx % MONSTERS.length,
    map: {
      zones: Object.entries(ZONE_TARGETS).map(([name, p]) => ({ name, x: p.x, z: p.z })),
      nodes: MINING_NODES.map(n => ({ x: n.pos.x, z: n.pos.z })),
      monsters: MONSTERS.map(m => ({ x: m.pos.x, z: m.pos.z })),
    },
    mined: stats.mined, fished: stats.fished, kills: stats.kills, flips: stats.itemsBought,
    crafted: stats.crafted, bossClaims: stats.bossClaims, errors: stats.errors,
    market, log: LOG_RING.slice(-60), hourly: getHourly(12),
    schedule: schedStatus(), errorsStreak: stats.consecutiveErrors,
    memMB: Math.round(process.memoryUsage().rss / 1048576),
    propertyEarnings: stats.propertyEarnings, bankBal: stats.bankBalance,
    canceled: stats.canceled, listed: stats.listed, repaired: stats.repaired,
    inventory: inventory.map(i => ({ name: cleanName(i.defId), defId: i.defId, qty: i.qty, value: (PRICE_FLOOR[i.defId] || QUICKSELL[i.defId] || 0) * i.qty })),
    trades: tradeLog.slice(-50).reverse().map(r => ({ t: r.t, name: cleanName(r.defId), qty: r.qty, method: r.method, price: r.price, total: r.total })),
    listings: myActiveListings.map(l => ({ name: cleanName(l.defId), qty: l.qty || 1, price: l.price, total: l.price })),
    settings: {
      schedule: scheduleActive ? config.scheduleRaw : 'off',
      jitter: config.scheduleJitterPct,
      reportMin: config.reportIntervalMin,
      watchdogMin: config.watchdogStuckMin,
      profitOnly: config.notifyProfitOnly,
      dailyCap: DAILY_EARN_CAP,
      flip: config.flipEnabled ? `< ${Math.round(config.flipUnderprice*100)}% mkt, max ${config.flipMaxCost}, cd ${config.flipCooldownSec}s` : 'off',
      reserve: config.balanceReserve,
      powerup: config.powerupEnabled ? 'on' : 'off',
      buyCap: config.dailyBuyCap,
    },
    buySpent: buySpentToday,
  };
}

// generate + persist a dashboard access key + login password if none set
let DASH_KEY = config.dashboardKey;
if (!DASH_KEY) { DASH_KEY = crypto.randomBytes(8).toString('hex'); persistEnv('DASHBOARD_KEY', DASH_KEY); }
let DASH_PASS = config.dashPass;
if (!DASH_PASS) { DASH_PASS = crypto.randomBytes(6).toString('base64url'); persistEnv('DASH_PASS', DASH_PASS); log(`🖥️ Dashboard login → user: ${config.dashUser}  pass: ${DASH_PASS}`); }
startDashboard({ port: config.dashboardPort, key: DASH_KEY, user: config.dashUser, pass: DASH_PASS, getSnapshot, logger: log });

// ============ STATUS REPORT (configurable interval) ============
setInterval(() => {
  log('\n' + buildStatusText().replace(/<[^>]+>/g, '') + '\n');
  notify(buildStatusText());
}, Math.max(1, config.reportIntervalMin) * 60000);

// ============ DAILY REPORT (once / 24h, or via /daily) ============
let dailyBaseline = null;
function snapDailyBaseline() {
  const p = getProfitSummary();
  dailyBaseline = {
    t: Date.now(), balance, totalEarned: p.totalEarned, itemsSold: p.itemsSold,
    buySpent: buySpentToday, mined: stats.mined, fished: stats.fished, kills: stats.kills,
  };
}
function buildDailyReport() {
  const p = getProfitSummary();
  const b = dailyBaseline || { t: stats.startTime, balance, totalEarned: 0, itemsSold: 0, buySpent: 0, mined: 0, fished: 0, kills: 0 };
  const hrs = Math.max(0.1, (Date.now() - b.t) / 3600000);
  const earned = p.totalEarned - b.totalEarned;
  const spent = buySpentToday - b.buySpent;            // flip/powerup buys (other fees are tiny)
  const netBal = Math.round(balance - b.balance);
  return [
    `📅 <b>DAILY REPORT</b> · ~${hrs.toFixed(1)}h`,
    '<pre>' +
      `Earned       +${fmt(Math.round(earned))} OTWN\n` +
      `Buy spent    -${fmt(Math.round(spent))} OTWN\n` +
      `Net balance  ${netBal >= 0 ? '+' : ''}${fmt(netBal)} OTWN\n` +
      `Daily cap    ${fmt(dailyEarned)} / ${fmt(DAILY_EARN_CAP)}\n` +
      `Balance now  ${fmt(Math.round(balance))}\n` +
      `Locked       ${fmt(lockedBalance)}\n` +
      `Bank         ${fmt(stats.bankBalance)}\n` +
      `Items sold   ${fmt(p.itemsSold - b.itemsSold)}\n` +
      `⛏ ${fmt(stats.mined - b.mined)}  🎣 ${fmt(stats.fished - b.fished)}  ⚔ ${fmt(stats.kills - b.kills)}` +
    '</pre>',
  ].join('\n');
}
snapDailyBaseline();
setInterval(() => { notify(buildDailyReport()); snapDailyBaseline(); }, 24 * 3600000);

// ============ SALES DIGEST (near-real-time, batched ~2 min) ============
setInterval(() => {
  if (!pendingSales.length) return;
  const count = pendingSales.reduce((s, r) => s + r.qty, 0);
  const sum = pendingSales.reduce((s, r) => s + r.total, 0);
  const lines = {};
  for (const r of pendingSales) {
    const k = cleanName(r.defId);
    if (!lines[k]) lines[k] = { qty: 0, total: 0 };
    lines[k].qty += r.qty; lines[k].total += r.total;
  }
  const body = Object.entries(lines).sort((a,b)=>b[1].total-a[1].total).slice(0,12)
    .map(([k, v]) => `${k.padEnd(16).slice(0,16)} x${String(v.qty).padStart(3)}  +${fmt(v.total)}`).join('\n');
  pendingSales = [];
  const p = getProfitSummary();
  notify(`🛒 <b>Terjual</b> ${count} item · +${fmt(sum)} OTWN\n<pre>${body}</pre>📍 ${currentActivity} · 💰 Total: ${fmt(p.totalEarned)} · ${fmt(p.rate)}/h`);
}, 120000);

// ============ AUTOPILOT WATCHDOG ============
// Detects "stuck" states the in-socket recovery misses and self-heals.
const WATCHDOG_STUCK_MS = Math.max(2, config.watchdogStuckMin) * 60000;
setInterval(() => {
  if (paused || stopped) return;
  const idle = Date.now() - lastActivity;
  // 1) Connected but no game activity for too long -> kick the cycle / reconnect
  if (connected && idle > WATCHDOG_STUCK_MS) {
    log(`🐶 WATCHDOG: no activity for ${Math.round(idle/60000)}m — recovering`);
    notifySys(`🐶 <b>Watchdog</b>: stuck ${Math.round(idle/60000)}m, restarting cycle`);
    touchActivity(); // reset so we don't loop instantly
    if (activeSocket && activeSocket.connected) {
      try { runNextCycle(activeSocket); } catch (e) { log('🐶 cycle restart failed: ' + e.message); }
    } else {
      scheduleStart(2000);
    }
  }
  // 2) Fully disconnected for way too long -> hard reconnect
  if (!connected && idle > WATCHDOG_STUCK_MS * 2) {
    log(`🐶 WATCHDOG: offline too long — hard restart`);
    touchActivity();
    scheduleStart(2000);
  }
}, 60000);

// ============ TELEGRAM COMMANDS ============
tg.on('help', () => notify([
  '<b>Owntown Bot — commands</b>',
  '/start — bot ON (connect + farming)',
  '/stop — bot OFF (lepas sesi, buat main manual)',
  '/status — ringkasan stats live',
  '/dashboard — link panel web',
  '/balance — saldo + locked + bank',
  '/daily — ringkasan harian (earned/spent/net)',
  '/log [n] — log terakhir (default 15)',
  '/pause — jeda farming (tetap connect)',
  '/resume — lanjut farming',
  '/inventory — isi tas',
  '/income — rincian pendapatan',
  '/health — kesehatan sistem',
  '/errors — error terakhir',
  '/schedule — jadwal anti-detect',
  '/ping — cek bot hidup',
  '/restart — restart proses',
  '/update — pull update code + restart',
  '/reauth — login ulang ke game',
  '',
  '<i>⚠️ 1 wallet = 1 sesi. Mau main manual? /stop dulu.</i>',
].join('\n')));
tg.on('start', () => {
  paused = false; stopped = false;
  if (connected) { notify('▶️ Already farming. /status for stats.'); return; }
  notify('🚀 Bot ON — connecting + farming…\n<i>Pastikan kamu LOGOUT dari Owntown manual (1 wallet = 1 sesi).</i>');
  startBot();
});
tg.on('stop', () => {
  stopped = true; paused = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  try { if (activeSocket) activeSocket.disconnect(); } catch {}
  connected = false;
  notify('⏹️ <b>Bot OFF</b> — sesi game dilepas.\nSekarang kamu bebas main manual pakai wallet ini. Ketik /start kalau mau bot lanjut lagi.');
  log('⏹️ Stopped via Telegram (manual play mode)');
});
let publicIp = '';
function getPublicIp() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d.trim())); })
      .on('error', () => resolve('')).setTimeout(8000, function () { this.destroy(); resolve(''); });
  });
}
tg.on('dashboard', async () => {
  if (!publicIp) publicIp = await getPublicIp();
  const host = publicIp || 'YOUR_VPS_IP';
  const link = `http://${host}:${config.dashboardPort}/?key=${DASH_KEY}`;
  notify(`🖥️ <b>Dashboard</b>\n${link}\n\n(Live: wallet, saldo, profit, market, log — auto-refresh 5s)`);
});
tg.on('status', () => notify(buildStatusText()));
tg.on('stats', () => notify(buildStatusText()));
tg.on('balance', () => notify(`💰 Balance: <b>${balance.toFixed(2)}</b> OTWN\n🔒 Locked: ${lockedBalance}\n🏦 Bank withdrawable: ${stats.bankBalance}\n📅 Daily earned: ${dailyEarned}/${DAILY_EARN_CAP}`));
tg.on('daily', () => notify(buildDailyReport()));
tg.on('log', (args) => {
  const n = Math.min(50, Math.max(1, parseInt(args[0] || '15', 10) || 15));
  const lines = LOG_RING.slice(-n).join('\n') || '(no logs yet)';
  notify('<pre>' + lines.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>');
});
tg.on('pause', () => { paused = true; log('⏸️ Paused via Telegram'); notify('⏸️ Farming <b>paused</b>. /resume to continue.'); });
tg.on('resume', () => {
  if (!paused) { notify('▶️ Already running.'); return; }
  paused = false; log('▶️ Resumed via Telegram'); notify('▶️ Farming <b>resumed</b>.');
  if (activeSocket && activeSocket.connected) runNextCycle(activeSocket);
});
tg.on('reauth', () => {
  notify('🔑 Re-authenticating...'); token = null;
  try { if (activeSocket) activeSocket.disconnect(); } catch {}
  setTimeout(startBot, 1500);
});
tg.on('ping', () => notify(`🏓 <b>pong</b> · ${connected ? '🟢 online' : '🔴 offline'} · ⏱ ${fmtUptime(Date.now() - stats.startTime)}`));
tg.on('logs', (a) => tg.handlers['log'](a));
tg.on('schedule', () => {
  const list = schedulePhases.map((p, i) => `${i === schedIdx ? '▶️' : '  '} ${p.state.toUpperCase()} ${p.hours}j`).join('\n');
  notify(`🗓️ <b>Anti-detect schedule</b>\n${scheduleActive ? schedStatus() : 'disabled'}\n<pre>${list || 'none'}</pre>`);
});
tg.on('health', () => {
  const mem = process.memoryUsage();
  const idleM = Math.round((Date.now() - lastActivity) / 60000);
  notify([
    `🩺 <b>Health</b>`,
    '<pre>' +
    `Game       ${connected ? 'OK 🟢' : 'DOWN 🔴'}\n` +
    `Telegram   ${tg.enabled ? 'OK 🟢' : 'DOWN 🔴'}\n` +
    `Token      ${token && !isTokenExpired(token) ? 'valid' : 'stale'}\n` +
    `Idle       ${idleM}m (watchdog @${config.watchdogStuckMin}m)\n` +
    `Errors     ${stats.errors} (streak ${stats.consecutiveErrors})\n` +
    `Schedule   ${schedStatus()}\n` +
    `Memory     ${(mem.rss/1048576).toFixed(0)} MB\n` +
    `Uptime     ${fmtUptime(Date.now() - stats.startTime)}` +
    '</pre>',
  ].join('\n'));
});
tg.on('errors', () => {
  const errs = LOG_RING.filter(l => /ERR|❌|💥|⚠️|fail/i.test(l)).slice(-12);
  notify('⚠️ <b>Recent errors</b>\n<pre>' + (errs.join('\n').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) || 'none 🎉') + '</pre>');
});
tg.on('inventory', () => {
  if (!inventory.length) { notify('🎒 Inventory kosong.'); return; }
  const rows = inventory.slice(0, 30).map(i => {
    const val = (PRICE_FLOOR[i.defId] || QUICKSELL[i.defId] || 0) * i.qty;
    return `${(i.defId.replace(/^(mat_|fish_|wpn_|tool_|cos_|food_|med_|kit_|pet_|permit_)/, '')).padEnd(16).slice(0,16)} x${String(i.qty).padStart(3)}  ~${val}`;
  }).join('\n');
  notify(`🎒 <b>Inventory</b> (${inventory.length}/${CARRY_CAP})\n<pre>${rows}</pre>`);
});
tg.on('income', () => {
  const p = getProfitSummary();
  const hrs = getHourly(6).map(h => `${h.h}:00  +${fmt(h.v)}`).join('\n');
  notify([
    `💵 <b>Income</b>`,
    '<pre>' +
    `Total      ${fmt(p.totalEarned)} OTWN\n` +
    `Rate       ${fmt(p.rate)} /h\n` +
    `QuickSell  +${fmt(stats.earnedQuick)}\n` +
    `Market     +${fmt(stats.earnedMarket)}\n` +
    `PvP        +${fmt(stats.pvpEarnings)}\n` +
    `Property   +${fmt(stats.propertyEarnings)}\n` +
    `Sold       ${fmt(p.itemsSold)} items` +
    '</pre>',
    `<i>Per jam (6h):</i>\n<pre>${hrs}</pre>`,
  ].join('\n'));
});
tg.on('restart', () => { notify('♻️ Restarting process...'); setTimeout(() => process.exit(0), 800); });
tg.on('update', () => {
  notify('⬇️ Pulling latest code from git...');
  require('child_process').exec('git -C ' + __dirname + ' pull --ff-only 2>&1', (err, out) => {
    notify('<pre>' + String(out || err).slice(0, 600).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>');
    if (!err) { notify('♻️ Restarting with new code...'); setTimeout(() => process.exit(0), 1000); }
  });
});

// ============ CRASH RECOVERY ============
process.on('uncaughtException', (err) => {
  log('💥 uncaughtException: ' + (err && err.stack || err));
  notify(`💥 <b>Crash</b>: ${err && err.message || err}\nProcess will exit; systemd auto-restarts.`);
  setTimeout(() => process.exit(1), 1200); // let the notify flush, then let systemd restart
});
process.on('unhandledRejection', (reason) => {
  log('💥 unhandledRejection: ' + (reason && reason.stack || reason));
});

// ============ ANTI-DETECTION SCHEDULE ============
// Human-like online/offline pattern, e.g. SCHEDULE="on:18,off:2,on:1,off:3"
let schedulePhases = [];
let schedIdx = 0;
let schedPhaseEnd = 0;
const scheduleActive = config.scheduleEnabled;
function parseSchedule(raw) {
  return raw.split(',').map(s => {
    const [st, h] = s.split(':');
    return { state: (st || '').trim().toLowerCase() === 'off' ? 'off' : 'on', hours: parseFloat(h) || 1 };
  }).filter(p => p.hours > 0);
}
function jitterMs(hours) {
  const j = config.scheduleJitterPct / 100;
  return Math.round(hours * 3600000 * (1 + (Math.random() * 2 - 1) * j));
}
function schedUntilStr() { return new Date(schedPhaseEnd).toISOString().slice(11, 16); }
function applyPhase(announce) {
  const p = schedulePhases[schedIdx];
  if (!p) return;
  schedPhaseEnd = Date.now() + jitterMs(p.hours);
  if (p.state === 'on') {
    log(`🗓️ Schedule ON (~${p.hours}h → ~${schedUntilStr()} UTC)`);
    if (stopped) { stopped = false; startBot(); }
  } else {
    log(`🗓️ Schedule OFF (~${p.hours}h → ~${schedUntilStr()} UTC)`);
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try { if (activeSocket) activeSocket.disconnect(); } catch {}
    connected = false;
  }
  if (announce) notifySys(`🗓️ <b>Jadwal: ${p.state.toUpperCase()}</b> ~${p.hours}j (s/d ~${schedUntilStr()} UTC)`);
}
function schedStatus() {
  if (!scheduleActive || !schedulePhases.length) return 'disabled';
  const p = schedulePhases[schedIdx];
  const mins = Math.max(0, Math.round((schedPhaseEnd - Date.now()) / 60000));
  return `${p.state.toUpperCase()} · sisa ~${Math.floor(mins/60)}h ${mins%60}m`;
}
if (scheduleActive) {
  schedulePhases = parseSchedule(config.scheduleRaw);
  if (schedulePhases.length) applyPhase(false);
}
setInterval(() => {
  if (!scheduleActive || !schedulePhases.length) return;
  if (Date.now() >= schedPhaseEnd) { schedIdx = (schedIdx + 1) % schedulePhases.length; applyPhase(true); }
}, 30000);

// ============ BOOT ============
log('🚀 Starting v23 — PvP+Property+Shop+Crafting+Bank+Vehicle + Telegram + Autopilot...');
verifyPendingPatchOnBoot();
tg.startPolling();
notifySys('🚀 <b>Owntown Bot</b> menyala — menghubungkan ke game…\n<i>/help untuk daftar perintah · /dashboard untuk panel live</i>');
startBot();
