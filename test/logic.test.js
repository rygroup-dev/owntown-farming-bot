const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSellDecision, sellTiming } = require('../lib/market');
const { parseSchedule } = require('../lib/schedule');
const { distance, inRange } = require('../lib/movement');
const { nextBreakAfter, isBreakDue } = require('../lib/microbreak');
const { pickActivity } = require('../lib/rotation');
const { pickTarget } = require('../lib/combat');
const { activityWeights } = require('../lib/orchestrator');
const { questActionFor } = require('../lib/quest');

const PRICE_FLOOR = {
  mat_resonance_core: 3,
  mat_raw_resonite: 0.1,
  gear_resonite_edge: 0.2,
};

const QUICKSELL = {
  mat_raw_resonite: 6,
};

const MARKETPLACE_ONLY = new Set(['mat_resonance_core', 'gear_resonite_edge']);
const SAFE_QUICKSELL = new Set(['mat_raw_resonite']);

test('valuable items are held when no healthy market price exists', () => {
  const decision = buildSellDecision({
    defId: 'mat_resonance_core',
    marketPrices: {},
    marketHistory: [],
    priceFloor: PRICE_FLOOR,
    quicksell: QUICKSELL,
    marketplaceOnly: MARKETPLACE_ONLY,
    safeQuicksell: SAFE_QUICKSELL,
    undercutPct: 0.08,
  });

  assert.deepEqual(decision, {
    action: 'HOLD',
    reason: 'valuable (floor 3)',
    floor: 3,
  });
});

test('safe quicksell mats switch to marketplace when market is clearly better', () => {
  const decision = buildSellDecision({
    defId: 'mat_raw_resonite',
    marketPrices: { mat_raw_resonite: 9.5 },
    marketHistory: [{ counts: { mat_raw_resonite: 7 }, prices: { mat_raw_resonite: 9.5 } }],
    priceFloor: PRICE_FLOOR,
    quicksell: QUICKSELL,
    marketplaceOnly: MARKETPLACE_ONLY,
    safeQuicksell: SAFE_QUICKSELL,
    undercutPct: 0.08,
  });

  assert.equal(decision.action, 'MARKETPLACE');
  assert.equal(decision.price, 8.7);
  assert.equal(decision.marketBest, 9.5);
  assert.equal(decision.depth, 7);
  assert.equal(decision.trend, 'stable');
});

test('unknown items with no floor or market data fall back to quicksell baseline', () => {
  const decision = buildSellDecision({
    defId: 'misc_scrap',
    marketPrices: {},
    marketHistory: [],
    priceFloor: PRICE_FLOOR,
    quicksell: QUICKSELL,
    marketplaceOnly: MARKETPLACE_ONLY,
    safeQuicksell: SAFE_QUICKSELL,
    undercutPct: 0.08,
  });

  assert.deepEqual(decision, { action: 'QUICKSELL', price: 1 });
});

test('parseSchedule normalizes states and drops non-positive durations', () => {
  assert.deepEqual(
    parseSchedule(' on:18 , off:2 , idle:0 , foo:-4 , pause:1.5 '),
    [
      { state: 'on', hours: 18 },
      { state: 'off', hours: 2 },
      { state: 'on', hours: 1.5 },
    ]
  );
});

// ============ movement ============
test('distance computes planar XZ distance', () => {
  assert.equal(distance({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
});

test('inRange true within radius, false outside', () => {
  assert.equal(inRange({ x: 0, z: 0 }, { x: 3, z: 4 }, 6), true);
  assert.equal(inRange({ x: 0, z: 0 }, { x: 3, z: 4 }, 4), false);
});

// ============ microbreak ============
test('nextBreakAfter returns a cycle count within configured bounds', () => {
  const rng = () => 0.5;
  const n = nextBreakAfter({ everyMin: 6, everyMax: 14 }, rng);
  assert.equal(n, 10);
});

test('isBreakDue true once cycles reach the threshold', () => {
  assert.equal(isBreakDue({ dueAtCycle: 10 }, 9), false);
  assert.equal(isBreakDue({ dueAtCycle: 10 }, 10), true);
  assert.equal(isBreakDue({ dueAtCycle: 10 }, 11), true);
});

// ============ rotation ============
test('pickActivity returns an eligible activity', () => {
  const out = pickActivity({ eligible: ['mining', 'fishing', 'combat'], weights: { mining: 3, fishing: 1, combat: 1 }, rng: () => 0.0 });
  assert.equal(out, 'mining');
});

test('pickActivity respects weights at the high end', () => {
  const out = pickActivity({ eligible: ['mining', 'fishing'], weights: { mining: 1, fishing: 1 }, rng: () => 0.99 });
  assert.equal(out, 'fishing');
});

test('pickActivity falls back to first eligible when weights missing', () => {
  const out = pickActivity({ eligible: ['fishing'], weights: {}, rng: () => 0.5 });
  assert.equal(out, 'fishing');
});

// ============ combat ============
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

// ============ market sell timing ============
test('sellTiming holds briefly on rising thin markets', () => {
  assert.equal(sellTiming({ trend: 'rising', depth: 1 }).hold, true);
});
test('sellTiming sells on falling markets', () => {
  assert.equal(sellTiming({ trend: 'falling', depth: 5 }).hold, false);
});
test('sellTiming sells when market is deep regardless of trend', () => {
  assert.equal(sellTiming({ trend: 'rising', depth: 10 }).hold, false);
});

// ============ orchestrator ============
test('activityWeights boosts mining when a mined item price is high', () => {
  const w = activityWeights({ marketPrices: { mat_raw_resonite: 20 }, base: { mining: 3, fishing: 2 }, miningItems: ['mat_raw_resonite'], fishingItems: [], highPrice: 10 });
  assert.ok(w.mining > 3);
});

test('activityWeights leaves weights unchanged when no signal', () => {
  const w = activityWeights({ marketPrices: {}, base: { mining: 3, fishing: 2 }, miningItems: ['mat_raw_resonite'], fishingItems: [], highPrice: 10 });
  assert.deepEqual(w, { mining: 3, fishing: 2 });
});

// ============ quest ============
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
