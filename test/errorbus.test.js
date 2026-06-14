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

test('corrupt KB file (non-object JSON) falls back to empty object', () => {
  const file = path.join(os.tmpdir(), `kb-${Date.now()}-3.json`);
  fs.writeFileSync(file, JSON.stringify('not an object'));
  const bus = new ErrorBus(file);
  assert.deepStrictEqual(bus.all(), []);
  const e1 = bus.record({ code: 'PING_TIMEOUT' });
  assert.strictEqual(e1.count, 1);
  fs.unlinkSync(file);
});
