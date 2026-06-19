# Owntown Stability + Anti-ban + Smartness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Owntown bot more stable and harder to ban (Phase 1), then smarter
at combat/market/orchestration/quests (Phase 2), via incremental pure-function
modules under `lib/` wired into the existing `bot.js` orchestrator.

**Architecture:** Approach A — surgical edits in `bot.js`, all new decision logic
lives in small pure modules in `lib/` (mirrors `lib/market.js` / `lib/schedule.js`),
each unit-tested with `node:test`. `bot.js` stays the glue/orchestrator. Zero new
runtime dependencies. Balanced risk profile (preserve earning, harden real ban
points). Runtime NOT touched until Phase 1 is committed+pushed, then one
`systemctl restart` deploys it (also promoting the stale v25 process to v30).

**Tech Stack:** Node.js, `node:test`, socket.io-client, tweetnacl, bs58 (existing).

---

## File Structure

New pure modules (each one responsibility, unit-tested):
- `lib/movement.js` — geometry: `distance(a,b)`, `inRange(pos,target,range)`.
- `lib/rotation.js` — `pickActivity({cycles, eligible, weights, rng})` weighted-random.
- `lib/microbreak.js` — `nextBreakAfter(cfg, rng)`, `isBreakDue(state, cycles)`.
- `lib/combat.js` — `pickTarget({monsters, pos, currentIdx})` best alive mob.
- `lib/orchestrator.js` — `decideAction(signals)` adaptive activity selection.
- `lib/quest.js` — `questActionFor(questState, knownMap)` dynamic quest→action.
Extend:
- `lib/market.js` — add `sellTiming({trend, depth})` advice helper.
Modify:
- `bot.js` — wire all modules; add reconnect supervisor; add OUT_OF_RANGE guard.
- `config.js` — new env knobs (micro-break).
- `test/logic.test.js` — unit tests for all new pure helpers.
- `test/smoke.test.js` — bump expectations if version/commands change.
- `package.json` — version bump.
- `CHANGELOG.md` — release notes.

---

# PHASE 1 — Stability & Anti-ban

## Task 1: Movement geometry helper (`lib/movement.js`)

**Files:**
- Create: `lib/movement.js`
- Test: `test/logic.test.js` (append)

- [ ] **Step 1: Write the failing test** (append to `test/logic.test.js`)

```js
const { distance, inRange } = require('../lib/movement');

test('distance computes planar XZ distance', () => {
  assert.equal(distance({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
});

test('inRange true within radius, false outside', () => {
  assert.equal(inRange({ x: 0, z: 0 }, { x: 3, z: 4 }, 6), true);
  assert.equal(inRange({ x: 0, z: 0 }, { x: 3, z: 4 }, 4), false);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test test/logic.test.js`
Expected: FAIL — `Cannot find module '../lib/movement'`.

- [ ] **Step 3: Implement `lib/movement.js`**

```js
function distance(a, b) {
  const dx = (b.x || 0) - (a.x || 0);
  const dz = (b.z || 0) - (a.z || 0);
  return Math.sqrt(dx * dx + dz * dz);
}

function inRange(pos, target, range) {
  return distance(pos, target) <= range;
}

module.exports = { distance, inRange };
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test test/logic.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/movement.js test/logic.test.js
git commit -m "feat(movement): planar distance + inRange helper"
```

## Task 2: OUT_OF_RANGE mining guard (wire `lib/movement.js` into bot.js)

**Files:**
- Modify: `bot.js` (the `doActions` mining branch, ~line 342; add re-walk on range fail)

- [ ] **Step 1: Add require** near the other lib requires (top of `bot.js`, after the
`parseSchedule` require):

```js
const { distance, inRange } = require('./lib/movement');
```

- [ ] **Step 2: Add a mining range constant** in the CONSTANTS block (near `LOW_DURABILITY`):

```js
const MINING_RANGE = 6; // emit mining:start only within this many units of node
```

- [ ] **Step 3: Guard the mining emit.** In `doActions`, replace the mining emit:

Find:
```js
if(type==='mining'){sock.emit('mining:start',{nodeId:node.id});count++}
```
Replace with:
```js
if(type==='mining'){
  if(!inRange(pos,node.pos,MINING_RANGE)){
    // out of range: re-walk to the node once instead of spam-emitting
    clearInterval(iv);
    walkDirect(sock,node.pos,()=>{ if(connected) doActions(sock,'mining'); });
    return;
  }
  sock.emit('mining:start',{nodeId:node.id});count++;
}
```

