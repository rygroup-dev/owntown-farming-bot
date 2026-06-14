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

// --- appended to test/autopatch.test.js ---
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectRecipe, applyRecipe, AUTOPATCH_THRESHOLD } = require('../autopatch');

test('selectRecipe matches recurring known patterns only above threshold', () => {
  assert.strictEqual(selectRecipe({ code: 'AUTH_TIMEOUT', count: AUTOPATCH_THRESHOLD - 1 }), null);
  assert.strictEqual(selectRecipe({ code: 'AUTH_TIMEOUT', count: AUTOPATCH_THRESHOLD }).name, 'bump-timeout');
  assert.strictEqual(selectRecipe({ code: 'WRONG_ZONE', zone: 'residential', count: AUTOPATCH_THRESHOLD }).name, 'blacklist-zone');
  assert.strictEqual(selectRecipe({ code: 'BRAND_NEW', count: 999 }).name, 'register-error-code');
});

test('applyRecipe backs up, patches a marked region, and passes node --check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
  const src = path.join(dir, 'fixture.js');
  fs.writeFileSync(src, [
    '// === AUTOPATCH:TIMEOUTS:START ===',
    'const REST_TIMEOUT = 20000;',
    'const AUTH_TIMEOUT = 20000;',
    '// === AUTOPATCH:TIMEOUTS:END ===',
  ].join('\n'));
  const recipe = selectRecipe({ code: 'AUTH_TIMEOUT', count: AUTOPATCH_THRESHOLD });
  const res = applyRecipe(recipe, { sourcePath: src, backupDir: dir, entry: { code: 'AUTH_TIMEOUT', count: 5 } });
  assert.strictEqual(res.ok, true);
  assert.match(fs.readFileSync(src, 'utf8'), /AUTH_TIMEOUT = 30000/);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('fixture.js.bak.')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyRecipe rolls back when the patch would not parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
  const src = path.join(dir, 'fixture.js');
  const original = [
    '// === AUTOPATCH:ZONE_BLACKLIST:START ===',
    'const ZONE_BLACKLIST = [];',
    '// === AUTOPATCH:ZONE_BLACKLIST:END ===',
  ].join('\n');
  fs.writeFileSync(src, original);
  const bad = { name: 'broken', region: 'ZONE_BLACKLIST', patch: () => 'const ZONE_BLACKLIST = [ ;' };
  const res = applyRecipe(bad, { sourcePath: src, backupDir: dir, entry: { code: 'X', count: 5 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(fs.readFileSync(src, 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});
