// ============================================================================
// OWNTOWN FARMER v1.0
// Automated farming bot for Owntown.fun (Solana MMO)
// GitHub: https://github.com/ulsreall/ometown-farmer
// ============================================================================

const io = require('socket.io-client');
const fs = require('fs');
const https = require('https');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;

// ============================================================================
// CONFIGURATION
// ============================================================================

// Load wallet from file or env
function loadWallet() {
  // Try wallet file first (recommended)
  const walletPath = process.env.WALLET_FILE || './wallet.json';
  if (fs.existsSync(walletPath)) {
    const w = JSON.parse(fs.readFileSync(walletPath));
    return {
      address: w.address || process.env.WALLET_ADDRESS,
      privateKey: w.private_key || w.privateKey || process.env.WALLET_PRIVATE_KEY
    };
  }
  // Fallback to env vars
  return {
    address: process.env.WALLET_ADDRESS,
    privateKey: process.env.WALLET_PRIVATE_KEY
  };
}

const WALLET = loadWallet();
const TOKEN_PATH = '/tmp/owntown_token.txt';
const LOG_FILE = '/tmp/owntown_farmer.log';

// Walk & timing
const WALK_SPEED = 0.4;          // m/s — realistic speed to avoid anti-cheat
const MAX_WALK_STEPS = 5000;     // max steps per waypoint
const FISHING_TIMEOUT = 25000;   // ms to wait for fish
const DAILY_EARN_CAP = 5000;     // daily earning cap (server-side)
const CARRY_CAP = 56;            // inventory stack limit
const MARKET_INTERVAL = 3500;    // ms between marketplace listings
const LOW_DURABILITY = 30;       // repair tool below this
const LOW_STAMINA = 25;          // eat food below this stamina
const STATUS_INTERVAL = 600000;  // status report every 10 min

// ============================================================================
// LOGGING
// ============================================================================

fs.writeFileSync(LOG_FILE, '');
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${ts} | ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

// ============================================================================
// AUTHENTICATION (REST API Challenge-Response)
// ============================================================================

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'owntown.fun', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d)); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function authenticate() {
  const secretKey = bs58.decode(WALLET.privateKey);
  const challenge = await apiPost('/api/auth/challenge', { wallet: WALLET.address });
  const nonce = challenge.nonce || challenge.challenge;
  const message = challenge.message || ('owntown_auth:' + nonce);
  const sig = nacl.sign.detached(Buffer.from(message), secretKey);
  const result = await apiPost('/api/auth/verify', {
    wallet: WALLET.address, nonce, signature: bs58.encode(sig)
  });
  if (!result.token) throw new Error('Auth failed: ' + JSON.stringify(result));
  fs.writeFileSync(TOKEN_PATH, result.token);
  const exp = new Date(JSON.parse(Buffer.from(result.token.split('.')[1], 'base64')).exp * 1000);
  log(`🔑 Authenticated! Token expires: ${exp.toISOString()}`);
  return result.token;
}

function getToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf-8').trim(); } catch { return null; }
}

function isTokenExpired(tok) {
  try {
    const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64'));
    return Date.now() >= (payload.exp * 1000 - 60000); // refresh 1 min before expiry
  } catch { return true; }
}

// ============================================================================
// GAME DATA
// ============================================================================

// QuickSell prices (instant sell to terminal)
const QUICKSELL = {
  mat_iron_shard: 2, mat_raw_resonite: 6, mat_circuit_scrap: 6,
  mat_carbon_fiber: 2, mat_resonance_core: 10000,
  fish_silver_darter: 4, fish_sun_carp: 50, fish_moon_koi: 12,
  food_ember_skewer: 8, food_volt_noodles: 15,
  kit_repair: 5, med_patch: 5, food_mre: 3
};

// Minimum prices for marketplace listings
const PRICE_FLOOR = {
  mat_iron_shard: 2, mat_raw_resonite: 9, mat_circuit_scrap: 63,
  mat_carbon_fiber: 2, mat_resonance_core: 500000,
  fish_silver_darter: 57, fish_sun_carp: 5000, fish_moon_koi: 1000,
  food_ember_skewer: 100, kit_repair: 100, med_patch: 100
};

// Items to never sell
const KEEP = new Set([
  'tool_pulse_pick', 'gear_tide_helm', 'gear_reef_plate', 'gear_dune_boots',
  'pet_demon_salamander', 'wpn_tide_sidearm', 'cos_fault_visor',
  'vehicle_hoverboard', 'permit_redline'
]);

