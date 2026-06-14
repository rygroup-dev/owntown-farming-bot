// ============ CONFIG / ENV LOADER (zero-dependency) ============
// Loads .env into process.env (no external dotenv dependency) and exposes
// a typed config object used across the bot.
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const raw = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

// Persist a learned value back to .env (e.g. auto-detected Telegram chat id).
function persistEnv(key, value) {
  let raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(raw)) {
    raw = raw.replace(re, `${key}=${value}`);
  } else {
    if (raw.length && !raw.endsWith('\n')) raw += '\n';
    raw += `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, raw);
  process.env[key] = value;
}

const config = {
  // Wallet (game auth)
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
  walletAddress: process.env.WALLET_ADDRESS || '',
  walletFile: process.env.WALLET_FILE || '', // optional JSON file with {private_key}
  playerId: process.env.MY_PLAYER_ID || '',  // optional; auto-detected if blank

  // Telegram
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // Dashboard
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '8899', 10),
  dashboardKey: process.env.DASHBOARD_KEY || '',

  // Behaviour
  gameHost: process.env.GAME_HOST || 'owntown.fun',
  reportIntervalMin: parseInt(process.env.REPORT_INTERVAL_MIN || '30', 10),
  notifyProfitOnly: (process.env.NOTIFY_PROFIT_ONLY || 'true').toLowerCase() === 'true',

  // Anti-detection schedule (human-like online/offline pattern)
  scheduleEnabled: (process.env.SCHEDULE_ENABLED || 'true').toLowerCase() === 'true',
  scheduleRaw: process.env.SCHEDULE || 'on:18,off:2,on:1,off:3',
  scheduleJitterPct: parseInt(process.env.SCHEDULE_JITTER_PCT || '12', 10), // ±% randomization per phase

  // Dashboard login
  dashUser: process.env.DASH_USER || 'admin',
  dashPass: process.env.DASH_PASS || '',
  watchdogStuckMin: parseInt(process.env.WATCHDOG_STUCK_MIN || '5', 10),
  logPath: process.env.LOG_PATH || '/tmp/owntown_v23.log',
  tokenPath: process.env.TOKEN_PATH || '/tmp/owntown_token.txt',
};

module.exports = { config, persistEnv };
