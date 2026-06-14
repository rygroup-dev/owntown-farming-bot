# 🏭 Owntown Farming Bot v23.1

Full-featured automated farming bot for [Owntown.fun](https://owntown.fun) — a Solana-based MMO game.

## ⚡ Features

### Core Farming
- **Multi-node Mining** — Rotates through 8 Deepworks mining nodes automatically
- **Multi-monster Combat** — Rotates through 6 Redline monsters, handles NO_TARGET
- **Fishing** — Auto-fishing at Pond with timeout detection
- **Fatigue Detection** — Switches activity when fatigue multiplier drops below threshold
- **Auto Repair** — Repairs Pulse Pick when durability < 30

### Smart Economy
- **Market Intelligence** — Scans all marketplace listings, tracks prices, detects trends (rising/falling/stable)
- **Dynamic Pricing** — Undercuts best price by 8%, respects price floors
- **Smart Sell Decisions** — Marketplace vs QuickSell vs HOLD based on market depth and trends
- **Market Flipping** — Buys underpriced items (< 40% market value) with safety guards:
  - 60s cooldown between flips
  - Max 200 OTWN per flip
  - Min 50 OTWN profit after fees
  - Uses actual market price (not inflated floors)
- **sellAll** — Bulk sells low-value materials via terminal
- **Price Floor Protection** — Never sells below minimum prices

### Combat & PvP
- **PvP Arena** — Auto-queue, attack, claim rewards (requires Lv5+)
- **World Boss** — Auto-enter when boss spawns, auto-claim rewards
- **HP Management** — Auto-heal at clinic when HP < 50, eats food when available

### Property & Vehicles
- **Property System** — Buy, sell, park vehicles, save layouts
- **Vehicle Purchase** — Buy vehicles for faster movement

### Banking
- **Bank Integration** — Check bank status, deposit/withdraw OTWN
- **Bank Monitoring** — Tracks withdrawable balance, fees, daily limits

### Crafting
- **5 Crafting Recipes** — Rail Lance, Repair Kit, Tide Helm, Reef Plate, Dune Boots
- **Auto-Craft** — Crafts when materials are available

### Shop
- **Clinic Healing** — Auto-heal at clinic when HP is low
- **Food Buying** — Buy food from Food Row shop when inventory is low
- **Gear Buying** — Purchase gear from shop

### Social & Notifications
- **Chat Tracking** — Receives chat history
- **Whisper System** — Thread-based DMs tracked
- **Friend System** — Request/accept/decline/remove friends
- **Notification Tracking** — Monitors all notifications

### Infrastructure
- **Auto-Authentication** — REST API challenge-response, JWT refresh before expiry
- **Auto-Reconnect** — 30s reconnect on disconnect
- **Token Management** — Auto-refresh 1 min before expiry
- **Error Recovery** — Reconnects after 10 consecutive errors
- **Economy Ledger** — Tracks all transactions

## 📊 API Endpoints Used

### REST API (12 endpoints)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/challenge` | POST | Get auth challenge nonce |
| `/api/auth/verify` | POST | Verify signature, get JWT |
| `/api/auth/guest` | POST | Guest authentication |
| `/api/health` | GET | Server health check |
| `/api/profile` | POST | Update player profile |
| `/api/ads` | GET | Get billboard ads |
| `/api/ads/info` | GET | Ad submission info |
| `/api/ads/submit` | POST | Submit billboard ad |
| `/api/bank/status` | GET | Bank balance & limits |
| `/api/bank/deposit-info` | GET | Deposit instructions |
| `/api/bank/deposit` | POST | Deposit OTWN to bank |
| `/api/bank/withdraw` | POST | Withdraw OTWN from bank |

### Socket Events (65+ events)
| Category | Events |
|----------|--------|
| **Player** | `player:input`, `player:state`, `player:correction` |
| **Mining** | `mining:start`, `mining:result`, `mining:error` |
| **Fishing** | `fishing:cast`, `fishing:result`, `fishing:error` |
| **Combat** | `combat:attack`, `combat:result`, `combat:error`, `combat:drop` |
| **Marketplace** | `marketplace:update`, `marketplace:list`, `marketplace:result`, `marketplace:cancel`, `marketplace:buy`, `marketplace:quickSell`, `marketplace:sellAll` |
| **Inventory** | `inventory:update`, `inventory:use`, `inventory:repair`, `inventory:craft` |
| **Equipment** | `equipment:set`, `equipment:craftGear` |
| **Shop** | `shop:clinicHeal`, `shop:foodBuy`, `shop:gearBuy`, `shop:styleBuy`, `shop:result` |
| **Vehicle** | `vehicle:buy` |
| **Property** | `property:info`, `property:infoResult`, `property:buy`, `property:buyListed`, `property:sell`, `property:unlist`, `property:enter`, `property:exit`, `property:entered`, `property:result`, `property:saveLayout`, `property:park`, `property:unpark` |
| **PvP** | `pvp:queue`, `pvp:leave`, `pvp:attack`, `pvp:hit`, `pvp:state`, `pvp:leaderboard`, `pvp:leaderboardData`, `pvp:claim` |
| **World Boss** | `worldboss:enter`, `worldboss:leave`, `worldboss:state`, `worldboss:result`, `worldboss:claim` |
| **Economy** | `economy:ledger` |
| **Chat** | `chat:send`, `chat:message`, `chat:history` |
| **Whisper** | `whisper:send`, `whisper:msg`, `whisper:thread`, `whisper:threads` |
| **Friends** | `friend:request`, `friend:accept`, `friend:decline`, `friend:remove` |
| **Ads** | `ads:update` |
| **Notifications** | `notification`, `notification:read` |
| **Portal** | `portal:enter` |
| **Zone** | `zone:enter`, `world:snapshot` |
| **Spectator** | `spectator:follow` |
| **Toast** | `toast` |

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/ulsreall/owntown-farming-bot.git
cd owntown-farming-bot

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your wallet private key (base58)

# Run
npm start
```

## ⚙️ Configuration

Edit `.env`:
```env
WALLET_PRIVATE_KEY=your_base58_private_key_here
```

Or edit `bot.js` constants:
```javascript
const WALK_SPEED = 0.4;        // Movement speed (0.4 = realistic)
const DAILY_EARN_CAP = 5000;   // Daily earning cap
const CARRY_CAP = 56;          // Inventory stack limit
const LOW_DURABILITY = 30;     // Repair threshold
const FISHING_TIMEOUT = 120000; // 2 min fishing timeout
const UNDERCUT_PCT = 0.08;     // 8% undercut on marketplace
const LOW_STAMINA = 30;        // Stamina threshold for food
const FATIGUE_THRESHOLD = 0.80; // Fatigue threshold for activity switch
const LOW_HP = 50;             // HP threshold for healing
```

## 📈 Profit Tracking

The bot tracks:
- QuickSell earnings
- Marketplace earnings
- PvP earnings
- Property earnings
- Market flips (count + profit)
- Items sold count
- OTWN/hour rate
- Inventory value (fish + materials)
- Held items (waiting for better prices)
- Bank balance

## 🛡️ Safety Features

- **Walk Speed 0.4** — Matches server anti-cheat threshold
- **Price Floors** — Never sells below minimum prices
- **Flip Guards** — Cooldown, max cost, min profit, market-price based
- **Fatigue Detection** — Prevents over-farming
- **Error Recovery** — Auto-reconnect on consecutive errors
- **Token Refresh** — Re-authenticates before expiry
- **Zone Verification** — Retries walk if wrong zone

## 🔧 How It Works

1. **Authenticates** via Solana wallet signature (challenge-response)
2. **Connects** via WebSocket (socket.io)
3. **Rotates** through: Mining → Fishing → Combat → PvP
4. **Sells** items via marketplace (high value) or quickSell (low value)
5. **Flips** underpriced marketplace listings
6. **Crafts** gear when materials available
7. **Heals** at clinic or with food when HP low
8. **Tracks** all activity in 10-min profit reports

## 📋 Cycle Order

```
Cycle 1: Mining (15 actions, 8 nodes)
Cycle 2: Fishing (5 actions, pond)
Cycle 3: Combat (5 actions, 6 monsters)
Cycle 4: PvP (3 actions, arena) [if Lv5+]
Cycle 5: Mining (next node)
Cycle 6: Fishing
Cycle 7: Combat (next monster)
Cycle 8: PvP
...repeat
```

## ⚠️ Disclaimer

This bot is for educational purposes. Use at your own risk. The authors are not responsible for any losses. Owntown.fun may change their API or anti-cheat systems at any time.

## 📄 License

MIT — See [LICENSE](LICENSE)

---

Built with ❤️ by [@itseywacc](https://x.com/itseywacc)
