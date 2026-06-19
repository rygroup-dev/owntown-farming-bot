# Owntown Farming Bot

Bot farming otomatis untuk `owntown.fun` dengan kontrol Telegram.

Repo ini saat ini masih berbentuk **monolith**:
- `bot.js` = logika utama bot
- `telegram.js` = integrasi Telegram Bot API
- `config.js` = loader `.env`

README ini sudah dirapikan supaya **sesuai implementasi real** di repo, bukan gabungan roadmap/claim lama.

## Status Repo

Yang benar-benar ada di repo:
- autentikasi wallet Solana via challenge-response
- koneksi game via `socket.io-client`
- loop aktivitas mining, fishing, combat, PvP
- marketplace scanning + smart sell decision
- quick sell untuk item tertentu
- kontrol dan monitoring lewat Telegram
- schedule on/off berbasis jam
- bank, candy, boss, world, market, trades, listings, inventory, health

Yang **tidak** ada sebagai modul terpisah:
- `errorbus.js`
- `selfheal.js`
- `autopatch.js`

Jadi kalau ada klaim self-fix/autopatch modular, itu **bukan kondisi repo saat ini**.

## Struktur

```text
bot.js
telegram.js
config.js
install.sh
owntown-bot.service
README.md
```

## Install

### One-line install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/owntown-farming-bot/main/install.sh)
```

Pinned stable release:

```bash
OWNTOWN_REF=v25.0.1 bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/owntown-farming-bot/main/install.sh)
```

### Manual

```bash
git clone https://github.com/rygroup-dev/owntown-farming-bot.git
cd owntown-farming-bot
npm install
cp .env.example .env
```

Isi minimal `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
TELEGRAM_BOT_TOKEN=123456:AA...
```

Lalu jalankan:

```bash
npm start
```

## Telegram Commands

Command yang benar-benar terdaftar di `bot.js` saat ini:

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

Total command handler aktif: **30**

## Fitur yang Terkonfirmasi

### Core gameplay
- mining
- fishing
- combat
- PvP queue/attack/result handling

### Economy
- scan harga marketplace
- decision `MARKETPLACE` / `QUICKSELL` / `HOLD`
- quick sell aman untuk item tertentu
- flip opportunity check
- powerup buy check
- profit tracking per jam

### Utility
- token refresh / reauth
- reconnect scheduling
- schedule on/off
- Telegram monitoring dan remote control

## Testing

Repo ini sekarang punya smoke test dasar untuk:
- syntax check file utama
- validasi command Telegram utama terdaftar
- validasi decision logic market + parser schedule

Jalankan:

```bash
npm test
```

## Catatan Arsitektur

Hal yang masih perlu diketahui:
- `bot.js` masih sangat besar dan menampung terlalu banyak tanggung jawab
- dokumentasi sebelumnya overclaim dibanding kode real
- refactor ideal berikutnya adalah memecah:
  - auth/api
  - market logic
  - activity loop
  - telegram commands
  - scheduling/state

## Rekomendasi Lanjutan

Kalau repo ini mau dibikin lebih sehat, urutan yang masuk akal:

1. pisahkan `bot.js` jadi modul-modul kecil
2. tambahkan unit test untuk market decision, schedule, dan Telegram command layer
3. bikin README tetap sinkron dengan implementasi real

## Disclaimer

Gunakan dengan risiko sendiri. Server game bisa berubah kapan saja dan membuat flow bot perlu disesuaikan lagi.
