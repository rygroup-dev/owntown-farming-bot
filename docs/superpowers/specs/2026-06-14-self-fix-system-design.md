# Self-Fix System — Owntown Farming Bot

**Date:** 2026-06-14
**Status:** Approved (design), pending implementation plan

## Problem

`/status` reports `errors 27 · wrongzone 26`. Root-cause analysis of `/tmp/owntown_v23.log`:

- **Disconnect loop is the dominant error source.** Socket drops every ~1–2 min with `ping timeout` / `transport error`, then reconnect + re-auth; each drop and auth-timeout increments `stats.errors`. Most of the 27 "errors" are reconnects, not farming failures. Persists despite `transports:['polling'], upgrade:false`.
- **WRONG_ZONE is a downstream symptom.** After a reconnect the player respawns in `spawn_plaza`/`residential`; the bot then sees the wrong zone for its mining/fishing target and skips the cycle (it does recover via waypoint navigation, but each occurrence counts).
- **Ledger log bug** (bot.js:1297): `recent: undefined:0 ...` — wrong field names on ledger entries.
- **No durable error capture.** Errors live only in counters + the rolling log, so new/unhandled error classes get "missed" — never triaged, never fixed.

## Goal

A deterministic (no-LLM) hybrid self-fix system so errors are never silently missed, known problems self-heal at runtime, and recurring patch-able problems get auto-patched into source — with strong guardrails because this is a live bot.

## Non-Goals

- No LLM/Claude API in the loop (explicit user choice; deterministic rule/template only).
- No arbitrary code generation. Patches are parameterized edits to marked source regions only.
- No human-in-the-loop approval gate (user opted for autonomous auto-patch + restart).

## Architecture — 3 layers

```
Error occurs
   │
   ▼
[1] ErrorBus  → classify (signature = code + context + zone)
   │            persist to errors.json (pattern, freq, first/last seen, status)
   ▼
[2] Self-Heal (runtime, NO source edit)
   │   known pattern → adjust behavior/config live
   │   (re-navigate, blacklist zone, change backoff, skip cycle)
   ▼  (recurring + a source-level recipe matches)
[3] AutoPatch (rule/template → edit bot.js + restart)
       guardrail: backup → node --check → apply → restart
                  → verify connect ≤60s → rollback on failure
                  → Telegram notify every patch
```

### Layer 1 — ErrorBus + Knowledge Base
Single entry point for every error. Each error gets a stable **signature** (`code` + normalized context + zone). Persisted to `errors.json`:
```json
{
  "<signature>": {
    "code": "WRONG_ZONE",
    "sampleContext": "expected pond, got residential",
    "count": 26,
    "firstSeen": "2026-06-14T10:01:23Z",
    "lastSeen": "2026-06-14T11:06:03Z",
    "status": "self-healed | unhandled | patched",
    "lastAction": "blacklist-zone:residential"
  }
}
```
This guarantees no error is missed: everything is recorded with frequency + context.

### Layer 2 — Self-Heal (runtime, no source edit)
Known patterns trigger live behavior/config adjustments without touching source. Initial healers:
- consecutive `WRONG_ZONE` → force re-navigate + temporarily avoid the bad zone when picking targets
- `ping timeout` / `transport error` streak → adjust reconnect backoff (runtime var, capped)
- fishing/mining timeout → skip cycle cleanly (no crash)

### Layer 3 — AutoPatch (rule/template engine)
When a pattern is recurring and matches a recipe that needs a source change, the bot edits `bot.js` itself and restarts. Each patch edits a **marked, enclosed region** (e.g. `// === AUTOPATCH:TIMEOUTS ===`) for safe, idempotent, position-independent edits.

Initial recipes:

| Recipe | Trigger | Patch action |
|--------|---------|--------------|
| `bump-timeout` | `request timeout` / `auth timeout` recurring ≥N | raise REST/auth timeout constant stepwise, capped |
| `tune-reconnect` | `ping timeout` / `transport error` high streak | adjust backoff (and optionally try alt transport), capped |
| `register-error-code` | unhandled error `code` appears | auto-register a default handler (log + count + skip, no crash) |
| `blacklist-zone` | `WRONG_ZONE` to zone X recurring | add X to avoided-zones list when picking targets |

New recipes are easy to add later.

## Guardrails (mandatory)

- Backup `bot.js` → `bot.js.bak.<ts>` before every patch.
- `node --check` the patched file; parse failure → abort + restore.
- Apply → restart → wait for connect; **crash or no-connect within 60s → auto-rollback** to backup + Telegram notify.
- **Rate-limit:** max 1 auto-patch / 10 min, max 3 / hour (anti patch-storm).
- Every patch → Telegram notify: recipe, error signature, result (success/rollback).
- Keep N most recent backups; prune older.

## Direct fixes (bundled)

1. **Split `disconnect` vs `error` counters.** `ping timeout` / `transport error` → `reconnects` category, not `errors`. `/status` becomes honest.
2. **Stabilize connection** via the `tune-reconnect` path (higher tolerance + controlled backoff).
3. **WRONG_ZONE** drops once connection stabilizes; plus `blacklist-zone` self-heal + forced re-navigate.
4. **Ledger bug** (bot.js:1297): fix `e.type` / `e.amount` field access.

## New / changed commands

- `/selfix` — self-fix system status: layer health, last patch, rollback history.
- `/errors` — enriched: top signatures + status (handled / self-healed / patched / unhandled).
- `/status` — shows split `errors` vs `reconnects`.

## Files

- `errorbus.js` (new) — classification, signature, `errors.json` persistence, KB API.
- `selfheal.js` (new) — runtime healers (Layer 2).
- `autopatch.js` (new) — recipe engine + guardrails (Layer 3).
- `bot.js` — route all errors through ErrorBus; add AUTOPATCH marked regions; wire `/selfix`, enrich `/errors`/`/status`; fix ledger bug.

## Testing

- Unit-level: signature stability, KB persistence round-trip, each recipe's patch produces parse-valid output (`node --check`), rate-limiter, rollback-on-bad-patch.
- Recipe patches tested against a fixture copy of `bot.js`, never the live file.
- Manual: trigger a synthetic unhandled error code → verify capture → verify recipe patch + auto-rollback path with a deliberately-bad patch.