// Safe items for quickSell (low value, high volume)
const SAFE_QUICKSELL = new Set([
  'mat_iron_shard', 'mat_raw_resonite', 'mat_carbon_fiber',
  'kit_repair', 'med_patch', 'food_mre', 'food_ember_skewer'
]);

// Mining nodes (8 nodes across zones)
const MINING_NODES = [
  { id: 'node_dw_1', pos: { x: 75, z: -95 } },
  { id: 'node_dw_2', pos: { x: 100, z: -95 } },
  { id: 'node_dw_3', pos: { x: 120, z: -80 } },
  { id: 'node_dw_4', pos: { x: 120, z: -60 } },
  { id: 'node_dw_5', pos: { x: 100, z: -50 } },
  { id: 'node_dw_6', pos: { x: 80, z: -50 } },
  { id: 'node_rim_1', pos: { x: -30, z: -90 } },
  { id: 'node_rim_2', pos: { x: -50, z: -110 } }
];

// Monsters (skip mon_7 = anomaly_warden, LEVEL_TOO_LOW at Lv11)
const MONSTERS = [
  { id: 'mon_1', pos: { x: -100, z: -120 } },
  { id: 'mon_2', pos: { x: -80, z: -100 } },
  { id: 'mon_3', pos: { x: -120, z: -100 } },
  { id: 'mon_4', pos: { x: -100, z: -140 } },
  { id: 'mon_5', pos: { x: -120, z: -130 } },
  { id: 'mon_6', pos: { x: -80, z: -130 } },
  { id: 'mon_8', pos: { x: -100, z: -160 } }
];

// Fishing waypoints (walk through spawn_plaza → residential → pond)
// Last point = fish_dock spot (-148.5, 0)
const WAYPOINTS_BASE = {
  fishing: [{ x: 0, z: 0 }, { x: -80, z: 0 }, { x: -148.5, z: 0 }]
};

// ============================================================================
// STATE
// ============================================================================

let token = getToken();
let inventory = [], inventoryReady = false, connected = false;
let balance = 0, level = 1, stamina = 100, dailyEarned = 0;
let zone = '', fishingActive = false, fatigueMultiplier = 1;
let myActiveListings = [], marketPrices = {};

const pos = { x: 0, z: 0 };

const stats = {
  cycles: 1, mined: 0, fished: 0, fought: 0, kills: 0,
  items: 0, xp: 0, errors: 0, consecutiveErrors: 0,
  soldQuick: 0, soldMarket: 0, earnedQuick: 0, earnedMarket: 0,
  totalItemsSold: 0, holdCount: 0, holdValue: 0,
  canceled: 0, listed: 0, crafted: 0, repaired: 0, fed: 0,
  fatigueDrops: 0, bossClaims: 0, worldBossActive: false,
  currentMonsterIdx: 0, currentNodeIdx: 0,
  reconnects: 0, startTime: Date.now()
};

// ============================================================================
// MARKET PRICES
// ============================================================================

function scanMarketPrices(listings) {
  const byDefId = {};
  for (const l of listings) {
    if (l.status !== 'active') continue;
    if (!byDefId[l.defId]) byDefId[l.defId] = [];
    byDefId[l.defId].push(l.price);
  }
  for (const [defId, prices] of Object.entries(byDefId)) {
    marketPrices[defId] = { best: Math.min(...prices), count: prices.length };
  }
}

function getSellDecision(defId, qty) {
  if (KEEP.has(defId)) return { action: 'HOLD', reason: 'equipped/keep' };
  const mktPrice = marketPrices[defId]?.best || PRICE_FLOOR[defId] || 0;
  const mktCount = marketPrices[defId]?.count || 0;
  const floor = PRICE_FLOOR[defId] || QUICKSELL[defId] || 1;
  const undercut = Math.max(floor, Math.floor(mktPrice * 0.9));

  // No market data → quickSell
  if (!mktPrice || mktPrice <= 1) return { action: 'QUICKSELL', price: QUICKSELL[defId] || 1 };

  // Only list on market if reasonable volume
  if (SAFE_QUICKSELL.has(defId)) {
    if (mktPrice > floor * 1.5 && mktCount < 20) {
      return { action: 'MARKETPLACE', price: undercut, marketBest: mktPrice, depth: mktCount, trend: 'stable' };
    }
    return { action: 'QUICKSELL', price: QUICKSELL[defId] || 1 };
  }

  return { action: 'MARKETPLACE', price: undercut, marketBest: mktPrice, depth: mktCount, trend: 'stable' };
}

