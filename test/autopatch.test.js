const test = require('node:test');
const assert = require('node:assert');
const { replaceRegion, bumpConstant, RateLimiter } = require('../autopatch');

const SRC = [
  'const x = 1;',
  '// === AUTOPATCH:TIMEOUTS:START ===',
  'const REST_TIMEOUT = 20000;',
  '// === AUTOPATCH:TIMEOUTS:END ===',
  'const y = 2;',
].join('\n');

test('replaceRegion swaps only the marked body, leaving markers + outside intact', () => {
  const out = replaceRegion(SRC, 'TIMEOUTS', 'const REST_TIMEOUT = 30000;');
  assert.match(out, /AUTOPATCH:TIMEOUTS:START/);
  assert.match(out, /AUTOPATCH:TIMEOUTS:END/);
  assert.match(out, /REST_TIMEOUT = 30000;/);
  assert.match(out, /const x = 1;/);
  assert.match(out, /const y = 2;/);
  assert.doesNotMatch(out, /REST_TIMEOUT = 20000;/);
});

test('replaceRegion throws on missing region (never blind-edits)', () => {
  assert.throws(() => replaceRegion(SRC, 'NOPE', 'x'), /region NOPE not found/);
});

test('bumpConstant raises a numeric constant, capped', () => {
  assert.strictEqual(bumpConstant('const REST_TIMEOUT = 20000;', 'REST_TIMEOUT', 1.5, 60000), 'const REST_TIMEOUT = 30000;');
  assert.strictEqual(bumpConstant('const REST_TIMEOUT = 50000;', 'REST_TIMEOUT', 1.5, 60000), 'const REST_TIMEOUT = 60000;');
});

test('RateLimiter enforces 1/10min and 3/hour', () => {
  const rl = new RateLimiter(10 * 60000, 60 * 60000, 1, 3);
  let now = 1_000_000;
  assert.strictEqual(rl.tryAcquire(now), true);
  assert.strictEqual(rl.tryAcquire(now + 60000), false);
  assert.strictEqual(rl.tryAcquire(now + 11 * 60000), true);
  assert.strictEqual(rl.tryAcquire(now + 22 * 60000), true);
  assert.strictEqual(rl.tryAcquire(now + 33 * 60000), false);
});
