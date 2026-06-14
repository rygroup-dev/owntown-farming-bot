// autopatch.js — rule/template patch engine + guardrails (Layer 3)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
    patch: (body, e) => {
      if (/['\\]/.test(e.zone)) return body;   // blacklist-zone: skip unsafe zone names
      return body.replace(
      /(const ZONE_BLACKLIST = \[)([^\]]*)(\];)/,
      (_, a, mid, c) => {
        const items = mid.split(',').map(s => s.trim()).filter(Boolean);
        const q = `'${e.zone}'`;
        if (!items.includes(q)) items.push(q);
        return `${a}${items.join(', ')}${c}`;
      });
    },
  },
  // Catch-all fallback — MUST remain LAST in RECIPES (later entries would be unreachable).
  {
    name: 'register-error-code', region: 'ERROR_HANDLERS',
    match: () => true, // fallback: any unknown recurring code gets a safe default handler
    patch: (body, e) => {
      if (/['\\]/.test(e.code)) return body;   // register-error-code: skip unsafe codes
      return body.replace(
      /(const KNOWN_ERROR_CODES = \[)([^\]]*)(\];)/,
      (_, a, mid, c) => {
        const items = mid.split(',').map(s => s.trim()).filter(Boolean);
        const q = `'${e.code}'`;
        if (!items.includes(q)) items.push(q);
        return `${a}${items.join(', ')}${c}`;
      });
    },
  },
];

function selectRecipe(entry) {
  if (!entry || entry.count < AUTOPATCH_THRESHOLD) return null;
  return RECIPES.find(r => r.match(entry)) || null;
}

// Backs up, patches the recipe's region, runs `node --check`; rolls back on parse failure.
// Process restart + connect-verification rollback is handled by the caller (bot.js).
function applyRecipe(recipe, { sourcePath, backupDir, entry, maxBackups = 10 }) {
  const original = fs.readFileSync(sourcePath, 'utf8');
  const stamp = Date.now();
  const backup = path.join(backupDir, `${path.basename(sourcePath)}.bak.${stamp}`);
  let sourceMutated = false;
  try {
    fs.writeFileSync(backup, original);
    const start = `// === AUTOPATCH:${recipe.region}:START ===`;
    const end = `// === AUTOPATCH:${recipe.region}:END ===`;
    const si = original.indexOf(start), ei = original.indexOf(end);
    if (si === -1 || ei === -1) throw new Error(`region ${recipe.region} not found`);
    const body = original.slice(si + start.length, ei).replace(/^\n|\n$/g, '');
    const newBody = recipe.patch(body, entry);
    const patched = replaceRegion(original, recipe.region, newBody);
    if (patched === original) { return { ok: true, noop: true, backup }; } // nothing changed → caller skips restart
    fs.writeFileSync(sourcePath, patched);
    sourceMutated = true;
    execFileSync(process.execPath, ['--check', sourcePath]); // throws on parse error
    pruneBackups(backupDir, path.basename(sourcePath), maxBackups);
    return { ok: true, backup, recipe: recipe.name };
  } catch (err) {
    if (sourceMutated) { try { fs.writeFileSync(sourcePath, original); } catch {} } // rollback
    return { ok: false, error: String(err && err.message || err), backup };
  }
}

// Keep only the `keep` most recent `<base>.bak.*` files in dir; delete older ones.
function pruneBackups(dir, base, keep) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.startsWith(base + '.bak.')); } catch { return; }
  if (files.length <= keep) return;
  files.sort(); // names end with Date.now() → lexical sort == chronological for equal-length timestamps
  for (const f of files.slice(0, files.length - keep)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}

module.exports = { replaceRegion, bumpConstant, RateLimiter, RECIPES, selectRecipe, applyRecipe, AUTOPATCH_THRESHOLD, pruneBackups };