// ============================================================================
// PROFIT TRACKING
// ============================================================================

function recordSale(defId, qty, method, price) {
  const total = price * qty;
  if (method === 'quickSell') { stats.soldQuick += qty; stats.earnedQuick += total; }
  else { stats.soldMarket += qty; stats.earnedMarket += total; }
  stats.totalItemsSold += qty;
  log(`💰 ${method === 'quickSell' ? 'QS' : 'MKT'} ${defId} x${qty} @${price} = ${total} OTWN`);
}

function getProfitSummary() {
  const hours = (Date.now() - stats.startTime) / 3600000;
  const totalEarned = stats.earnedQuick + stats.earnedMarket;
  const rate = hours > 0 ? Math.round(totalEarned / hours) : 0;
  const heldValue = stats.holdValue;
  return { totalEarned, rate, heldValue, qsEarned: stats.earnedQuick, mktEarned: stats.earnedMarket, itemsSold: stats.totalItemsSold, holdCount: stats.holdCount, hours: hours.toFixed(1) };
}

// ============================================================================
// HELPERS
// ============================================================================

function getCombatWaypoints() {
  const mon = MONSTERS[stats.currentMonsterIdx % MONSTERS.length];
  return [{ x: 0, z: 0 }, { x: -80, z: 0 }, { x: mon.pos.x, z: mon.pos.z }];
}

function getMiningWaypoints() {
  const node = MINING_NODES[stats.currentNodeIdx % MINING_NODES.length];
  return [{ x: 0, z: 0 }, { x: node.pos.x, z: node.pos.z }];
}

function tryEatFood(sock) {
  const food = inventory.find(i => i.defId.startsWith('food_') && i.qty > 0);
  if (food) {
    sock.emit('inventory:use', { instanceId: food.instanceId });
    stats.fed++;
    log(`🍖 Eating ${food.defId}`);
  }
}

function tryCraft(sock) {
  const resonite = inventory.find(i => i.defId === 'mat_raw_resonite' && i.qty >= 10);
  const scrap = inventory.find(i => i.defId === 'mat_circuit_scrap' && i.qty >= 5);
  const core = inventory.find(i => i.defId === 'mat_resonance_core' && i.qty >= 1);
  if (resonite && scrap && core && balance >= 25) {
    sock.emit('inventory:craft', { recipeId: 'craft_rail_lance' });
    stats.crafted++;
    log(`🔨 Crafted Rail Lance (fee: 25 OTWN)`);
    return true;
  }
  const iron = inventory.find(i => i.defId === 'mat_iron_shard' && i.qty >= 2);
  const carbon = inventory.find(i => i.defId === 'mat_carbon_fiber' && i.qty >= 1);
  if (iron && carbon && balance >= 5) {
    sock.emit('inventory:craft', { recipeId: 'craft_repair_kit' });
    stats.crafted++;
    log(`🔨 Crafted Repair Kit (fee: 5 OTWN)`);
    return true;
  }
  return false;
}

// ============================================================================
// MAIN BOT
// ============================================================================

