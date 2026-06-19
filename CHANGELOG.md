# Changelog

## v32.0.0

- feat(combat): closest-alive targeting + walk-into-range (fixes 0-kills).
- feat(market): sell-timing hold on rising thin markets.
- feat(orchestrator): adaptive activity weights from live market prices.
- feat(quest): keyword-inferred quest action for unknown quests.

## v31.0.0

- fix(reconnect): supervisor guarantees the reconnect chain re-arms (no more silent idle).
- fix(mining): re-walk to node when out of range instead of spamming mining:start.
- feat(antiban): randomized idle micro-breaks between cycles.
- feat(antiban): weighted-random activity rotation (no periodic signature).
- chore(transport): allow default polling→websocket upgrade to match a normal client.

## v30.0.0

- Added safer operator telemetry around reconnect timing, pause reasons, and last disconnect cause.
- Added `/version` command for quick release/build visibility from Telegram.
- Promoted the repo to a clearer major milestone focused on readability, runtime control, and maintenance ergonomics.

## v25.0.3

- Synced pinned install instructions with the latest production fixes.
- Updated installer examples, README, package metadata, and smoke tests so tagged installs match the newest stable code.
