const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSellDecision } = require('../lib/market');
const { parseSchedule } = require('../lib/schedule');

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
