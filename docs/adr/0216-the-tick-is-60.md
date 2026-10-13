# ADR 0216 — The tick is 60 a second

Status: accepted. Step 3 of Kodjo's tick-rate plan: one rate for everyone, 60, after movement was made the same at
any step size (ADR 0215).

## Context

At 30 a second a step was 33 ms: a fast mover sliced every tick of a level (ADR 0104), key presses were read 30
times a second, and a character at its 280 m/s top moved 9 m a step. The client is authoritative for its own body and
the relay sends snapshots at its own 20 a second, so the tick costs each player's machine and a 25 B upstream state a
tick — nothing on the server.

## Decision

- **`TICK_RATE_HZ = 60`**, one number in `packages/core/src/tick.ts`, for every game.
- **Tests state time, not ticks**: a count written at 30 is a span of seconds (`T30(n)` in the controller's tests,
  `seconds · TICK_RATE_HZ` elsewhere).
- **A landing touches what it lands on** (amends ADR 0215): this tick's move ran into the probe's collider, or the
  deck came to us (`arrived`), or we ride it. ADR 0215's distance rule let a step end 2.7 cm clear of lava, be called
  landed, and jump away before the touch skin registered — at 60, every tenth fast landing on a sliced tick; and its
  "cut short" exception was the same hole. The controller's own `grounded`, 7 cm deep, is held to it too.
- **Off footing within the probe's reach, a press of `gravity · SETTLE_DT` m/s** — the 30 Hz tick's, as a speed — so
  a capsule put down at rest meets its floor.

Measured differences from 30, in the envelope: the walking step-up is the autostep's configured 0.40 m (0.45 at 30);
domes and logs hold to 50–60° from the crown (40–60°).

## Not measured

Frame time on a mid Android phone (budget 1) — Kodjo's, on a device. Upstream doubles, 1.5 kB/s a player.
