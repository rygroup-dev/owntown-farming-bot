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