- [ ] **Step 4: Verify syntax + smoke**

Run: `node --check bot.js && node --test test/smoke.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "fix(mining): re-walk to node when out of range instead of spamming emit"
```

## Task 3: Reconnect supervisor (bot.js)

**Files:**
- Modify: `bot.js` (add a supervisor interval near the watchdog, ~line 520; add an
attempt counter logged in `scheduleStart`)

- [ ] **Step 1: Add a reconnect attempt counter + log.** Modify `scheduleStart`
(currently ~line 67) to log every armed retry:

Find:
```js
function scheduleStart(ms) {
  if (retryTimer) clearTimeout(retryTimer);
  nextRetryAt = Date.now() + Math.max(0, ms || 0);
  retryTimer = setTimeout(() => { retryTimer = null; startBot(); }, ms);
}
```
Replace with:
```js
let reconnectAttempts = 0;
function scheduleStart(ms) {
  if (retryTimer) clearTimeout(retryTimer);
  nextRetryAt = Date.now() + Math.max(0, ms || 0);
  reconnectAttempts++;
  log(`🔁 reconnect attempt #${reconnectAttempts} in ${Math.round((ms||0)/1000)}s`);
  retryTimer = setTimeout(() => { retryTimer = null; startBot(); }, ms);
}
```

- [ ] **Step 2: Reset the counter on successful connect.** In the `socket.on('connect',...)`
handler (~line 493) add after `connected=true;`:

```js
reconnectAttempts = 0;
```

- [ ] **Step 3: Add the supervisor.** Add this interval right after the WATCHDOG
`setInterval(...)` block (~line 522). It is schedule-aware via `scheduleAllowsOnline()`
(added in Task 4; for now reference it — Task 4 defines it). To keep tasks
independently runnable, define a minimal version here and Task 4 upgrades it:

```js
// ============ RECONNECT SUPERVISOR ============
// Guarantees a reconnect is always armed when we should be online but aren't.
function shouldBeOnline(){ return !stopped && !paused; }
setInterval(()=>{
  if(!shouldBeOnline())return;
  if(connected)return;
  if(retryTimer)return;            // a retry is already armed
  if(maintenanceInFlight)return;   // restart/update in progress
  log('🛟 supervisor: no connection and no pending retry — re-arming');
  scheduleStart(2000);
},60000);
```

- [ ] **Step 4: Verify**

Run: `node --check bot.js && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "fix(reconnect): supervisor re-arms dead reconnect chain + logs every attempt"
```

## Task 4: Micro-break humanization (`lib/microbreak.js` + config + bot.js)

**Files:**
- Create: `lib/microbreak.js`
- Modify: `config.js` (new env knobs), `bot.js` (apply break between cycles)
- Test: `test/logic.test.js` (append)

- [ ] **Step 1: Write failing test** (append to `test/logic.test.js`)

```js
const { nextBreakAfter, isBreakDue } = require('../lib/microbreak');

test('nextBreakAfter returns a cycle count within configured bounds', () => {
  const rng = () => 0.5; // deterministic midpoint
  const n = nextBreakAfter({ everyMin: 6, everyMax: 14 }, rng);
  assert.equal(n, 10); // 6 + 0.5*(14-6) = 10
});

