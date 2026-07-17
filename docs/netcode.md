# Netcode (current: M6 delta + quantization)

Server-authoritative. Clients send inputs; the server owns state. The local
player and the balls are client-predicted; remote players are interpolated on a
clock-synced timeline; hits are lag-compensated against the shooter-perceived
past. Snapshots are per-client deltas with quantized positions. Positions only on
the wire (no rotation yet).

## Server (`packages/server`)

- **Tick:** 30 Hz fixed (`TICK_RATE_HZ`); snapshots at 20 Hz. The room owns
  `serverTimeMs` (advanced per tick).
- **Room (`room.ts`):** Rapier world (ground + pushable balls + one dynamic-ball
  player per connection). Per-connection input FIFO (one/tick, records
  `lastProcessedSeq`). Answers `PING` with `PONG` and handles `FIRE`.
- **Per-client snapshots (SEED §3) + delta (M6):** each client gets its own message
  with its ack. After a first full snapshot, subsequent ones are **deltas** vs the
  last positions sent to that client — only entities whose *quantized* position
  changed, plus removed ids. Positions are **quantized** to u16/axis. Delta-vs-last-sent
  is safe on the reliable, ordered WebSocket transport.
- **Rewind (`rewind.ts`, SEED §3):** each tick records a frame of player positions
  into a ~1 s ring buffer. `positionsAt(t)` reconstructs (interpolated) positions
  at any past time; `hitScan` ray-tests those spheres.

## Shared deterministic sim (`@mp/server/sim`)

World/collision config + player movement + pushable balls, run by both server and
client predictor (SEED §4). Determinism verified in `sim.test.ts`.

## Client (`packages/client`)

- **Prediction (`predictor.ts`):** generic world predictor — predicts the local
  player and the balls (per-entity render-interpolation + eased corrections);
  full-state reconciliation replays unacked inputs. Predicted props are
  position-corrected but **keep their velocity** (`setPosition`, not `teleport`), so a
  correction doesn't freeze a rolling ball mid-motion. Remote players are kinematic
  obstacles.
- **Reassembly + interpolation:** `createSnapshotReassembler` rebuilds full snapshots
  from full/delta messages; `snapshotClient` renders remotes ~`interpolationDelayMs`
  in the past on the **clock-synced** timeline (`serverNow`).
- **Clock sync (`clockSync.ts`, SEED §3):** from `PING`/`PONG` round-trips it keeps
  a smoothed estimate of `serverTime − localTime` (and RTT). `serverNow()` drives
  both interpolation playback and the timestamp on hit claims — so "fire at what I
  see" lines up with the server's rewind.

## Lag-compensated hits (SEED §3)

1. Client fires: raycast from the camera; send `FIRE{fireTimeMs, origin, dir}` where
   `fireTimeMs = serverNow − interpolationDelay` (the time the shooter rendered the targets).
2. Server clamps `fireTimeMs` to the honored rewind window (**1 s**, = buffer length;
   technical default — the design/anti-cheat clamp lives here), rewinds players to it,
   ray-tests, and broadcasts `HIT{shooterId, targetId}`.
3. Result: hitting where you *saw* a moving target registers, despite latency. The
   demo's "lag compensation" toggle sends `fireTimeMs = serverNow` (present) instead,
   so shots miss moving targets — showing why rewind is needed.

## Network simulation (`tools/netsim`)

`createNetsimClientTransport(inner, { latencyMs, jitterMs, lossRate })` delays/drops
both directions. The demo's Tweakpane "Network" folder tunes it live.

## Game-feel values (Kodjo's call)

Both **100 ms**, provisional; tunable live in the demo:
- `interpolationDelayMs` — how far in the past remotes render.
- `correctionSmoothingMs` — how fast a reconciliation correction eases in.
