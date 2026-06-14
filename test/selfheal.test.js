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