async function startBot() {
  inventoryReady = false;

  // Auto-refresh token if expired
  if (!token || isTokenExpired(token)) {
    try { token = await authenticate(); } catch (e) {
      log(`❌ Auth failed: ${e.message}`);
      setTimeout(startBot, 30000);
      return;
    }
  }

  const socket = io('https://owntown.fun', { auth: { token }, transports: ['websocket'] });

  // ──── Player state ────
  socket.on('player:correction', (d) => { if (d.pos) { pos.x = d.pos.x; pos.z = d.pos.z; } });
  socket.on('player:state', (d) => {
    if (d.zone) zone = d.zone;
    if (d.gameBalance !== undefined) balance = d.gameBalance;
    if (d.level !== undefined) level = d.level;
    if (d.stamina !== undefined) stamina = d.stamina;
    if (d.dailyEarnedOtwn !== undefined) dailyEarned = d.dailyEarnedOtwn;
  });

  // ──── Inventory ────
  socket.on('inventory:update', (d) => {
    inventory = (d.items || []).filter(i => i.qty > 0);
    if (!inventoryReady) { inventoryReady = true; log(`📦 ${inventory.length} stacks`); }
    const tool = d.items.find(i => i.defId === 'tool_pulse_pick');
    if (tool && tool.durability !== null && tool.durability < LOW_DURABILITY && tool.instanceId) {
      log(`🔧 Repair dur:${tool.durability}`);
      socket.emit('inventory:repair', { instanceId: tool.instanceId });
      stats.repaired++;
    }
  });

  // ──── Marketplace ────
  socket.on('marketplace:update', (d) => {
    if (d.listings) {
      myActiveListings = d.listings.filter(l => l.sellerPlayerId === WALLET.address && l.status === 'active');
      scanMarketPrices(d.listings);
    }
  });

  socket.on('marketplace:result', (d) => {
    if (d.ok) {
      if (d.action === 'cancel') { stats.canceled++; log(`✅ Canceled`); }
      else if (d.credited) {
        const defId = d.defId || d.itemId || 'sell';
        const qty = d.count || d.qty || 1;
        recordSale(defId, qty, 'quickSell', d.credited);
      }
    } else log(`💰 Fail: ${d.code || d.message}`);
  });

  socket.on('marketplace:quickSell:result', (d) => {
    if (d.credited) {
      recordSale(d.defId || d.itemId || 'qs', d.count || d.qty || 1, 'quickSell', d.credited);
    }
  });

  ['marketplace:list:result', 'marketplace:listed'].forEach(evt => {
    socket.on(evt, (d) => { stats.listed++; log(`📋 Listed!`); });
  });

  socket.on('marketplace:sellAll:result', (d) => {
    if (d.credited) recordSale('sellAll-bulk', d.count || d.items || 1, 'quickSell', d.credited);
  });

  // ──── Mining ────
  socket.on('mining:result', (d) => {
    stats.mined++; stats.xp += d.xpGained || 0; stats.items += d.qty || 0; stats.consecutiveErrors = 0;
    if (d.fatigueMultiplier !== undefined) fatigueMultiplier = d.fatigueMultiplier;
    if (d.fatigueMultiplier < 0.95) stats.fatigueDrops++;
    const sp = getSellDecision(d.defId, d.qty);
    log(`⛏ ${d.itemName} x${d.qty} +${d.xpGained}XP STA:${Math.round(d.stamina || 0)} ${d.fatigueMultiplier < 0.95 ? '⚠️fatigue' : ''} → ${sp.action}${sp.price ? '@' + sp.price : ''}`);
  });
  socket.on('mining:error', (d) => { stats.errors++; stats.consecutiveErrors++; if (d.code !== 'COOLDOWN') log(`⛏ ERR:${d.code}`); });

  // ──── Fishing ────
  socket.on('fishing:cast', (d) => { fishingActive = true; log(`🎣 Wait ${Math.round(d.waitMs / 1000)}s`); });
  socket.on('fishing:result', (d) => {
    fishingActive = false; stats.fished++; stats.xp += d.xp || d.xpGained || 0; stats.items += d.qty || 1; stats.consecutiveErrors = 0;
    const sp = getSellDecision(d.defId || 'fish', d.qty || 1);
    log(`🎣 ${d.itemName || d.defId || 'fish'} x${d.qty || 1} +${d.xp || d.xpGained || 0}XP → ${sp.action}${sp.price ? '@' + sp.price : ''}`);
  });
  socket.on('fishing:error', (d) => { fishingActive = false; stats.errors++; stats.consecutiveErrors++; log(`🎣 ERR:${d.code}`); });

  // ──── Combat ────
  socket.on('combat:result', (d) => {
    stats.fought++; stats.xp += d.xpGained || 0; stats.consecutiveErrors = 0;
    if (d.counterDamage > 0) log(`⚔ HIT:${d.damage} HP:${d.monsterHp} COUNTER:${d.counterDamage}`);
    if (d.killed) { stats.kills++; log(`⚔ KILL! +${d.xpGained}XP`); }
  });
  socket.on('combat:error', (d) => {
    stats.errors++; stats.consecutiveErrors++;
    if (d.code === 'NO_TARGET') {
      stats.currentMonsterIdx = (stats.currentMonsterIdx + 1) % MONSTERS.length;
    } else if (d.code !== 'COOLDOWN') log(`⚔ ERR:${d.code}`);
  });
  socket.on('combat:drop', (d) => { stats.items++; log(`⚔ DROP: ${d.itemName} x${d.qty}`); });

  // ──── World Boss ────
  socket.on('worldboss:state', (d) => {
    if (d.phase === 'active' && !stats.worldBossActive) {
      stats.worldBossActive = true;
      log(`👹 WORLD BOSS ACTIVE! Entering...`);
      socket.emit('worldboss:enter');
    }
  });
  socket.on('worldboss:result', (d) => {
    if (d.claimed) { stats.bossClaims++; log(`🏆 WORLD BOSS CLAIMED! Rank #${d.rank}`); }
  });

  // ──── Craft & Repair ────
  socket.on('inventory:craft', (d) => { stats.crafted++; log(`🔨 Crafted!`); });
  socket.on('inventory:repair', (d) => { log('🔧 Repaired!'); });

  // ──── Toast (track sales from notifications) ────
  socket.on('toast', (d) => {
    if (d.kind === 'success') {
      const msg = (d.message || '').toLowerCase();
      if (msg.includes('sold') || msg.includes('received')) {
        const m = d.message.match(/(\d[\d,]*)\s*\$?OTWN/);
        if (m) {
          const amount = parseInt(m[1].replace(/,/g, ''));
          if (amount > 0) recordSale('toast-sale', 1, 'marketplace', amount);
        }
      }
    }
  });

  // ──── Walk helper ────
  function walkStaged(sock, wps, idx, cb) {
    if (!connected) return;
    if (idx >= wps.length) { cb(); return; }
    const wp = wps[idx];
    let step = 0;
    log(`  WP${idx + 1}/${wps.length}:(${wp.x},${wp.z}) from(${pos.x.toFixed(1)},${pos.z.toFixed(1)})`);
    const iv = setInterval(() => {
      if (!connected) { clearInterval(iv); return; }
      const dx = wp.x - pos.x, dz = wp.z - pos.z, dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 2 || step >= MAX_WALK_STEPS) {
        clearInterval(iv);
        if (step > 0) log(`  Arrived WP${idx + 1} zone:${zone} steps:${step}`);
        for (let i = 0; i < 5; i++) sock.emit('player:input', { pos: { x: wp.x, y: 0, z: wp.z }, rotY: 0, anim: 'idle' });
        setTimeout(() => walkStaged(sock, wps, idx + 1, cb), 1000);
        return;
      }
      pos.x += (dx / dist) * WALK_SPEED;
      pos.z += (dz / dist) * WALK_SPEED;
      sock.emit('player:input', { pos: { x: pos.x, y: 0, z: pos.z }, rotY: Math.atan2(dx, dz), anim: 'walk' });
      step++;
    }, 100);
  }

  // ──── Mining ────
  function doMining(sock, cb) {
    const waypoints = getMiningWaypoints();
    walkStaged(sock, waypoints, 0, () => {
      let count = 0;
      const maxMining = 15;
      const node = MINING_NODES[stats.currentNodeIdx % MINING_NODES.length];
      log(`Start mining (max ${maxMining}) zone:${zone} node:${node.id}`);
      const iv = setInterval(() => {
        if (!connected || count >= maxMining) {
          clearInterval(iv);
          stats.currentNodeIdx++;
          setTimeout(cb, 1000);
          return;
        }
        sock.emit('mining:start', { nodeId: node.id });
        count++;
      }, 3500);
    });
  }

  // ──── Fishing ────
  function doFishing(sock, cb) {
    const waypoints = WAYPOINTS_BASE.fishing;
    walkStaged(sock, waypoints, 0, () => {
      let count = 0;
      const maxFish = 5;
      let timeoutCount = 0;
      log(`Start fishing (max ${maxFish}) zone:${zone}`);
      const castInterval = setInterval(() => {
        if (!connected || count >= maxFish) {
          clearInterval(castInterval);
          setTimeout(cb, 1000);
          return;
        }
        if (!fishingActive) {
          sock.emit('fishing:cast', { spotId: 'fish_dock' });
          const waitTimeout = setTimeout(() => {
            if (fishingActive) {
              fishingActive = false;
              timeoutCount++;
              log(`🎣 Timeout (${timeoutCount})`);
              if (timeoutCount >= 3) {
                clearInterval(castInterval);
                setTimeout(cb, 1000);
              }
            }
          }, FISHING_TIMEOUT);
          count++;
        }
      }, 2500);
    });
  }

  // ──── Combat ────
  function doCombat(sock, cb) {
    const waypoints = getCombatWaypoints();
    walkStaged(sock, waypoints, 0, () => {
      let count = 0;
      const maxCombat = 5;
      const mon = MONSTERS[stats.currentMonsterIdx % MONSTERS.length];
      log(`Start combat (max ${maxCombat}) zone:${zone} mon:${mon.id}`);
      const iv = setInterval(() => {
        if (!connected || count >= maxCombat) {
          clearInterval(iv);
          setTimeout(cb, 1000);
          return;
        }
        sock.emit('combat:attack', { monsterId: mon.id });
        count++;
      }, 3000);
    });
  }

  // ──── Sell phase ────
  function doSellPhase(cb) {
    if (dailyEarned >= DAILY_EARN_CAP) log(`⚠️ Over cap ${dailyEarned}/${DAILY_EARN_CAP} — still attempting sales`);
    if (inventory.length === 0) { log('💰 Empty'); cb(); return; }

    tryCraft(socket);

    let totalValue = 0;
    for (const item of inventory) {
      const floor = PRICE_FLOOR[item.defId] || QUICKSELL[item.defId] || 1;
      totalValue += floor * item.qty;
    }
    log(`💰 SELL — ${inventory.length} stacks (value: ~${totalValue} OTWN), daily ${dailyEarned}/${DAILY_EARN_CAP}`);

    const oldListings = [...myActiveListings];
    function cancelNext(idx) {
      if (idx >= oldListings.length) { freshSell(socket, cb); return; }
      socket.emit('marketplace:cancel', { listingId: oldListings[idx].id });
      log(`🔄 Cancel: ${oldListings[idx].defId} @${oldListings[idx].price}`);
      stats.canceled++;
      setTimeout(() => cancelNext(idx + 1), 1500);
    }
    if (oldListings.length > 0) { log(`🔄 Cancel ${oldListings.length} old listings...`); cancelNext(0); }
    else freshSell(socket, cb);
  }

  function freshSell(sock, cb) {
    const toMarket = [], toQuickSell = [], toHold = [];

    for (const item of inventory) {
      if (KEEP.has(item.defId) || item.qty < 1 || item.status === 'locked') continue;
      const decision = getSellDecision(item.defId, item.qty);
      if (decision.action === 'HOLD') {
        toHold.push({ defId: item.defId, qty: item.qty, reason: decision.reason });
        stats.holdCount++;
        stats.holdValue += (decision.floor || 1) * item.qty;
      } else if (decision.action === 'MARKETPLACE') {
        toMarket.push({
          instanceId: item.instanceId, defId: item.defId, qty: item.qty,
          price: decision.price, marketBest: decision.marketBest,
          depth: decision.depth, trend: decision.trend
        });
      } else {
        toQuickSell.push({ instanceId: item.instanceId, defId: item.defId, qty: item.qty });
      }
    }

    toMarket.sort((a, b) => b.price - a.price);

    function listNext(idx) {
      if (idx >= toMarket.length || !connected) {
        if (toQuickSell.length > 0) {
          const safeQS = toQuickSell.filter(i => SAFE_QUICKSELL.has(i.defId));
          if (safeQS.length > 0) {
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

    if (toMarket.length > 0) { log(`📋 Listing ${toMarket.length} items...`); listNext(0); }
    else if (toQuickSell.length > 0) {
      const safeQS = toQuickSell.filter(i => SAFE_QUICKSELL.has(i.defId));
      if (safeQS.length > 0) { log(`💰 sellAll ${safeQS.length} safe items...`); sock.emit('marketplace:sellAll'); }
      setTimeout(() => { log(`💰 Done: QS +${stats.earnedQuick}`); cb(); }, 3000);
    }
    else if (toHold.length > 0) { log(`⏸️ All ${toHold.length} stacks on HOLD`); cb(); }
    else { log('💰 Nothing sellable'); cb(); }
  }

  // ──── Cycle ────
  function runNextCycle(sock) {
    if (!connected) return;
    if (stats.consecutiveErrors >= 10) {
      log(`⚠️ ${stats.consecutiveErrors} err — reconnect`);
      sock.disconnect();
      setTimeout(startBot, 5000);
      return;
    }

    if (stamina < LOW_STAMINA) {
      log(`⚠️ Stamina ${stamina} < ${LOW_STAMINA} — eating food`);
      tryEatFood(sock);
    }

    const order = ['sell', 'mining', 'fishing', 'combat'];
    const type = order[(stats.cycles - 1) % order.length];

    // Skip sell phase (auto-list disabled by default)
    if (type === 'sell') { stats.cycles++; setTimeout(() => runNextCycle(sock), 1000); return; }

    log(`\n=== Cycle ${stats.cycles}: ${type.toUpperCase()} ===`);

    if (type === 'mining') {
      doMining(sock, () => {
        stats.cycles++;
        log(`📊 mining:⛏${stats.mined} 🎣${stats.fished} ⚔${stats.kills} +${stats.xp}XP Lv${level} Bal:${balance}`);
        runNextCycle(sock);
      });
    } else if (type === 'fishing') {
      doFishing(sock, () => {
        stats.cycles++;
        log(`📊 fishing:⛏${stats.mined} 🎣${stats.fished} ⚔${stats.kills} +${stats.xp}XP Lv${level} Bal:${balance}`);
        runNextCycle(sock);
      });
    } else if (type === 'combat') {
      doCombat(sock, () => {
        stats.cycles++;
        log(`📊 combat:⛏${stats.mined} 🎣${stats.fished} ⚔${stats.kills} +${stats.xp}XP Lv${level} Bal:${balance}`);
        runNextCycle(sock);
      });
    }
  }

  // ──── Connect / Disconnect ────
  socket.on('connect', () => {
    connected = true;
    log('Connected!');
    waitForInventory(socket, () => runNextCycle(socket));
  });

  socket.on('disconnect', () => {
    log('Disconnected!');
    connected = false;
    setTimeout(() => { log('⚠️ Reconnecting...'); startBot(); }, 30000);
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'BAD_TOKEN' || err.message === 'NO_TOKEN') {
      log('🔑 Token invalid, re-authenticating...');
      token = null;
      socket.disconnect();
      setTimeout(startBot, 2000);
    }
  });
}

function waitForInventory(sock, cb) {
  if (inventoryReady) { cb(); return; }
  log('⏳ Waiting for inventory...');
  let w = 0;
  const iv = setInterval(() => {
    w += 500;
    if (inventoryReady || w > 5000) { clearInterval(iv); cb(); }
  }, 500);
}

// ============================================================================
// STATUS REPORT (every 10 min)
// ============================================================================

setInterval(() => {
  const p = getProfitSummary();
  const fishItems = inventory.filter(i => i.defId.startsWith('fish_'));
  const matItems = inventory.filter(i => i.defId.startsWith('mat_'));
  const fishValue = fishItems.reduce((s, i) => s + (PRICE_FLOOR[i.defId] || 1) * i.qty, 0);
  const matValue = matItems.reduce((s, i) => s + (PRICE_FLOOR[i.defId] || 1) * i.qty, 0);

  log(`\n📊 ══ [${p.hours}h] PROFIT REPORT ══`);
  log(`⛏${stats.mined} 🎣${stats.fished} ⚔${stats.fought} | Lv${level} XP${stats.xp}`);
  log(`💰 QS:+${stats.earnedQuick} MKT:+${stats.earnedMarket} TOTAL:+${p.totalEarned}`);
  log(`💵 Rate: ${p.rate}/h | Sold: ${p.itemsSold} items`);
  log(`📦 ${inventory.length}/${CARRY_CAP} stacks`);
  log(`🐟 Fish: ${fishItems.length} (~${fishValue}) | 🧱 Mats: ${matItems.length} (~${matValue})`);
  log(`⏸️ Held: ${p.holdCount} (~${p.heldValue})`);
  log(`💰 Bal:${balance} | Daily:${dailyEarned}/${DAILY_EARN_CAP}`);
  log(`🔧 Zone:${stats.fatigueDrops} FishTO:${stats.consecutiveErrors} Fatigue:${Math.round((1 - fatigueMultiplier) * 100)} Rests:${stats.repaired}`);
  log(`👹 Boss:${stats.bossClaims} | 🔨 Crafted:${stats.crafted} | 🍖 Food:${stats.fed}`);
  log(`📈 Market: ${Object.entries(marketPrices).map(([k, v]) => `${k}:${v.best}`).join(' ➡️ ')}`);
  log(`══════════════════`);
}, STATUS_INTERVAL);

// ============================================================================
// START
// ============================================================================

log('=== OWNTOWN FARMER v1.0 ===');
log('Mining, Fishing, Combat, Marketplace');
log('🚀 Starting...');
startBot();