test('isBreakDue true once cycles reach the threshold', () => {
  assert.equal(isBreakDue({ dueAtCycle: 10 }, 9), false);
  assert.equal(isBreakDue({ dueAtCycle: 10 }, 10), true);
  assert.equal(isBreakDue({ dueAtCycle: 10 }, 11), true);
});
```

- [ ] **Step 2: Run test, verify fail**

Run: `node --test test/logic.test.js`
Expected: FAIL — `Cannot find module '../lib/microbreak'`.

- [ ] **Step 3: Implement `lib/microbreak.js`**

```js
// Pure helpers for human-like idle micro-breaks between activity cycles.
function nextBreakAfter(cfg, rng = Math.random) {
  const min = cfg.everyMin, max = cfg.everyMax;
  return Math.round(min + rng() * (max - min));
}
function isBreakDue(state, cycles) {
  return cycles >= state.dueAtCycle;
}
function breakDurationMs(cfg, rng = Math.random) {
  const min = cfg.minSec, max = cfg.maxSec;
  return Math.round((min + rng() * (max - min)) * 1000);
}
module.exports = { nextBreakAfter, isBreakDue, breakDurationMs };
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test test/logic.test.js`
Expected: PASS.

- [ ] **Step 5: Add config knobs** to `config.js` `config` object (after `watchdogStuckMin`):

```js
  microbreakEnabled: (process.env.MICROBREAK_ENABLED || 'true').toLowerCase() === 'true',
  microbreakMinSec: parseInt(process.env.MICROBREAK_MIN_SEC || '30', 10),
  microbreakMaxSec: parseInt(process.env.MICROBREAK_MAX_SEC || '180', 10),
  microbreakEveryMin: parseInt(process.env.MICROBREAK_EVERY_MIN || '6', 10),
  microbreakEveryMax: parseInt(process.env.MICROBREAK_EVERY_MAX || '14', 10),
```

- [ ] **Step 6: Wire into bot.js.** Add require near other lib requires:

```js
const { nextBreakAfter, isBreakDue, breakDurationMs } = require('./lib/microbreak');
```

Add state near the autopilot state vars (~line 64):

```js
let microbreakState = { dueAtCycle: nextBreakAfter({ everyMin: config.microbreakEveryMin, everyMax: config.microbreakEveryMax }) };
```

In `runNextCycle`, right after `stats.cycles++;stats.consecutiveErrors=0;` (~line 351),
insert the break check:

```js
  if(config.microbreakEnabled && isBreakDue(microbreakState, stats.cycles)){
    const ms = breakDurationMs({ minSec: config.microbreakMinSec, maxSec: config.microbreakMaxSec });
    microbreakState = { dueAtCycle: stats.cycles + nextBreakAfter({ everyMin: config.microbreakEveryMin, everyMax: config.microbreakEveryMax }) };
    log(`😴 micro-break ${Math.round(ms/1000)}s (next at cycle ${microbreakState.dueAtCycle})`);
    touchActivity();
    setTimeout(()=>{ if(connected) runNextCycle(sock); }, ms);
    return;
  }
```

(Note: place it before `const type=decideNextAction();` so we skip an activity for the break.)

- [ ] **Step 7: Upgrade supervisor `shouldBeOnline`** — micro-breaks call
`touchActivity()` so the watchdog won't fire mid-break; no change needed. Verify the
break path keeps `connected` true (it does; we only `setTimeout`).

- [ ] **Step 8: Verify**

Run: `node --check bot.js && node --test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/microbreak.js config.js bot.js test/logic.test.js
git commit -m "feat(antiban): randomized idle micro-breaks between cycles"
```

## Task 5: Weighted-random activity rotation (`lib/rotation.js`)

**Files:**
- Create: `lib/rotation.js`
- Modify: `bot.js` (`decideNextAction` rotation fallback)
- Test: `test/logic.test.js` (append)

- [ ] **Step 1: Write failing test**

```js
const { pickActivity } = require('../lib/rotation');

test('pickActivity returns an eligible activity', () => {
  const out = pickActivity({ eligible: ['mining','fishing','combat'], weights: { mining:3, fishing:1, combat:1 }, rng: () => 0.0 });
  assert.equal(out, 'mining'); // rng 0 → first weighted bucket
});

test('pickActivity respects weights at the high end', () => {
  const out = pickActivity({ eligible: ['mining','fishing'], weights: { mining:1, fishing:1 }, rng: () => 0.99 });
  assert.equal(out, 'fishing');
});

