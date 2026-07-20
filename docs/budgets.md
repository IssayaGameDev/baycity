# Budgets (SEED §5)

Tripwires, not targets. Exceeding one is never resolved silently — mitigation is
Kodjo's call (SEED §5). Staying comfortably under needs no conversation.

| # | Budget | Target | How measured | Status |
|---|---|---|---|---|
| 1 | Client frame time | ~16 ms/frame (mid Android) | on-device profiling (human, §8) | not yet measured |
| 2 | Downstream / client | ~20–30 kB/s | `@mp/bots` load harness | **~2.6 kB/s @ 20 bots — comfortable** |
| 3 | Server tick time | < 33 ms/room | room sim-interval under load | **avg 0.59 / max 1.28 ms @ 20 bots — comfortable** |
| 4 | Latency floor | 30–150 ms RTT + jitter | real-network playtests (human, §8) | design sliders (interp/rewind) |
| 5 | Client memory | ~1–1.5 GB | on-device (human, §8) | not yet measured |

## Load validation (budgets 2 & 3)

`pnpm --filter @mp/bots run load` (`BOTS`, `DURATION_MS` env). It starts a Colyseus server,
connects N headless `colyseus.js` bots that each `joinOrCreate('tps')` and report a synthetic
circular position at the tick rate, then reports downstream kB/s per client and room tick
avg/max. (This is also the live integration check — a Colyseus server can't boot under vitest.)

Latest (20 bots, 10 s window, this dev machine — Colyseus rooms, ADR 0011 + 0013):

```
budget 2  downstream/client:  avg 2.6 kB/s   max 2.6 kB/s   (target ~20–30 kB/s)
budget 3  server tick:        avg 0.59 ms    max 1.28 ms    (target < 33 ms)
```

Both comfortably under. Tick time is a touch higher than the bare relay (0.33 / 1.07 ms) from
Colyseus's matchmaking/room overhead; still ~25× under budget. (For reference, the original
server-authoritative stack was avg 0.47 / max 9.54 ms — the physics step dominated the max.)

### Caveats

- **Single process:** bots + server share one event loop, so tick timings include some
  contention. With no server physics the steady-state tick is sub-millisecond. Separate-process
  bots would give cleaner isolation — a later refinement.
- **Payload bytes only:** budget 2 counts our relayed snapshot payload (via `onMessage`), not
  Colyseus's per-message framing or WS/TCP/IP overhead (a few more bytes × 20 Hz). Still well under.
- Every bot moves continuously, so each peer changes in every snapshot — worst case for the
  delta (nothing culled as resting). Idle players would send less. Per-entity cost is
  8 B/entity/snapshot.
- **Upstream** grew (14 B state vs the old 9 B input) but is not a tracked budget.
- Budgets 1, 4, 5 are device/network-bound and human-owned (SEED §8); not measured here.
