# ADR 0006 — Clock sync and lag-compensated hits

Status: accepted (M5)

## Context

M5 adds lag-compensated hit validation (SEED §3): the server must test hit claims
against the state the shooter actually saw. That needs (a) client↔server clock sync
and (b) a server-side history of player positions.

## Decision

- **Clock sync via ping/pong** (`@mp/client/clockSync`): client sends `PING{clientTime}`
  every 250 ms; server replies `PONG{clientTime, serverTime}`; client estimates
  `offset = serverTime − (clientSend + rtt/2)`, smoothed (EMA). `serverNow()` drives
  both interpolation playback and hit-claim timestamps, so they stay consistent. This
  replaces the M4 interim snapshot-derived render clock.
- **Rewind ring buffer** (`@mp/server/rewind`): ~1 s of player positions, one frame
  per tick; `positionsAt(t)` interpolates between frames. Only players are recorded
  (the hit targets).
- **Lag-comp hit test:** client sends `FIRE{fireTimeMs = serverNow − interpolationDelay,
  origin, dir}`; the server clamps `fireTimeMs` to the rewind window, reconstructs
  positions there, ray-sphere tests (`hitScan`), and broadcasts `HIT`.
- **Max honored rewind = buffer length (1 s)** — a technical default. The precise clamp
  (and rejecting implausibly-old claims) is a design/anti-cheat slider; anti-cheat is
  deprioritized (SEED), so 1 s stands until revisited.
- **Hitscan only** (instant ray). Projectiles would need their own prediction — out of scope.

## Consequences / per-game cost

- Clock sync + rewind are generic stack pieces; a game gets lag comp by recording its
  hittable colliders and issuing `FIRE` claims. *What* is hittable and the rewind clamp
  are game/design choices.
- Position-only rewind (no rotation/shape animation) — fine for spherical colliders;
  revisit for oriented/animated hitboxes.

## Rejected

- **Snapshot-derived clock for hit timing** — too jittery for aligning claims; ping/pong
  gives a stable absolute offset.
- **Testing against present positions** — the "lag comp off" path; misses moving targets
  under latency, which is exactly what rewind fixes.
