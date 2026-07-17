# Netcode (current: M4 prediction & reconciliation)

Server-authoritative. Clients send inputs; the server owns state. The local
player **and the balls** are client-predicted (props "pulled into the prediction
loop", SEED §4); remote players are interpolated. Positions only on the wire (no
rotation yet). No rewind/lag-comp or clock sync yet (M5).

## Server (`packages/server`)

- **Tick:** 30 Hz fixed (`TICK_RATE_HZ`) over the pure `createStepper` accumulator.
  Snapshots at 20 Hz (`SNAPSHOT_RATE_HZ`), decoupled from the tick.
- **Room (`room.ts`):** owns the Rapier world — ground, inert pushable balls
  (throwaway content), and one dynamic-ball player per connection. All dynamic, so
  players push balls, balls push players, and multiple players can push one ball —
  resolved authoritatively.
- **Inputs:** per-connection bounded FIFO; one input applied per tick, recording
  `lastProcessedSeq`; empty queue → zero-move (ack unchanged).
- **Per-client snapshots (SEED §3):** one per connection with that client's
  `lastProcessedInputSeq` (the ack). Entity list (balls + all players) is shared.

## Shared deterministic sim (`@mp/server/sim`)

World/collision config + player movement + the pushable balls, in one module run
by both the server (authority) and the client predictor. Same values + same step ⇒
replaying inputs reproduces server state (SEED §4); determinism on the same Rapier
build is verified in `sim.test.ts`. (Lives under `@mp/server` for now; extraction
to a game-owned shared sim is later work — ADR-0004/0005.)

## Client (`packages/client`)

- **Transport:** standard `WebSocket`, optionally wrapped by `@mp/netsim`.
- **What's predicted:** the local player **and the balls** run in a local physics
  world (shared sim), so pushing is instant. Remote players can't be predicted
  (unknown input), so they are **kinematic obstacles** synced from snapshots.
- **World predictor (`predictor.ts`):** generic over a `PredictedWorld` (apply
  input + step; read/restore predicted entities). Each fixed tick it applies the
  local input, steps, and records every predicted entity's position.
- **Reconciliation:** per snapshot, take the authoritative positions of the
  predicted entities + `lastProcessedInputSeq`; drop acked inputs, restore those
  entities, replay the remaining unacked inputs (re-simulating the local world).
  Each entity's visual delta is absorbed into a **decaying offset**
  (`correctionSmoothingMs`) so corrections ease in (SEED §4). Position-only
  reconciliation (v1): free-coasting props lose velocity, mitigated by damping;
  exact reconciliation would add velocities to the wire (later, with M6).
- **Render interpolation:** every predicted entity is drawn by interpolating
  between its last two tick positions — smooth at display rate, not 30 Hz stepping.
- **Remotes:** other players are interpolated (`createSnapshotClient`), ~`interpolationDelayMs`
  in the past; also mirrored as kinematic obstacles so the local player collides with them.
  Playback runs off a **smoothed render clock** — a free-running local→server time offset
  gently corrected by each snapshot — so 20 Hz arrival jitter doesn't stutter remote motion
  (real clock sync is M5).
- Headless-capable, so bots reuse the same prediction path.

## Network simulation (`tools/netsim`)

`createNetsimClientTransport(inner, { latencyMs, jitterMs, lossRate })` delays/drops
both directions (RTT ≈ 2×latency). The demo exposes latency/loss sliders + a
prediction toggle so behaviour can be felt under realistic conditions (SEED §7).

## Game-feel values (Kodjo's call)

Both set to **100 ms** — provisional; revisit with real-network/device feel. Tunable
live in the demo's Tweakpane "Network" folder.

- **`interpolationDelayMs`** — how far in the past remotes render (latency vs. smoothness).
- **`correctionSmoothingMs`** — how fast a reconciliation correction eases in
  (responsiveness vs. rubber-banding).
