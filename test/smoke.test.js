const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { toPlainTelegramText } = require('../telegram');

const ROOT = path.join(__dirname, '..');
const MAIN_FILES = ['bot.js', 'telegram.js', 'config.js'];
const EXPECTED_COMMANDS = [
  'help', 'start', 'stop', 'status', 'stats', 'balance', 'daily', 'income',
  'wallet', 'quest', 'candy', 'boss', 'world', 'pvpboard', 'market', 'trades',
  'listings', 'inventory', 'health', 'errors', 'settings', 'log', 'logs',
  'pause', 'resume', 'reauth', 'ping', 'schedule', 'restart', 'update',
];

test('main source files pass node syntax check', () => {
  for (const file of MAIN_FILES) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  }
});

test('package metadata matches project identity', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'owntown-farmer');
  assert.equal(pkg.version, '25.0.0');
});

test('telegram command handlers match documented command surface', () => {
  const botJs = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8');
  const commands = [...botJs.matchAll(/tg\.on\('([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(commands, EXPECTED_COMMANDS);
});

test('telegram html fallback strips unsafe tags from runtime errors', () => {
  const raw = '⚠️ Error menjalankan /server: Unexpected token \'<\', "<!doctype html>" is not valid JSON';
  assert.equal(
    toPlainTelegramText(raw),
    '⚠️ Error menjalankan /server: Unexpected token \'" is not valid JSON'
  );
});
