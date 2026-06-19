# Owntown Farming Bot — Improvement Design

**Date:** 2026-06-19
**Status:** Approved design (Phase 1 actionable; Phase 2 roadmap)
**Approach:** A — Incremental + modular. Surgical edits in `bot.js`; pure helpers
extracted to `lib/` with unit tests, following the existing `lib/market.js` /
`lib/schedule.js` pattern. No big-bang rewrite.
**Risk profile:** Balanced — preserve current earning rate, harden real
ban-risk points without sacrificing throughput.

---

## Context / Audit Findings

Repo: `rygroup-dev/owntown-farming-bot`, branch `main`, HEAD `5893806` (v30.0.0),
working tree clean. Monolith `bot.js` (772 lines) + `config.js` + `telegram.js` +
`lib/market.js` + `lib/schedule.js`. Zero-dependency philosophy (socket.io-client,
tweetnacl, bs58 only). Single-wallet, Telegram-controlled.

Two critical live findings at audit time:

1. **Running process is stale v25, not the v30 on disk.** Live log shows
   `🟢 v25 ▶️ mining` while `package.json` is `30.0.0`. Service started at 08:52
   on old code → v30 never deployed. Resolved by the single restart at end of
   Phase 1 (user opted to wait, not restart early).
2. **Reconnect silently died for ~1h.** At 13:30:49 `Disconnected: io client
   disconnect` (triggered by a burst of `OUT_OF_RANGE — mining` →
   `consecutiveErrors >= 10` → `sock.disconnect()`), then zero reconnect log
   until 14:22+, bot idle (`🔴 ⏳`) and not earning. The reconnect chain can die
   without surfacing anything.

Existing anti-ban that we KEEP and build on:
- Human-like online/offline schedule (`on:18,off:2,on:1,off:3`) + ±12% jitter.
- Movement jitter (step `250+rand(100)`ms, speed `0.4±0.03`, waypoint pauses
  `800+rand(400)`ms).
- Action-interval jitter (`interval + rand(800) - 200`).
- Server-authority respect (`player:correction`, `player:state`, `WRONG_ZONE`).
- Flip/powerup cooldowns, `balanceReserve`, `dailyBuyCap`.
- "1 wallet = 1 session" discipline.

---

## Phase 1 — Stability & Anti-ban (deploy + single restart at end)

### Stability

**S1 — Reconnect supervisor (fix silent death).**
Root cause: after `consecutiveErrors >= 10` the bot calls `sock.disconnect()` and
the retry chain can stop re-arming; the watchdog only acts when `idle > 10min`
and resets `lastActivity` itself, so it can miss a dead-reconnect state.
- Add a lightweight supervisor interval (~60s) that GUARANTEES: when
  `!connected && !stopped && !paused && schedule == ON && no retryTimer pending`,
  force `scheduleStart(...)`.
- Log every reconnect attempt explicitly (e.g. `🔁 reconnect attempt #n`) so a
  stuck state is always visible in logs/Telegram `/health`.
- Acceptance: induce a disconnect; bot reconnects within the backoff window and
  every attempt is logged. No silent idle > 2× backoff while schedule is ON.

**S2 — OUT_OF_RANGE mining guard.**
Before `emit('mining:start')`, check distance `pos → node.pos`. If out of range:
do NOT spam-emit; re-walk to the node once, retry; if still failing, skip to the
next node. Fixes both the error→disconnect cascade (stability) and the
rapid-fire emit signature (anti-ban).
- Acceptance: when positioned away from a node, the bot re-walks instead of
  emitting repeated `mining:start`; `OUT_OF_RANGE` bursts disappear from logs.

### Anti-ban (balanced)

**A1 — Online-pattern humanization.**
Break the long continuous online block into smaller segments with larger jitter,
and add randomized intra-session micro-breaks: at randomized intervals, insert a
short idle pause (default 30s–3min) where the bot stands still. Configurable via
env; defaults modest so earning is barely affected.
- Acceptance: logs show occasional idle micro-breaks; no fixed continuous 18h
  grind signature; throughput drop < ~5%.

**A2 — Non-deterministic activity rotation.**
Replace the fixed `order` array (perfectly periodic mining→fishing→combat) with
weighted-random selection among eligible activities, still honoring the
heal/sell/eat/quest priorities. Pure function, unit-tested.
- Acceptance: activity sequence is non-periodic across cycles; priority
  overrides still fire deterministically when conditions are met.

**A3 — Transport match.**
Investigate whether the real owntown.fun web client uses `polling` or upgrades to
`websocket`. Match it. The bot currently forces `polling`-only with
`upgrade:false`, which can be MORE conspicuous than a normal client. Investigate
first, then decide — do not change blindly.
- Acceptance: transport config matches observed real-client behavior, documented
  in the implementation notes.

### Testing & Deployment (Phase 1)
- Pure helpers (distance check, weighted activity pick, micro-break scheduling)
  → unit tests in `test/` (`node --test`).
- Reconnect supervisor → verified via logs after restart.
- Deploy order: `commit → push → deploy to server → systemctl restart` ONCE.
  This restart also promotes the running process from stale v25 → v30 and
  validates the reconnect fix live.

### New / changed config (Phase 1)
- `MICROBREAK_ENABLED` (default true)
- `MICROBREAK_MIN_SEC` / `MICROBREAK_MAX_SEC` (default 30 / 180)
- `MICROBREAK_EVERY_CYCLES_MIN` / `_MAX` (randomized cadence)
- Possibly a tighter default `SCHEDULE` (smaller online segments) — keep override.

---

## Phase 2 — Smartness (roadmap; each module spec'd individually)

Each subsystem becomes its own `lib/` module + unit tests; `bot.js` stays the
orchestrator that calls them. Suggested order:

- **2a `lib/combat.js`** — fix `⚔0 kills`: select alive mob by distance +
  reward/level heuristic; ensure walk-into-range before attack (mirror S2 guard);
  integrate world-boss & PvP win/claim decisions.
- **2c `lib/orchestrator.js`** — replace fixed `decideNextAction()` with adaptive
  selection from real-time signals (high item price → farm it; HP/stamina; server
  population; active quest; tool durability). Composes cleanly with A2.
- **2b `lib/market-strategy.js`** (extend `market.js`) — deeper use of
  trend/depth/EMA: optimal sell timing (hold on `rising`+thin depth, release on
  `falling`), avoid dumping into shallow markets, selective flip, adaptive
  undercut (not flat 8%).
- **2d `lib/quest.js`** — dynamic quest handling from `quest:state` (drop the
  hardcoded 4-quest `QUEST_NEEDS` map); auto-equip best gear via
  `equipmentBonuses`/`equipment`; auto-claim rewards.

Order rationale: 2a fixes the most concrete defect (0 kills) first; 2c builds the
"brain"; 2b raises profit-per-item; 2d polishes progression. Each: spec → plan →
implement → test → deploy incrementally.

---

## Out of Scope (YAGNI)
- Full architectural rewrite of `bot.js` (declined; incremental modularization
  instead).
- Multi-wallet / multi-session (explicitly single-wallet by design).
- New external dependencies (keep zero-dep philosophy).
- Aggressive throughput maximization at the expense of ban risk (balanced profile).
