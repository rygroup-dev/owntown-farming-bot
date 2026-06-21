# Owntown Farming Bot

Automated `owntown.fun` farming bot with Telegram control and monitoring.

> **v33.0.0** — Tool-break resilience (auto-switches to fishing/combat + auto-repairs the pick instead of silently dying), zone coordinates re-verified against the live client, Candy Factory awareness (`candy:stake`/`candy:claim`), and connection-watchdog hardening. A fresh user only needs a Solana wallet key + a Telegram bot token (see install below).

## Features

- Solana wallet authentication via challenge-response
- `socket.io-client` game connection
- Mining, fishing, combat, and PvP activity loops
- Marketplace scanning with `MARKETPLACE` / `QUICKSELL` / `HOLD` decisions
- Telegram control, reporting, and remote maintenance commands
- Time-based online/offline scheduling
- Bank, candy, boss, world, market, trades, listings, inventory, and health commands

## Project Layout

```text
bot.js
telegram.js
config.js
lib/
test/
install.sh
owntown-bot.service
```

## Installation

### One-line install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/owntown-farming-bot/main/install.sh)
```

### Pinned release install

```bash
OWNTOWN_REF=v32.0.0 bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/owntown-farming-bot/main/install.sh)
```

### Manual install

```bash
git clone https://github.com/rygroup-dev/owntown-farming-bot.git
cd owntown-farming-bot
npm install
cp .env.example .env
```

Minimum `.env` values:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
TELEGRAM_BOT_TOKEN=123456:AA...
```

Run the bot:

```bash
npm start
```

## Telegram Commands

- `/help`
- `/start`
- `/stop`
- `/status`
- `/stats`
- `/balance`
- `/daily`
- `/income`
- `/wallet`
- `/quest`
- `/candy`
- `/boss`
- `/world`
- `/pvpboard`
- `/market`
- `/trades`
- `/listings`
- `/inventory`
- `/health`
- `/version`
- `/errors`
- `/settings`
- `/log`
- `/logs`
- `/pause`
- `/resume`
- `/reauth`
- `/ping`
- `/schedule`
- `/restart`
- `/update`

## Testing

```bash
npm test
```

The test suite covers syntax checks, Telegram command registration, market decision logic, and schedule parsing.

## Release Notes

- `v32.0.0`
  - Smarter combat (closest-alive targeting, walk-into-range) — fixes the 0-kills case.
  - Market sell-timing: briefly hold sellable items on rising, thin markets.
  - Adaptive activity weights driven by live market prices.
  - Keyword-inferred quest action so new quests work without code changes.
- `v31.0.0`
  - Reconnect supervisor guarantees the reconnect chain always re-arms (no more silent idle).
  - Mining/combat re-walk into range instead of spamming the action emit (fixes OUT_OF_RANGE bursts).
  - Anti-detection: randomized idle micro-breaks + weighted-random activity rotation.
  - Transport now allows the default polling→websocket upgrade to match a normal client.

### Upgrading from an older version (e.g. v25 → v32)

No new dependencies and all new settings have safe defaults, so upgrading is a pull + restart:

```bash
# Re-run the one-liner (it fetches, checks out latest main, npm installs, restarts the service):
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/owntown-farming-bot/main/install.sh)
# …or, if already installed, from Telegram just send:  /update
# …or manually:
cd ~/owntown-farming-bot && git pull --ff-only origin main && npm install --omit=dev && systemctl restart owntown-bot.service
```

Your `.env` is preserved (it is gitignored). Optional new knobs: `MICROBREAK_ENABLED`,
`MICROBREAK_MIN_SEC`, `MICROBREAK_MAX_SEC`, `MICROBREAK_EVERY_MIN`, `MICROBREAK_EVERY_MAX`.

- `v25.0.3`
  - Sync pinned installer/tag/docs with the latest upstream fixes.
  - Keep GitHub `main`, raw installer, and tagged install path aligned.
- `v30.0.0`
  - Add clearer runtime telemetry for reconnects, pause reasons, and current mode.
  - Add `/version` command so operators can verify build, channel, and last drop reason quickly.
  - Keep the bot easier to audit and operate during live maintenance windows.

## Notes

- This repository ships the currently implemented bot only.
- Keep `.env`, wallet credentials, and Telegram tokens private.
- Game-side API or protocol changes may require bot updates.
