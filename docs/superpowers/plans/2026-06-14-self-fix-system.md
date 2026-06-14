# Self-Fix System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic (no-LLM) hybrid self-fix system to the Owntown bot so errors are always captured, known problems self-heal at runtime, and recurring patch-able problems auto-patch their own source with guardrails.

**Architecture:** Three new zero-dependency modules — `errorbus.js` (capture + knowledge base), `selfheal.js` (runtime healers, pure decision functions), `autopatch.js` (rule/template patch engine + guardrails). `bot.js` routes every error through the ErrorBus, exposes marked AUTOPATCH source regions, wires `/selfix`, and gets the bundled direct fixes (counter split, ledger bug).

**Tech Stack:** Node.js (CommonJS), built-in `node:test` + `node:assert` (no new deps — matches the project's zero-dep modules `config.js`/`telegram.js`), `child_process` for `node --check`, `fs` for atomic JSON persistence.

---

## File Structure

- **Create** `errorbus.js` — `signature()`, `ErrorBus` factory: `record/get/all/top/setStatus`, atomic JSON persistence to `errors.json`.
- **Create** `selfheal.js` — pure `decide(entry, state)` returning an action descriptor; thresholds.
- **Create** `autopatch.js` — recipes, `selectRecipe()`, region-edit helpers, `RateLimiter`, `applyRecipe()` (backup + patch + `node --check`).
- **Create** `test/errorbus.test.js`, `test/selfheal.test.js`, `test/autopatch.test.js`.
- **Modify** `bot.js` — route errors through ErrorBus; add AUTOPATCH marked regions + use their constants; apply self-heal actions; run autopatch with restart/rollback verification; wire `/selfix`; enrich `/errors` + `/status`; fix ledger bug (line ~1297).
- **Modify** `package.json` — add `"test": "node --test test/"` script.

**Threshold constants (single source of truth, defined in each module's top):**
- Self-heal recurring threshold: `count >= 3`
- Autopatch recurring threshold: `count >= 5`
- Rate limit: max 1 patch / 10 min, max 3 / hour
- Autopatch post-restart connect verification window: 60s

---

## Task 1: ErrorBus — signature + knowledge base

**Files:**
- Create: `errorbus.js`
- Test: `test/errorbus.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/errorbus.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { signature, ErrorBus } = require('../errorbus');

test('signature is stable across volatile numbers in context', () => {
  const a = signature({ code: 'WRONG_ZONE', expected: 'pond', zone: 'residential' });
  const b = signature({ code: 'WRONG_ZONE', expected: 'pond', zone: 'residential' });
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'WRONG_ZONE|pond|residential');
});

test('signature normalizes code case and missing fields', () => {
  assert.strictEqual(signature({ code: 'ping timeout' }), 'PING_TIMEOUT||');
});

test('record creates then increments a KB entry and persists', () => {
  const file = path.join(os.tmpdir(), `kb-${Date.now()}.json`);
  const bus = new ErrorBus(file);
  const e1 = bus.record({ code: 'WRONG_ZONE', expected: 'pond', zone: 'residential', context: 'expected pond, got residential' });
  assert.strictEqual(e1.count, 1);
  assert.strictEqual(e1.status, 'unhandled');
  const e2 = bus.record({ code: 'WRONG_ZONE', expected: 'pond', zone: 'residential' });
  assert.strictEqual(e2.count, 2);
  // reload from disk -> persisted
  const bus2 = new ErrorBus(file);
  assert.strictEqual(bus2.get('WRONG_ZONE|pond|residential').count, 2);
  fs.unlinkSync(file);
});

test('setStatus and top(n) work', () => {
  const file = path.join(os.tmpdir(), `kb-${Date.now()}-2.json`);
  const bus = new ErrorBus(file);
  bus.record({ code: 'A' }); bus.record({ code: 'A' }); bus.record({ code: 'B' });
  bus.setStatus('A||', 'patched', 'bump-timeout');
  assert.strictEqual(bus.get('A||').status, 'patched');
  assert.strictEqual(bus.get('A||').lastAction, 'bump-timeout');
  assert.strictEqual(bus.top(1)[0].sig, 'A||');
  fs.unlinkSync(file);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/errorbus.test.js`
Expected: FAIL — `Cannot find module '../errorbus'`.

- [ ] **Step 3: Write minimal implementation**

```js
// errorbus.js — zero-dep error knowledge base
const fs = require('fs');

function normCode(code) {
  return String(code || 'UNKNOWN').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

// Stable signature: code + expected-zone + got-zone. No volatile numbers.
function signature({ code, expected, zone } = {}) {
  return `${normCode(code)}|${expected || ''}|${zone || ''}`;
}

class ErrorBus {
  constructor(kbPath) {
    this.path = kbPath;
    this.kb = {};
    try { this.kb = JSON.parse(fs.readFileSync(kbPath, 'utf8')); } catch { this.kb = {}; }
  }
  _persist() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.kb, null, 2));
    fs.renameSync(tmp, this.path); // atomic
  }
  record(err) {
    const sig = signature(err);
    const now = new Date().toISOString();
    const cur = this.kb[sig];
    if (cur) {
      cur.count++; cur.lastSeen = now;
      if (err.context) cur.sampleContext = err.context;
    } else {
      this.kb[sig] = {
        sig, code: normCode(err.code), sampleContext: err.context || '',
        count: 1, firstSeen: now, lastSeen: now,
        status: 'unhandled', lastAction: null,
      };
    }
    this._persist();
    return this.kb[sig];
  }
  get(sig) { return this.kb[sig]; }
  all() { return Object.values(this.kb); }
  top(n) { return this.all().sort((a, b) => b.count - a.count).slice(0, n); }
  setStatus(sig, status, lastAction) {
    if (this.kb[sig]) { this.kb[sig].status = status; this.kb[sig].lastAction = lastAction || this.kb[sig].lastAction; this._persist(); }
  }
}

module.exports = { signature, ErrorBus, normCode };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/errorbus.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add errorbus.js test/errorbus.test.js
git commit -m "feat: add ErrorBus knowledge base (Layer 1 self-fix)"
```

---

## Task 2: Self-Heal decision engine

**Files:**
- Create: `selfheal.js`
- Test: `test/selfheal.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/selfheal.test.js
const test = require('node:test');
const assert = require('node:assert');
const { decide, HEAL_THRESHOLD } = require('../selfheal');

test('below threshold returns no action', () => {
  const a = decide({ code: 'WRONG_ZONE', zone: 'residential', count: HEAL_THRESHOLD - 1 });
  assert.strictEqual(a, null);
});

test('recurring WRONG_ZONE returns blacklist-zone action with the bad zone', () => {
  const a = decide({ code: 'WRONG_ZONE', zone: 'residential', count: HEAL_THRESHOLD });
  assert.deepStrictEqual(a, { type: 'blacklist-zone', zone: 'residential' });
});

test('recurring connection error returns tune-reconnect-runtime action', () => {
  const a = decide({ code: 'PING_TIMEOUT', count: HEAL_THRESHOLD });
  assert.strictEqual(a.type, 'tune-reconnect-runtime');
});

test('unknown recurring code returns null (defers to capture/autopatch)', () => {
  const a = decide({ code: 'SOME_NEW_CODE', count: 99 });
  assert.strictEqual(a, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/selfheal.test.js`
Expected: FAIL — `Cannot find module '../selfheal'`.

- [ ] **Step 3: Write minimal implementation**

```js
// selfheal.js — pure runtime self-heal decisions (Layer 2). No side effects.
const HEAL_THRESHOLD = 3;

// entry: { code, zone, count }. Returns an action descriptor or null.
function decide(entry) {
  if (!entry || entry.count < HEAL_THRESHOLD) return null;
  switch (entry.code) {
    case 'WRONG_ZONE':
      return entry.zone ? { type: 'blacklist-zone', zone: entry.zone } : null;
    case 'PING_TIMEOUT':
    case 'TRANSPORT_ERROR':
      return { type: 'tune-reconnect-runtime' };
    default:
      return null; // unknown -> let ErrorBus capture + AutoPatch handle it
  }
}

module.exports = { decide, HEAL_THRESHOLD };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/selfheal.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add selfheal.js test/selfheal.test.js
git commit -m "feat: add self-heal decision engine (Layer 2 self-fix)"
```

---

## Task 3: AutoPatch — region edit helpers + rate limiter

**Files:**
- Create: `autopatch.js`
- Test: `test/autopatch.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/autopatch.test.js
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
  assert.strictEqual(bumpConstant('const REST_TIMEOUT = 50000;', 'REST_TIMEOUT', 1.5, 60000), 'const REST_TIMEOUT = 60000;'); // capped
});

test('RateLimiter enforces 1/10min and 3/hour', () => {
  const rl = new RateLimiter(10 * 60000, 60 * 60000, 1, 3);
  let now = 1_000_000;
  assert.strictEqual(rl.tryAcquire(now), true);            // 1st ok
  assert.strictEqual(rl.tryAcquire(now + 60000), false);   // <10min -> blocked
  assert.strictEqual(rl.tryAcquire(now + 11 * 60000), true);   // 2nd ok
  assert.strictEqual(rl.tryAcquire(now + 22 * 60000), true);   // 3rd ok
  assert.strictEqual(rl.tryAcquire(now + 33 * 60000), false);  // 4th -> >3/hour blocked
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/autopatch.test.js`
Expected: FAIL — `Cannot find module '../autopatch'`.

- [ ] **Step 3: Write minimal implementation (helpers only; recipes added in Task 4)**

```js
// autopatch.js — rule/template patch engine + guardrails (Layer 3)
function replaceRegion(source, name, newBody) {
  const start = `// === AUTOPATCH:${name}:START ===`;
  const end = `// === AUTOPATCH:${name}:END ===`;
  const si = source.indexOf(start), ei = source.indexOf(end);
  if (si === -1 || ei === -1 || ei < si) throw new Error(`region ${name} not found`);
  const head = source.slice(0, si + start.length);
  const tail = source.slice(ei);
  return `${head}\n${newBody}\n${tail}`;
}

function bumpConstant(line, name, factor, cap) {
  const re = new RegExp(`(${name}\\s*=\\s*)(\\d+)`);
  return line.replace(re, (_, pre, num) => pre + Math.min(cap, Math.round(Number(num) * factor)));
}

class RateLimiter {
  constructor(shortMs, longMs, maxShort, maxLong) {
    this.shortMs = shortMs; this.longMs = longMs;
    this.maxShort = maxShort; this.maxLong = maxLong;
    this.hits = [];
  }
  tryAcquire(now) {
    this.hits = this.hits.filter(t => now - t < this.longMs);
    const inShort = this.hits.filter(t => now - t < this.shortMs).length;
    if (inShort >= this.maxShort) return false;
    if (this.hits.length >= this.maxLong) return false;
    this.hits.push(now);
    return true;
  }
}

module.exports = { replaceRegion, bumpConstant, RateLimiter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/autopatch.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add autopatch.js test/autopatch.test.js
git commit -m "feat: add AutoPatch region-edit helpers + rate limiter"
```

---

## Task 4: AutoPatch — recipes + selectRecipe + applyRecipe

**Files:**
- Modify: `autopatch.js`
- Test: `test/autopatch.test.js` (append)

- [ ] **Step 1: Write the failing test (append to existing file)**

```js
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
  // recipe that intentionally emits broken JS to exercise the node --check gate
  const bad = { name: 'broken', region: 'ZONE_BLACKLIST', patch: () => 'const ZONE_BLACKLIST = [ ;' };
  const res = applyRecipe(bad, { sourcePath: src, backupDir: dir, entry: { code: 'X', count: 5 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(fs.readFileSync(src, 'utf8'), original); // restored
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/autopatch.test.js`
Expected: FAIL — `selectRecipe is not a function`.

- [ ] **Step 3: Add recipes + selectRecipe + applyRecipe to `autopatch.js`**

Add these `require`s at the top of `autopatch.js`:

```js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
```

Append before `module.exports`:

```js
const AUTOPATCH_THRESHOLD = 5;

// Each recipe: { name, region, match(entry)->bool, patch(currentRegionBody, entry)->newBody }
const RECIPES = [
  {
    name: 'bump-timeout', region: 'TIMEOUTS',
    match: e => /TIMEOUT$/.test(e.code) && /AUTH|REQUEST|REST/.test(e.code),
    patch: (body, e) => {
      const name = e.code.includes('AUTH') ? 'AUTH_TIMEOUT' : 'REST_TIMEOUT';
      return body.split('\n').map(l => l.includes(name) ? bumpConstant(l, name, 1.5, 60000) : l).join('\n');
    },
  },
  {
    name: 'tune-reconnect', region: 'RECONNECT',
    match: e => e.code === 'PING_TIMEOUT' || e.code === 'TRANSPORT_ERROR',
    patch: (body) => body.split('\n').map(l =>
      l.includes('RECONNECT_BACKOFF_MS') ? bumpConstant(l, 'RECONNECT_BACKOFF_MS', 1.5, 120000) : l).join('\n'),
  },
  {
    name: 'blacklist-zone', region: 'ZONE_BLACKLIST',
    match: e => e.code === 'WRONG_ZONE' && !!e.zone,
    patch: (body, e) => body.replace(
      /(const ZONE_BLACKLIST = \[)([^\]]*)(\];)/,
      (_, a, mid, c) => {
        const items = mid.split(',').map(s => s.trim()).filter(Boolean);
        const q = `'${e.zone}'`;
        if (!items.includes(q)) items.push(q);
        return `${a}${items.join(', ')}${c}`;
      }),
  },
  {
    name: 'register-error-code', region: 'ERROR_HANDLERS',
    match: () => true, // fallback: any unknown recurring code gets a safe default handler
    patch: (body, e) => body.replace(
      /(const KNOWN_ERROR_CODES = \[)([^\]]*)(\];)/,
      (_, a, mid, c) => {
        const items = mid.split(',').map(s => s.trim()).filter(Boolean);
        const q = `'${e.code}'`;
        if (!items.includes(q)) items.push(q);
        return `${a}${items.join(', ')}${c}`;
      }),
  },
];

function selectRecipe(entry) {
  if (!entry || entry.count < AUTOPATCH_THRESHOLD) return null;
  return RECIPES.find(r => r.match(entry)) || null;
}

// Backs up, patches the recipe's region, runs `node --check`; rolls back on parse failure.
// Process restart + connect-verification rollback is handled by the caller (bot.js).
function applyRecipe(recipe, { sourcePath, backupDir, entry }) {
  const original = fs.readFileSync(sourcePath, 'utf8');
  const stamp = Date.now();
  const backup = path.join(backupDir, `${path.basename(sourcePath)}.bak.${stamp}`);
  fs.writeFileSync(backup, original);
  try {
    const start = `// === AUTOPATCH:${recipe.region}:START ===`;
    const end = `// === AUTOPATCH:${recipe.region}:END ===`;
    const si = original.indexOf(start), ei = original.indexOf(end);
    if (si === -1 || ei === -1) throw new Error(`region ${recipe.region} not found`);
    const body = original.slice(si + start.length, ei).replace(/^\n|\n$/g, '');
    const newBody = recipe.patch(body, entry);
    const patched = replaceRegion(original, recipe.region, newBody);
    fs.writeFileSync(sourcePath, patched);
    execFileSync(process.execPath, ['--check', sourcePath]); // throws on parse error
    return { ok: true, backup, recipe: recipe.name };
  } catch (err) {
    fs.writeFileSync(sourcePath, original); // rollback
    return { ok: false, error: String(err && err.message || err), backup };
  }
}
```

Update `module.exports` to:

```js
module.exports = { replaceRegion, bumpConstant, RateLimiter, RECIPES, selectRecipe, applyRecipe, AUTOPATCH_THRESHOLD };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/autopatch.test.js`
Expected: PASS — all autopatch tests (helpers + recipes).

- [ ] **Step 5: Commit**

```bash
git add autopatch.js test/autopatch.test.js
git commit -m "feat: add AutoPatch recipes, selectRecipe, applyRecipe with node --check gate"
```

---

## Task 5: Add `test` script + full suite green

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the test script**

In `package.json` `"scripts"`, add:

```json
"test": "node --test test/"
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all errorbus + selfheal + autopatch tests.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add npm test script for self-fix module suite"
```

---

## Task 6: bot.js — introduce AUTOPATCH marked regions + constants

This task makes `bot.js` patchable and centralizes the constants the recipes target. No behavior change yet beyond using named constants.

**Files:**
- Modify: `bot.js` (constants area near top, ~line 60-70; connection setup ~1107; disconnect handler ~1432-1438)

- [ ] **Step 1: Add the marked regions**

Near the top constants block (e.g. just after `const FISHING_TIMEOUT = 120000;` at line ~66), insert:

```js
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
```

- [ ] **Step 2: Wire the constants into existing code**

In the disconnect handler (~line 1436), replace the hardcoded 30s:

```js
    notifySys(`🔴 <b>Disconnected</b> — auto-reconnect in ${Math.round(RECONNECT_BACKOFF_MS/1000)}s`);
    scheduleStart(RECONNECT_BACKOFF_MS);
```

Find where REST timeout is applied (grep `timeout` in the `apiGet`/`https` request code) and replace the hardcoded request-timeout literal with `REST_TIMEOUT`; replace the auth request timeout literal with `AUTH_TIMEOUT`. (Search: `grep -n "timeout" bot.js` — there is a 20s REST timeout added previously.)

- [ ] **Step 3: Verify the file still parses and boots**

Run: `node --check bot.js`
Expected: no output (valid).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "refactor: add AUTOPATCH marked regions + named timeout/reconnect/zone constants"
```

---

## Task 7: bot.js — route all errors through ErrorBus + apply self-heal

**Files:**
- Modify: `bot.js` (requires ~line 1-9; error handlers ~1178-1205; wrong-zone ~1031; require new modules)

- [ ] **Step 1: Require the modules + construct singletons**

After line 9 (`const crypto = ...`), add:

```js
const { ErrorBus, signature } = require('./errorbus');
const selfheal = require('./selfheal');
const autopatch = require('./autopatch');
const path = require('path');

const errorBus = new ErrorBus(path.join(__dirname, 'errors.json'));
const patchLimiter = new autopatch.RateLimiter(10*60000, 60*60000, 1, 3);
```

- [ ] **Step 2: Add a single `reportError` helper (place near `log`, ~line 24)**

```js
// Central error capture + self-heal + autopatch trigger.
function reportError({ code, context, expected, zone, category }) {
  // counter split: connection noise is NOT a farming error
  if (category === 'reconnect') { stats.reconnects = (stats.reconnects||0) + 1; }
  else { stats.errors++; stats.consecutiveErrors++; }

  const entry = errorBus.record({ code, context, expected, zone });

  // Layer 2: runtime self-heal
  const action = selfheal.decide({ code: errorBus.get(signature({code,expected,zone})).code, zone, count: entry.count });
  if (action) {
    applySelfHeal(action);
    errorBus.setStatus(entry.sig, 'self-healed', action.type);
  }

  // Layer 3: autopatch (guarded) for recurring patch-able patterns
  const recipe = autopatch.selectRecipe({ code: entry.code, zone, count: entry.count });
  if (recipe && entry.status !== 'patched' && patchLimiter.tryAcquire(Date.now())) {
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
```

- [ ] **Step 3: Replace the raw `stats.errors++` sites with `reportError`**

- `mining:error` (~1178):
```js
  socket.on('mining:error', (d) => {
    reportError({ code: d.code, context: `mining ${d.code}` });
    if(d.code !== 'COOLDOWN') log(`⛏ ERR:${d.code}`);
  });
```
- `fishing:error` (~1190):
```js
  socket.on('fishing:error', (d) => { fishingActive = false; reportError({ code: d.code, context: `fishing ${d.code}`, zone }); log(`🎣 ERR:${d.code}`); });
```
- `combat:error` (~1201): replace leading `stats.errors++; stats.consecutiveErrors++;` with `reportError({ code: d.code, context: \`combat ${d.code}\` });`
- WRONG_ZONE (~1031): after `log('⚠️ WRONG ZONE...')`, replace `stats.wrongZone++;` with:
```js
      stats.wrongZone++;
      reportError({ code: 'WRONG_ZONE', expected, zone, context: `expected ${expected}, got ${zone}` });
```
- disconnect handler (~1433): add `reportError({ code: reason.replace(/\s+/g,'_'), context: 'socket disconnect', category: 'reconnect' });`
- connect_error / auth-timeout sites: `reportError({ code: 'AUTH_TIMEOUT', context: 'auth request timeout', category: 'reconnect' });` for the auth-timeout path; `reportError({ code: err.message||'connect_error', context: 'connect_error', category: 'reconnect' });` in `connect_error`.

- [ ] **Step 4: Make zone selection honor the blacklist**

Where the bot picks a fishing/mining target zone/waypoints, skip blacklisted zones. Minimal version — in the WRONG_ZONE retry block (~1038), if the *expected* zone is itself blacklisted, skip cycle immediately:

```js
      if (ZONE_BLACKLIST.includes(expected)) { log(`⛔ ${expected} blacklisted — skip`); setTimeout(()=>runNextCycle(sock),2000); return; }
```

- [ ] **Step 5: Verify parse**

Run: `node --check bot.js`
Expected: valid.

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat: route all errors through ErrorBus + apply runtime self-heal"
```

---

## Task 8: bot.js — runAutoPatch with restart + connect-verification rollback

**Files:**
- Modify: `bot.js`

- [ ] **Step 1: Add `runAutoPatch` (near `reportError`)**

The bot runs under systemd `Restart=always`, so applying a patch then `process.exit(0)` triggers a restart into the patched code. Verification + rollback uses a sentinel file checked at boot.

```js
const BACKUP_DIR = path.join(__dirname, '.autopatch-backups');
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}
const PENDING_PATCH = path.join(__dirname, '.autopatch-pending.json');

function runAutoPatch(recipe, entry) {
  const res = autopatch.applyRecipe(recipe, { sourcePath: path.join(__dirname,'bot.js'), backupDir: BACKUP_DIR, entry });
  if (!res.ok) {
    log(`🔧 autopatch ${recipe.name} FAILED parse-check — not applied (${res.error})`);
    notify(`🔧 <b>AutoPatch aborted</b>\nRecipe: ${recipe.name}\nError: ${res.error}`);
    return;
  }
  // record a pending patch so the next boot can verify connect within 60s
  fs.writeFileSync(PENDING_PATCH, JSON.stringify({ recipe: recipe.name, sig: entry.sig, backup: res.backup, at: Date.now() }));
  errorBus.setStatus(entry.sig, 'patched', recipe.name);
  log(`🔧 autopatch ${recipe.name} applied → restarting to verify`);
  notify(`🔧 <b>AutoPatch applied</b>\nRecipe: ${recipe.name}\nError: ${entry.code} (×${entry.count})\nRestarting to verify…`);
  setTimeout(() => process.exit(0), 1500); // systemd Restart=always brings it back patched
}

// Boot-time verification of any pending patch.
function verifyPendingPatchOnBoot() {
  let pend; try { pend = JSON.parse(fs.readFileSync(PENDING_PATCH,'utf8')); } catch { return; }
  const deadline = Date.now() + 60000;
  const iv = setInterval(() => {
    if (connected) {
      clearInterval(iv);
      try { fs.unlinkSync(PENDING_PATCH); } catch {}
      log(`✅ autopatch ${pend.recipe} verified (connected)`);
      notify(`✅ <b>AutoPatch verified</b>: ${pend.recipe} — connection OK`);
    } else if (Date.now() > deadline) {
      clearInterval(iv);
      // rollback
      try {
        fs.copyFileSync(pend.backup, path.join(__dirname,'bot.js'));
        fs.unlinkSync(PENDING_PATCH);
        log(`↩️ autopatch ${pend.recipe} ROLLED BACK (no connect in 60s)`);
        notify(`↩️ <b>AutoPatch rolled back</b>: ${pend.recipe} — no connect in 60s. Restarting clean.`);
        setTimeout(() => process.exit(0), 1500);
      } catch (e) { log('rollback error: ' + e.message); }
    }
  }, 3000);
}
```

- [ ] **Step 2: Call `verifyPendingPatchOnBoot()` at startup**

Find the bot's main startup (where `scheduleStart()` / dashboard start is called near the bottom) and add `verifyPendingPatchOnBoot();` once at boot.

- [ ] **Step 3: Verify parse**

Run: `node --check bot.js`
Expected: valid.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: autopatch apply + restart with boot-time connect-verification rollback"
```

---

## Task 9: bot.js — `/selfix`, enriched `/errors`, split `/status`, ledger fix

**Files:**
- Modify: `bot.js` (commands ~1686-1740; status builder ~1489; ledger ~1297; help list ~1650)

- [ ] **Step 1: Fix the ledger bug (~line 1297)**

The real field names are wrong. Make it defensive so it never logs `undefined:0`:

```js
      const recent = d.entries.slice(0, 5);
      const fmtEntry = e => `${e.type||e.kind||e.reason||'entry'}:${e.amount??e.delta??e.value??0}`;
      log(`📊 Ledger: ${d.entries.length} entries, recent: ${recent.map(fmtEntry).join(', ')}`);
```

- [ ] **Step 2: Split errors vs reconnects in `/status` (~line 1489)**

Replace the errors line in `buildStatusText()`:

```js
    `${stats.errors ? '⚠️' : '✅'} errors ${stats.errors}   🔌 reconnects ${stats.reconnects||0}   🌀 wrongzone ${stats.wrongZone}`,
```

- [ ] **Step 3: Enrich `/errors` (~line 1729)**

Append a KB summary to the existing `/errors` reply:

```js
tg.on('errors', () => {
  const errs = LOG_RING.filter(l => /ERR|❌|💥|⚠️|fail/i.test(l)).slice(-12);
  const top = errorBus.top(5).map(e => `${e.code} ×${e.count} [${e.status}]${e.lastAction?' '+e.lastAction:''}`);
  notify(
    `🧯 <b>Errors (KB top 5)</b>\n<pre>${top.join('\n') || 'none'}</pre>\n` +
    `<b>Recent log</b>\n<pre>${errs.join('\n').slice(0,1500) || 'none'}</pre>`
  );
});
```

- [ ] **Step 4: Add `/selfix` command**

Near the other `tg.on(...)` handlers:

```js
tg.on('selfix', () => {
  const top = errorBus.top(5).map(e => `${e.code} ×${e.count} [${e.status}]`);
  let pend = 'none'; try { pend = JSON.parse(fs.readFileSync(PENDING_PATCH,'utf8')).recipe; } catch {}
  const backups = (() => { try { return fs.readdirSync(BACKUP_DIR).length; } catch { return 0; } })();
  notify([
    `🩺 <b>Self-Fix</b>`,
    '<pre>',
    `Blacklisted zones  ${ZONE_BLACKLIST.join(', ') || 'none'}`,
    `Reconnect backoff  ${RECONNECT_BACKOFF_MS}ms`,
    `Pending patch      ${pend}`,
    `Backups kept       ${backups}`,
    `Known KB signatures ${errorBus.all().length}`,
    '</pre>',
    `<b>Top signatures</b>`,
    '<pre>' + (top.join('\n') || 'none') + '</pre>',
  ].join('\n'));
});
```

- [ ] **Step 5: Add `/selfix` to the help list (~line 1650)**

Add `'/selfix — status self-fix system',` to the help command array.

- [ ] **Step 6: Verify parse**

Run: `node --check bot.js`
Expected: valid.

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: /selfix command, enriched /errors KB, split status counters, fix ledger log"
```

---

## Task 10: Live deploy + manual verification

**Files:** none (operational)

- [ ] **Step 1: Run full unit suite**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 2: Restart the service**

Run: `systemctl restart owntown-bot.service && sleep 5 && systemctl is-active owntown-bot.service`
Expected: `active`.

- [ ] **Step 3: Confirm boot + capture working**

Run: `journalctl -u owntown-bot.service -n 40 --no-pager`
Expected: clean boot, no parse error, normal farming logs.

- [ ] **Step 4: Confirm KB file is being written**

Run: `cat /root/owntown-farming-bot/errors.json | head -40`
Expected: JSON with at least one signature once an error/disconnect occurs.

- [ ] **Step 5: Verify Telegram commands**

In Telegram, send `/status` (shows split errors/reconnects/wrongzone), `/errors` (shows KB top 5), `/selfix` (shows blacklist/backoff/pending/backups).
Expected: all three reply with the new format.

- [ ] **Step 6: Final commit (if any config tweaks)**

```bash
git add -A && git commit -m "chore: self-fix system live verification" || echo "nothing to commit"
```

---

## Notes for the implementer

- **Zero new dependencies.** Tests use built-in `node:test`. Do not add jest/mocha.
- **Never edit the live `bot.js` from a test** — recipe tests operate on tmp fixtures only (Task 4 already does this).
- **systemd is the restart mechanism** for autopatch verification — `Restart=always` is already set on `owntown-bot.service`. Do not add a custom respawn loop.
- The bot is local-only (user chose skip GitHub); commits stay local.
- If a grep-based line reference has drifted, search by the quoted code snippet rather than trusting the line number.
