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
    try {
      const data = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) this.kb = data;
    } catch { this.kb = {}; }
  }
  _persist() {
    const tmp = this.path + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.kb, null, 2));
      fs.renameSync(tmp, this.path); // atomic
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
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
    // No-op if sig unknown: callers always setStatus a signature they just record()'d.
    if (this.kb[sig]) { this.kb[sig].status = status; this.kb[sig].lastAction = lastAction || this.kb[sig].lastAction; this._persist(); }
  }
}

module.exports = { signature, ErrorBus, normCode };
