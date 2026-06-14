const io = require('socket.io-client');
const fs = require('fs');
const https = require('https');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;

// ============ CONFIG ============
const TOKEN_PATH = '/tmp/owntown_token.txt';
const WALLET_ADDR = '5zkKFMR4pmde1pjT2zzQfLuPaHoFgoch6uMcD38Xe2rV';
const WALLET_FILE = '/root/.hermes/owntown-attack-wallet.json';
const LOG = '/tmp/owntown_v23.log';
fs.writeFileSync(LOG, '');

function log(m) {
  const l = new Date().toISOString().slice(11,19) + ' | ' + m;
  fs.appendFileSync(LOG, l + '\n');
  process.stdout.write(l + '\n');
}

log('=== OWNTOWN PROFIT FARMER v23.0 ===');
log('FULL FEATURED: PvP + Property + Shop + Crafting + Bank + Vehicle + Smart Sell');

// ============ CONSTANTS ============
const WALK_SPEED = 0.4;
const MAX_WALK_STEPS = 5000;
const DAILY_EARN_CAP = 5000;
const CARRY_CAP = 56;
const MARKET_INTERVAL = 3500;
const LOW_DURABILITY = 30;
const MY_PLAYER_ID = '39ebfc6a-5d20-4ef7-931b-83501d40adbf';
const FISHING_TIMEOUT = 120000;
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
  arena: {x:-120, z:-80},
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
  listed:0,canceled:0,crafted:0,repaired:0,errors:0,
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
function apiRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({
      hostname: 'owntown.fun', path, method, headers
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function apiGet(path, token) { return apiRequest('GET', path, null, token); }
async function apiPost(path, body, token) { return apiRequest('POST', path, body, token); }

// ============ AUTH ============
async function authenticate() {
  const wallet = JSON.parse(fs.readFileSync(WALLET_FILE));
  const secretKey = bs58.decode(wallet.private_key);
  const challenge = await apiPost('/api/auth/challenge', { wallet: WALLET_ADDR });
  const nonce = challenge.data.nonce || challenge.data.challenge;
  const message = challenge.data.message || ('owntown_auth:' + nonce);
  const sig = nacl.sign.detached(Buffer.from(message), secretKey);
  const result = await apiPost('/api/auth/verify', { wallet: WALLET_ADDR, nonce, signature: bs58.encode(sig) });
  if (!result.data.token) throw new Error('Auth failed: ' + JSON.stringify(result.data));
  fs.writeFileSync(TOKEN_PATH, result.data.token);
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

function recordSale(defId, qty, method, price) {
  const total = price * qty;
  stats.totalRevenue += total;
  stats.totalItemsSold += qty;
  if(method === 'quickSell') { stats.soldQuick += qty; stats.earnedQuick += total; }
  else { stats.soldMarket += qty; stats.earnedMarket += total; }
  log(`💰 ${method==='quickSell'?'QS':'MKT'} ${defId} x${qty} @${price} = ${total} OTWN`);
}

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
      sock.emit('shop:foodBuy', { defId: 'food_ember_skewer', qty: Math.min(5, Math.floor(balance / 10)) });
      stats.itemsBought++;
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
  }
}

// ============ MARKET FLIP (v23.1: FIXED!) ============
let lastFlipTime = 0;
const FLIP_COOLDOWN = 60000;
const FLIP_MAX_COST = 200;
const FLIP_MIN_PROFIT = 50;

function checkFlipOpportunities(sock, listings) {
  if(Date.now() - lastFlipTime < FLIP_COOLDOWN) return false;
  let bestFlip = null, bestProfit = 0;
  for(const l of listings) {
    if(l.sellerPlayerId === MY_PLAYER_ID || l.status !== 'active') continue;
    if(!l.qty || l.qty < 1) continue;
    const marketPrice = marketPrices[l.defId];
    if(!marketPrice || marketPrice < 5) continue;
    const ppu = l.price / l.qty;
    const listingFee = Math.max(5, Math.round(l.price * 0.05));
    const resaleRevenue = Math.round(marketPrice * l.qty * 0.92);
    const totalCost = l.price + listingFee;
    const profit = resaleRevenue - totalCost;
    if(ppu < marketPrice * 0.4 && l.price <= FLIP_MAX_COST && profit >= FLIP_MIN_PROFIT && balance >= totalCost) {
      if(profit > bestProfit) { bestProfit = profit; bestFlip = { listing: l, ppu, marketPrice, profit, totalCost }; }
    }
  }
  if(bestFlip) {
    const l = bestFlip.listing;
    log(`🔄 FLIP: ${l.defId} x${l.qty} @${l.price} (ppu:${bestFlip.ppu.toFixed(1)} mkt:${bestFlip.marketPrice} profit:${bestFlip.profit})`);
    sock.emit('marketplace:buy', { listingId: l.id });
    stats.itemsBought++;
    lastFlipTime = Date.now();
    return true;
  }
  return false;
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
          log(`💰 sellAll ${safeQS.length} safe QS items...`);
          sock.emit('marketplace:sellAll');
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
    if(safeQS.length > 0) { log(`💰 sellAll ${safeQS.length} safe items...`); sock.emit('marketplace:sellAll'); }
    setTimeout(() => { log(`💰 Done: QS +${stats.earnedQuick}`); cb(); }, 3000);
  }
  else if(toHold.length > 0) { log(`⏸️ All ${toHold.length} stacks on HOLD`); cb(); }
  else { log('💰 Nothing sellable'); cb(); }
}

