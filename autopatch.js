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
