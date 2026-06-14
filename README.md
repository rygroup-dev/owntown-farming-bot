# 🏝️ Owntown Farmer

Automated farming bot for **[Owntown.fun](https://owntown.fun)** — a coastal city economy MMO on Solana.

> ⚠️ **Disclaimer:** This bot is for educational purposes. Use at your own risk. The authors are not responsible for any losses.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| ⛏️ **Mining** | Multi-node mining with fatigue detection & auto-rotation |
| 🎣 **Fishing** | Auto-walk to fishing spot, timeout handling |
| ⚔️ **Combat** | Multi-monster combat with auto-rotation on NO_TARGET |
| 💰 **Smart Pricing** | Dynamic marketplace pricing — scans market, undercuts 10% |
| 🔄 **Auto-Reconnect** | Handles disconnects with exponential backoff |
| 🔑 **Auto-Reauth** | REST API challenge-response auth, auto-refresh before expiry |
| 📊 **Profit Tracking** | Real-time profit stats, rate/hour, marketplace sales |
| 🔨 **Auto-Craft** | Crafts Rail Lance & Repair Kit when materials available |
| 🍖 **Auto-Eat** | Eats food when stamina is low |
| 🔧 **Auto-Repair** | Repairs Pulse Pick when durability drops |

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/ulsreall/ometown-farmer.git
cd owntown-farmer
npm install
```

### 2. Set Up Wallet

**Option A: Wallet file (recommended)**
```bash
# Create wallet.json with your Solana wallet
cat > wallet.json << 'EOF'
{
  "address": "YOUR_WALLET_ADDRESS_HERE",
  "private_key": "YOUR_BASE58_PRIVATE_KEY_HERE"
}
EOF

# Protect it
chmod 600 wallet.json
```

**Option B: Environment variables**
```bash
cp .env.example .env
# Edit .env with your wallet details
```

### 3. Run

```bash
node bot.js
```

---

## 📁 Project Structure

```
ometown-farmer/
├── bot.js              # Main bot script
├── package.json        # Dependencies
├── .env.example        # Environment template
├── wallet.json         # Your wallet (DO NOT commit!)
├── .gitignore          # Protects sensitive files
├── LICENSE             # MIT License
└── README.md           # This file
```

---

## ⚙️ Configuration

Edit the constants at the top of `bot.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `WALK_SPEED` | 0.4 | Movement speed (m/s). Keep ≤0.5 to avoid anti-cheat |
| `DAILY_EARN_CAP` | 5000 | Daily earning cap (server-side) |
| `CARRY_CAP` | 56 | Inventory stack limit |
| `FISHING_TIMEOUT` | 25000 | ms to wait for fish bite |
| `MARKET_INTERVAL` | 3500 | ms between marketplace listings |
| `LOW_DURABILITY` | 30 | Repair tool below this durability |
| `LOW_STAMINA` | 25 | Eat food below this stamina |
| `STATUS_INTERVAL` | 600000 | Status report interval (10 min) |

---

## 🗺️ Map Reference

### Mining Nodes (8 nodes)
```
node_dw_1:  (75, -95)     node_dw_2:  (100, -95)
node_dw_3:  (120, -80)    node_dw_4:  (120, -60)
node_dw_5:  (100, -50)    node_dw_6:  (80, -50)
node_rim_1: (-30, -90)    node_rim_2: (-50, -110)
```

### Monsters (7 spawn points)
```
mon_1: (-100, -120)    mon_2: (-80, -100)    mon_3: (-120, -100)
mon_4: (-100, -140)    mon_5: (-120, -130)   mon_6: (-80, -130)
mon_8: (-100, -160)
```

### Fishing Spot
```
fish_dock: (-148.5, 0)   — walk through spawn_plaza → residential → pond
```

### Zone Map
```
spawn_plaza (center) → residential (west) → pond (far west)
                    → deepworks (east) → redline_a (south-east)
```

---

## 📊 Price Reference

### QuickSell Prices (instant)
| Item | Price |
|------|-------|
| Iron Shard | 2 |
| Raw Resonite | 6 |
| Circuit Scrap | 6 |
| Carbon Fiber | 2 |
| Silver Darter | 4 |
| Sun Carp | 50 |
| Moon Koi | 12 |
| Ember Skewer | 8 |
| Repair Kit | 5 |

### Marketplace Floors
| Item | Floor |
|------|-------|
| Circuit Scrap | 63 |
| Silver Darter | 57 |
| Sun Carp | 5,000 |
| Moon Koi | 1,000 |
| Resonance Core | 500,000 |

---

## 🔧 Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `BAD_TOKEN` / `NO_TOKEN` | Token expired | Bot auto-reauthenticates. If stuck, delete `/tmp/owntown_token.txt` and restart |
| `OUT_OF_RANGE` fishing | Wrong coordinates | Ensure fishing waypoint is (-148.5, 0) |
| `NO_TARGET` combat | Monster not spawned | Bot auto-rotates to next monster |
| `⚠️fatigue` | Mining too long | Fatigue reduces yield ~30%. Bot will cycle to fishing/combat |
| Balance drops fast | Listing fees | Marketplace listing costs ~9 OTWN/item. Disable auto-list if needed |
| Reconnect loop | Token invalid or server issue | Delete token file, restart bot |
| `COOLDOWN` errors | Action too fast | Bot handles these automatically |

---

## 🛡️ Security

- ⚠️ **NEVER** commit `wallet.json` or `.env` — they contain your private key
- ⚠️ The bot uses your **real wallet** — all transactions are on-chain
- ⚠️ Keep `chmod 600` on wallet files
- ⚠️ Use a **dedicated wallet** with minimal funds
- ⚠️ The bot respects daily earning caps and anti-cheat measures

---

## 📈 Strategy Tips

1. **Don't auto-list expensive items** — listing fees are ~1% of price
2. **List during peak hours** — more buyers online
3. **Undercut wisely** — 10% below best price is competitive
4. **Hold rare items** — Resonance Core, Permits appreciate over time
5. **Watch daily cap** — earnings reset at 00:00 UTC
6. **Manage fatigue** — rotate between mining/fishing/combat

---

## 📄 License

MIT License — see [LICENSE](LICENSE)

---

## 🙏 Credits

Built for the Owntown.fun community.

GitHub: [@ulsreall](https://github.com/ulsreall)
