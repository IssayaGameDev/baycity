# Budgets (SEED §5)

Tripwires, not targets. Exceeding one is never resolved silently — mitigation is
Kodjo's call (SEED §5). Staying comfortably under needs no conversation.

| # | Budget | Target | How measured | Status |
|---|---|---|---|---|
| 1 | Client frame time | ~16 ms/frame (mid Android) | on-device profiling (human, §8) | not yet measured |
| 2 | Downstream / client | ~20–30 kB/s | `@mp/bots` load harness | **~2.8 kB/s @ 20 bots — comfortable** |
| 3 | Server tick time | < 33 ms/room | server `stats()` under load | **avg 0.33 / max 1.07 ms @ 20 bots — comfortable** |
| 4 | Latency floor | 30–150 ms RTT + jitter | real-network playtests (human, §8) | design sliders (interp/rewind) |
| 5 | Client memory | ~1–1.5 GB | on-device (human, §8) | not yet measured |

## Load validation (budgets 2 & 3)

`pnpm --filter @mp/bots run load` (`BOTS`, `DURATION_MS` env). It starts a relay server,
connects N headless bots that each report a synthetic circular position at the tick rate
over the real wire, then reports downstream kB/s per client and server tick avg/max.

Latest (20 bots, 10 s window, this dev machine — client-authoritative relay, ADR 0011):

```
budget 2  downstream/client:  avg 2.8 kB/s   max 2.8 kB/s   (target ~20–30 kB/s)
budget 3  server tick:        avg 0.33 ms    max 1.07 ms    (target < 33 ms)
```

Both comfortably under, with room to scale well past 20 players on these axes. Versus the
former server-authoritative stack (avg 0.47 / max 9.54 ms; 3.9 kB/s): tick time fell — and
its `max` fell sharply — because the server sheds the physics step (it now only relays);
downstream fell because a client is no longer sent its own body and the snapshot header lost
`lastProcessedInputSeq`.

### Caveats

- **Single process:** bots + server share one event loop, so tick timings include some
  contention. With no server physics the steady-state tick is sub-millisecond. Separate-process
  bots would give cleaner isolation — a later refinement.
- **Payload bytes only:** budget 2 counts message bytes, not per-packet WS/TCP/IP
  overhead (~tens of bytes × 20 Hz ≈ ~1 kB/s more on the real wire). Still well under.
- Every bot moves continuously, so each peer changes in every snapshot — worst case for the
  delta (nothing culled as resting). Idle players would send less. Per-entity cost is
  8 B/entity/snapshot.
- **Upstream** grew (14 B state vs the old 9 B input) but is not a tracked budget.
- Budgets 1, 4, 5 are device/network-bound and human-owned (SEED §8); not measured here.