test('pickActivity falls back to first eligible when weights missing', () => {
  const out = pickActivity({ eligible: ['fishing'], weights: {}, rng: () => 0.5 });
  assert.equal(out, 'fishing');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/logic.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/rotation.js`**

```js
// Weighted-random pick among eligible activities (non-deterministic rotation).
function pickActivity({ eligible = [], weights = {}, rng = Math.random }) {
  if (eligible.length === 0) return null;
  const w = eligible.map((a) => Math.max(0, weights[a] || 1));
  const total = w.reduce((s, x) => s + x, 0);
  if (total <= 0) return eligible[0];
  let r = rng() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= w[i];
    if (r < 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}
module.exports = { pickActivity };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/logic.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into bot.js `decideNextAction`.** Add require:

```js
const { pickActivity } = require('./lib/rotation');
```

Replace the fixed `order`-array fallback (~lines 246-250) :

Find:
```js
  const order=['sell','mining','fishing','combat','mining','fishing','mining','combat'];
  let action=order[stats.cycles%order.length];
  // Skip sell rotation when nothing to sell — advance to next activity
  if(action==='sell'&&!inventory.some(isSellable))action=order[(stats.cycles+1)%order.length];
  return action;
```
Replace with:
```js
  // Weighted-random rotation (non-deterministic to avoid a periodic signature).
  const eligible=[];
  if(inventory.some(isSellable))eligible.push('sell');
  eligible.push('mining','fishing');
  if(liveMonsters.some(m=>m.alive))eligible.push('combat');
  const weights={ sell:2, mining:3, fishing:2, combat:2 };
  return pickActivity({ eligible, weights }) || 'mining';
```

- [ ] **Step 6: Verify**

Run: `node --check bot.js && node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/rotation.js bot.js test/logic.test.js
git commit -m "feat(antiban): weighted-random activity rotation"
```

## Task 6: A3 transport investigation + Phase 1 release

**Files:**
- Modify: `bot.js` (socket transport, ~line 401, only if investigation warrants),
  `package.json` (version), `CHANGELOG.md`, `test/smoke.test.js` (version expectation)

- [ ] **Step 1: Investigate real client transport.** Document finding in CHANGELOG.
  Without a packet capture of the real client, the safe, defensible choice is to
  ALLOW the normal socket.io upgrade path (polling→websocket), which is what a
  default browser client does, rather than forcing polling-only. Change:

Find:
```js
  const socket=io('https://'+GAME_HOST,{auth:{token},transports:['polling'],upgrade:false,reconnection:false});
```
Replace with:
```js
  // Let socket.io use its default transport set (polling→websocket upgrade),
  // matching a normal browser client; we still drive reconnection ourselves.
  const socket=io('https://'+GAME_HOST,{auth:{token},reconnection:false});
```

> NOTE: memory records an earlier websocket instability (commit 6951f3e). If the
> live restart in Task 9 shows a connect/disconnect loop within ~60s, REVERT this
> single line back to `transports:['polling'],upgrade:false` and re-release. The
> reconnect supervisor (Task 3) makes this safe to trial.

- [ ] **Step 2: Bump version** in `package.json`:

```json
  "version": "31.0.0",
```

- [ ] **Step 3: Update smoke test version expectation** in `test/smoke.test.js`:

Find: `assert.equal(pkg.version, '30.0.0');`
Replace: `assert.equal(pkg.version, '31.0.0');`

- [ ] **Step 4: Add CHANGELOG entry** at top of `CHANGELOG.md` under `# Changelog`:

```md
## v31.0.0

- fix(reconnect): supervisor guarantees the reconnect chain re-arms (no more silent idle).
- fix(mining): re-walk to node when out of range instead of spamming mining:start.
- feat(antiban): randomized idle micro-breaks between cycles.
- feat(antiban): weighted-random activity rotation (no periodic signature).
- chore(transport): allow default polling→websocket upgrade to match a normal client.
```

- [ ] **Step 5: Verify full suite**

Run: `node --test`
Expected: PASS (all logic + smoke).

- [ ] **Step 6: Commit**

```bash
git add bot.js package.json CHANGELOG.md test/smoke.test.js
git commit -m "release(v31.0.0): stability + anti-ban hardening"
```

---

# PHASE 2 — Smartness

## Task 7: Combat targeting (`lib/combat.js`) — fix ⚔0 kills

**Files:**
- Create: `lib/combat.js`
- Modify: `bot.js` (`getAliveMonster` → use pickTarget; ensure walk-into-range)
- Test: `test/logic.test.js` (append)

- [ ] **Step 1: Write failing test**

```js
const { pickTarget } = require('../lib/combat');

test('pickTarget skips dead mobs and prefers the closest alive one', () => {
  const monsters = [
    { id: 'a', alive: false, pos: { x: 0, z: 0 } },
    { id: 'b', alive: true, pos: { x: 50, z: 0 } },
    { id: 'c', alive: true, pos: { x: 5, z: 0 } },
  ];
  const t = pickTarget({ monsters, pos: { x: 0, z: 0 } });
  assert.equal(t.id, 'c');
});

test('pickTarget returns null when nothing is alive', () => {
  assert.equal(pickTarget({ monsters: [{ id: 'a', alive: false }], pos: { x: 0, z: 0 } }), null);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/logic.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/combat.js`**

```js
const { distance } = require('./movement');

// Pick the best alive monster: closest first (cheap, reliable), tie-break by lower hp.
function pickTarget({ monsters = [], pos = { x: 0, z: 0 } }) {
  const alive = monsters.filter((m) => m && m.alive && m.pos);
  if (alive.length === 0) return null;
  alive.sort((a, b) => {
    const da = distance(pos, a.pos);
    const db = distance(pos, b.pos);
    if (da !== db) return da - db;
    return (a.hp || 0) - (b.hp || 0);
  });
  return alive[0];
}
module.exports = { pickTarget };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/logic.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into bot.js.** Add require:

```js
const { pickTarget } = require('./lib/combat');
```

Replace `getAliveMonster` (~line 301):

Find:
```js
function getAliveMonster(){if(liveMonsters.length>0){const alive=liveMonsters.filter(m=>m.alive);if(alive.length>0)return alive[stats.currentMonsterIdx%alive.length]}return{id:'mon_1',pos:{x:-100,z:-120}}}
```
Replace with:
```js
function getAliveMonster(){const t=pickTarget({monsters:liveMonsters,pos});return t||{id:'mon_1',pos:{x:-100,z:-120}}}
```

Add a combat range guard mirroring mining. In `doActions`, combat branch:

Find:
```js
else if(type==='combat'){sock.emit('combat:attack',{monsterId:mon.id});count++}
```
Replace with:
```js
else if(type==='combat'){
  if(mon.pos && !inRange(pos,mon.pos,COMBAT_RANGE)){
    clearInterval(iv);
    walkDirect(sock,mon.pos,()=>{ if(connected) doActions(sock,'combat'); });
    return;
  }
  sock.emit('combat:attack',{monsterId:mon.id});count++;
}
```

Add the constant near `MINING_RANGE`:
```js
const COMBAT_RANGE = 8;
```

- [ ] **Step 6: Verify**

Run: `node --check bot.js && node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/combat.js bot.js test/logic.test.js
git commit -m "feat(combat): closest-alive target selection + walk-into-range guard"
```

## Task 8: Market sell-timing advice (`lib/market.js` extend)

**Files:**
- Modify: `lib/market.js` (add `sellTiming`), `bot.js` (apply in `freshSell`)
- Test: `test/logic.test.js` (append)

- [ ] **Step 1: Write failing test**

```js
const { sellTiming } = require('../lib/market');

test('sellTiming holds briefly on rising thin markets', () => {
  assert.equal(sellTiming({ trend: 'rising', depth: 1 }).hold, true);
});
test('sellTiming sells on falling markets', () => {
  assert.equal(sellTiming({ trend: 'falling', depth: 5 }).hold, false);
});
test('sellTiming sells when market is deep regardless of trend', () => {
  assert.equal(sellTiming({ trend: 'rising', depth: 10 }).hold, false);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/logic.test.js`
Expected: FAIL — `sellTiming is not a function`.

- [ ] **Step 3: Implement** — add to `lib/market.js` before `module.exports`:

```js
// Advice: briefly hold sellable items only when price is rising AND the order
// book is thin (so we are not undercutting into a temporary dip). Sell otherwise.
function sellTiming({ trend = 'stable', depth = 0 } = {}) {
  if (trend === 'rising' && depth <= 2) return { hold: true, reason: 'rising thin market' };
  return { hold: false, reason: 'sell' };
}
```

Update exports:
```js
module.exports = { buildSellDecision, getMarketDepth, getPriceTrend, sellTiming };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/logic.test.js`
Expected: PASS.

- [ ] **Step 5: Apply in bot.js `freshSell`.** Add `sellTiming` to the market require:

Find:
```js
const { buildSellDecision, getMarketDepth, getPriceTrend } = require('./lib/market');
```
Replace:
```js
const { buildSellDecision, getMarketDepth, getPriceTrend, sellTiming } = require('./lib/market');
```

In `freshSell`, in the loop where `d.action==='MARKETPLACE'`, before pushing to `toM`,
apply a short hold when timing says so (only when not capacity-pressured). Find the
MARKETPLACE branch inside `freshSell` and wrap the push:

Find:
```js
else if(d.action==='MARKETPLACE')toM.push({instanceId:item.instanceId,defId:item.defId,qty:item.qty,price:d.price,marketBest:d.marketBest})
```
Replace:
```js
else if(d.action==='MARKETPLACE'){
  const timing=sellTiming({trend:d.trend,depth:d.depth});
  if(timing.hold && inventory.length < CARRY_CAP-6){toH.push({defId:item.defId,qty:item.qty,reason:timing.reason});stats.holdCount++}
  else toM.push({instanceId:item.instanceId,defId:item.defId,qty:item.qty,price:d.price,marketBest:d.marketBest});
}
```

- [ ] **Step 6: Verify**

Run: `node --check bot.js && node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/market.js bot.js test/logic.test.js
git commit -m "feat(market): hold sellable items briefly on rising thin markets"
```

## Task 9: Adaptive orchestrator (`lib/orchestrator.js`)

**Files:**
- Create: `lib/orchestrator.js`
- Modify: `bot.js` (`decideNextAction` priority section delegates weights)
- Test: `test/logic.test.js` (append)

- [ ] **Step 1: Write failing test**

```js
const { activityWeights } = require('../lib/orchestrator');

test('activityWeights boosts mining when a mined item price is high', () => {
  const w = activityWeights({ marketPrices: { mat_raw_resonite: 20 }, base: { mining: 3, fishing: 2 }, miningItems: ['mat_raw_resonite'], fishingItems: [], highPrice: 10 });
  assert.ok(w.mining > 3);
});

test('activityWeights leaves weights unchanged when no signal', () => {
  const w = activityWeights({ marketPrices: {}, base: { mining: 3, fishing: 2 }, miningItems: ['mat_raw_resonite'], fishingItems: [], highPrice: 10 });
  assert.deepEqual(w, { mining: 3, fishing: 2 });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/logic.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/orchestrator.js`**

```js
// Adaptive weights: boost an activity when items it yields are priced highly.
function activityWeights({ marketPrices = {}, base = {}, miningItems = [], fishingItems = [], highPrice = 10 }) {
  const out = { ...base };
  const maxOf = (ids) => ids.reduce((m, id) => Math.max(m, marketPrices[id] || 0), 0);
  if (out.mining != null && maxOf(miningItems) >= highPrice) out.mining = out.mining + 2;
  if (out.fishing != null && maxOf(fishingItems) >= highPrice) out.fishing = out.fishing + 2;
  return out;
}
module.exports = { activityWeights };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/logic.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into bot.js.** Add require:

```js
const { activityWeights } = require('./lib/orchestrator');
```

Add item-group constants near `MINING_NODES` (mining yields resonite-family; fishing
yields fish_*):

```js
const MINING_ITEMS = ['mat_raw_resonite','mat_circuit_scrap','mat_iron_shard','mat_carbon_fiber','mat_resonance_core'];
const FISHING_ITEMS = ['fish_sun_carp','fish_moon_koi','fish_void_angler','fish_abyssal_lantern','fish_golden_koi','fish_silver_darter'];
```

In `decideNextAction`, replace the static `weights` line from Task 5:

Find:
```js
  const weights={ sell:2, mining:3, fishing:2, combat:2 };
  return pickActivity({ eligible, weights }) || 'mining';
```
Replace:
```js
  const adaptive=activityWeights({ marketPrices, base:{ mining:3, fishing:2 }, miningItems:MINING_ITEMS, fishingItems:FISHING_ITEMS, highPrice:10 });
  const weights={ sell:2, mining:adaptive.mining, fishing:adaptive.fishing, combat:2 };
  return pickActivity({ eligible, weights }) || 'mining';
```

- [ ] **Step 6: Verify**

Run: `node --check bot.js && node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/orchestrator.js bot.js test/logic.test.js
git commit -m "feat(orchestrator): adaptive activity weights from live market prices"
```

## Task 10: Dynamic quest action (`lib/quest.js`)

**Files:**
- Create: `lib/quest.js`
- Modify: `bot.js` (`questNeedsAction` delegates to lib; keep known map as hints)
- Test: `test/logic.test.js` (append)

- [ ] **Step 1: Write failing test**

```js
const { questActionFor } = require('../lib/quest');

test('questActionFor uses known map first', () => {
  assert.equal(questActionFor({ activeId: 'first_shift_deepworks' }, { first_shift_deepworks: 'mining' }), 'mining');
});

test('questActionFor infers from keywords when unknown', () => {
  assert.equal(questActionFor({ activeId: 'catch_ten_fish' }, {}), 'fishing');
  assert.equal(questActionFor({ activeId: 'mine_the_deepworks' }, {}), 'mining');
  assert.equal(questActionFor({ activeId: 'defeat_5_threats' }, {}), 'combat');
  assert.equal(questActionFor({ activeId: 'sell_your_haul' }, {}), 'sell');
});

test('questActionFor returns null when no signal', () => {
  assert.equal(questActionFor({ activeId: 'mystery_quest' }, {}), null);
  assert.equal(questActionFor(null, {}), null);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/logic.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/quest.js`**

```js
// Map an active quest to the activity it needs. Known ids win; otherwise infer
// from keywords in the quest id so new quests work without a code change.
const KEYWORDS = [
  [/fish|catch|angler|koi|carp/i, 'fishing'],
  [/mine|mining|deepworks|ore|resonite|node/i, 'mining'],
  [/defeat|kill|threat|combat|hunt|slay|monster/i, 'combat'],
  [/sell|haul|market|list/i, 'sell'],
];
function questActionFor(questState, knownMap = {}) {
  if (!questState || !questState.activeId) return null;
  const id = questState.activeId;
  if (knownMap[id]) return knownMap[id];
  for (const [re, action] of KEYWORDS) if (re.test(id)) return action;
  return null;
}
module.exports = { questActionFor };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/logic.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into bot.js.** Add require:

```js
const { questActionFor } = require('./lib/quest');
```

Replace `questNeedsAction` body (~line 266) to delegate, keeping the sell-attempt cap:

Find:
```js
function questNeedsAction(){
  if(!questState||!questState.activeId)return null;
  const need = QUEST_NEEDS[questState.activeId]||null;
  if(need === 'sell' && questSellAttempts >= QUEST_SELL_MAX_ATTEMPTS) return null;
  return need;
}
```
Replace:
```js
function questNeedsAction(){
  const need = questActionFor(questState, QUEST_NEEDS);
  if(need === 'sell' && questSellAttempts >= QUEST_SELL_MAX_ATTEMPTS) return null;
  return need;
}
```

- [ ] **Step 6: Verify**

Run: `node --check bot.js && node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/quest.js bot.js test/logic.test.js
git commit -m "feat(quest): keyword-inferred quest action for unknown quests"
```

## Task 11: Phase 2 release

**Files:**
- Modify: `package.json` (version 32.0.0), `CHANGELOG.md`, `test/smoke.test.js`

- [ ] **Step 1: Bump version** in `package.json` to `"version": "32.0.0",`.
- [ ] **Step 2: Update smoke test** version expectation to `'32.0.0'`.
- [ ] **Step 3: CHANGELOG** add at top:

```md
## v32.0.0

- feat(combat): closest-alive targeting + walk-into-range (fixes 0-kills).
- feat(market): sell-timing hold on rising thin markets.
- feat(orchestrator): adaptive activity weights from live market prices.
- feat(quest): keyword-inferred quest action for unknown quests.
```

- [ ] **Step 4: Verify** `node --test` → PASS.
- [ ] **Step 5: Commit** `release(v32.0.0): smarter combat, market, orchestrator, quests`.

---

# Deployment (after Phase 1, then after Phase 2)

- [ ] Push branch: `git push -u origin feat/stability-antiban-phase1`
- [ ] Merge to main (PR or ff) per user preference.
- [ ] On server: `cd /root/owntown-farming-bot && git pull --ff-only` then
  `systemctl restart owntown-bot.service`.
- [ ] Watch logs 5 min: `journalctl -u owntown-bot.service -f` — confirm Connected,
  no connect/disconnect loop (if loop within 60s, revert Task 6 Step 1 transport
  line), micro-break + reconnect-attempt logs appear, no OUT_OF_RANGE bursts.