// ============ ACTIONS (v23: ENHANCED) ============
function doActions(sock, type) {
  if(!connected) return;
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
  if(stats.consecutiveErrors >= 10) {
    log(`⚠️ ${stats.consecutiveErrors} err — reconnect`);
    sock.disconnect();
    setTimeout(startBot, 5000);
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

  // Skip sell phase (disabled)
  if(type === 'sell') {
    stats.cycles++;
    // But do check bank and economy during sell skip
    checkLedger(sock);
    setTimeout(() => runNextCycle(sock), 1000);
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
async function startBot() {
  inventoryReady = false;
  if(!token || isTokenExpired(token)) {
    try { token = await authenticate(); } catch(e) {
      log('❌ Auth failed: ' + e.message);
      setTimeout(startBot, 30000);
      return;
    }
  }

  const socket = io('https://owntown.fun', { auth: { token }, transports: ['websocket'] });

  // === PLAYER STATE ===
  socket.on('player:correction', (d) => { if(d.pos) { pos.x = d.pos.x; pos.z = d.pos.z; } });
  socket.on('player:state', (d) => {
    if(d.zone) zone = d.zone;
    if(d.gameBalance !== undefined) balance = d.gameBalance;
    if(d.level !== undefined) level = d.level;
    if(d.stamina !== undefined) stamina = d.stamina;
    if(d.dailyEarnedOtwn !== undefined) dailyEarned = d.dailyEarnedOtwn;
    if(d.hp !== undefined) hp = d.hp;
    if(d.maxHp !== undefined) maxHp = d.maxHp;
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
  });

  // === MARKETPLACE ===
  socket.on('marketplace:update', (d) => {
    if(d.listings) {
      myActiveListings = d.listings.filter(l => l.sellerPlayerId === MY_PLAYER_ID && l.status === 'active');
      scanMarketPrices(d.listings);
      // v23: Check flip opportunities
      checkFlipOpportunities(socket, d.listings);
    }
  });

  // === MINING ===
  socket.on('mining:result', (d) => {
    stats.mined++; stats.xp += d.xpGained || 0; stats.items += d.qty || 0; stats.consecutiveErrors = 0;
    if(d.fatigueMultiplier !== undefined) fatigueMultiplier = d.fatigueMultiplier;
    if(d.fatigueMultiplier < 0.95) stats.fatigueDrops++;
    const sp = getSellDecision(d.defId, d.qty);
    log(`⛏ ${d.itemName} x${d.qty} +${d.xpGained}XP STA:${Math.round(d.stamina||0)} ${d.fatigueMultiplier<0.95?'⚠️fatigue':''} → ${sp.action}${sp.price?'@'+sp.price:''}`);
  });
  socket.on('mining:error', (d) => {
    stats.errors++; stats.consecutiveErrors++;
    if(d.code !== 'COOLDOWN') log(`⛏ ERR:${d.code}`);
  });

  // === FISHING ===
  socket.on('fishing:cast', (d) => { fishingActive = true; log(`🎣 Wait ${Math.round(d.waitMs/1000)}s`); });
  socket.on('fishing:result', (d) => {
    fishingActive = false; stats.fished++; stats.xp += d.xp || d.xpGained || 0; stats.items += d.qty || 1; stats.consecutiveErrors = 0;
    const sp = getSellDecision(d.defId || 'fish', d.qty || 1);
    log(`🎣 ${d.itemName||d.defId||'fish'} x${d.qty||1} +${d.xp||d.xpGained||0}XP → ${sp.action}${sp.price?'@'+sp.price:''}${sp.reason?' ('+sp.reason+')':''}`);
  });
  socket.on('fishing:error', (d) => { fishingActive = false; stats.errors++; stats.consecutiveErrors++; log(`🎣 ERR:${d.code}`); });

  // === COMBAT ===
  socket.on('combat:result', (d) => {
    stats.fought++; stats.xp += d.xpGained || 0; stats.consecutiveErrors = 0;
    if(d.playerHp !== undefined) hp = d.playerHp;
    if(d.counterDamage > 0) log(`⚔ HIT:${d.damage} HP:${d.monsterHp} MY_HP:${hp} COUNTER:${d.counterDamage}`);
    if(d.killed) { stats.kills++; log(`⚔ KILL! +${d.xpGained}XP`); }
  });
  socket.on('combat:error', (d) => {
    stats.errors++; stats.consecutiveErrors++;
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
      if(d.earnings) stats.propertyEarnings += d.earnings;
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
      if(msg.includes('sold') || msg.includes('received')) {
        const m = d.message.match(/(\d[\d,]*)\s*\$?OTWN/);
        if(m) {
          const amount = parseInt(m[1].replace(/,/g, ''));
          if(amount > 0) recordSale('toast-sale', 1, 'marketplace', amount);
        }
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
  let disconnectTimer = null;
  socket.on('connect', () => {
    connected = true;
    if(disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    log('Connected!');
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

  socket.on('disconnect', () => {
    log('Disconnected!');
    connected = false;
    disconnectTimer = setTimeout(() => { log('⚠️ Reconnecting...'); startBot(); }, 30000);
  });

  socket.on('connect_error', (err) => {
    if(err.message === 'BAD_TOKEN' || err.message === 'NO_TOKEN') {
      log('🔑 Token invalid, re-authenticating...');
      token = null;
      socket.disconnect();
      setTimeout(startBot, 2000);
    }
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

// ============ STATUS REPORT (10 min) ============
setInterval(() => {
  const p = getProfitSummary();
  const fishItems = inventory.filter(i => i.defId.startsWith('fish_'));
  const matItems = inventory.filter(i => i.defId.startsWith('mat_'));
  const fishValue = fishItems.reduce((s,i) => s + (PRICE_FLOOR[i.defId]||1) * i.qty, 0);
  const matValue = matItems.reduce((s,i) => s + (PRICE_FLOOR[i.defId]||1) * i.qty, 0);

  log(`\n📊 ══ [${p.hours}h] PROFIT REPORT v23 ══`);
  log(`⛏${stats.mined} 🎣${stats.fished} ⚔${stats.kills} | Lv${level} XP${stats.xp}`);
  log(`💰 QS:+${stats.earnedQuick} MKT:+${stats.earnedMarket} PvP:+${stats.pvpEarnings} Total:${p.totalEarned}`);
  log(`💵 Rate: ${p.rate}/h | Sold: ${p.itemsSold} items`);
  log(`📦 ${inventory.length}/${CARRY_CAP} stacks`);
  log(`🐟 Fish: ${fishItems.length} (~${fishValue}) | 🧱 Mats: ${matItems.length} (~${matValue})`);
  log(`⏸️ Held: ${stats.holdCount} (~${stats.holdValue})`);
  log(`💰 Bal:${balance.toFixed(2)} | Daily:${dailyEarned}/${DAILY_EARN_CAP}`);
  log(`❤️ HP:${hp}/${maxHp} | STA:${stamina}`);
  log(`⚔️ PvP: ${stats.pvpFights}f ${stats.pvpWins}w ${stats.pvpClaims}c +${stats.pvpEarnings}`);
  log(`🏠 Prop: ${stats.propertyBought}b ${stats.propertySold}s +${stats.propertyEarnings}`);
  log(`🏦 Bank: bal:${stats.bankBalance} dep:${stats.bankDeposits} wd:${stats.bankWithdrawals}`);
  log(`👹 Boss:${stats.bossClaims} | 🔨 Craft:${stats.crafted} | 🍖 Food:${stats.foodEaten} | 🏥 Heal:${stats.clinicHeals}`);
  log(`🛒 Flip: ${stats.itemsFlipped} (+${stats.flipProfit}) | 🔔 Notif:${stats.notifications}`);
  log(`🔧 Zone:${stats.wrongZone} FishTO:${stats.fishingTimeouts} Fatigue:${stats.fatigueDrops} Rests:${stats.restCount}`);
  log(`📍 Node:${MINING_NODES[stats.currentNodeIdx%MINING_NODES.length].id} | Mon:${MONSTERS[stats.currentMonsterIdx%MONSTERS.length].id}`);
  const priceLog = Object.entries(marketPrices).filter(([k])=>PRICE_FLOOR[k]).map(([k,v])=>{const t=getPriceTrend(k);const icon=t==='rising'?'📈':t==='falling'?'📉':'➡️';return `${k.replace('mat_','').replace('fish_','')}:${v}${icon}`;}).join(' ');
  log(`📈 Market: ${priceLog}`);
  log(`══════════════════\n`);
}, 600000);

log('🚀 Starting v23 — Full Featured: PvP + Property + Shop + Crafting + Bank + Vehicle + Smart Sell...');
startBot();
