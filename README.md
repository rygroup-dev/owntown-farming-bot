# Owntown Farming Bot

Automated `owntown.fun` farming bot with Telegram control and monitoring.

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
OWNTOWN_REF=v25.0.2 bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/owntown-farming-bot/main/install.sh)
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

## Notes

- This repository ships the currently implemented bot only.
- Keep `.env`, wallet credentials, and Telegram tokens private.
- Game-side API or protocol changes may require bot updates.
