# Netcode (current: M2 walking skeleton)

Server-authoritative. Server owns state; clients render it. No physics,
prediction, rewind, or clock sync yet (M3 / M4 / M5). Positions only.

## Server (`packages/server`)

- **Tick:** 30 Hz fixed (`TICK_RATE_HZ`), driven by `startFixedLoop` over the
  pure `createStepper` accumulator (`packages/core/src/loop.ts`). The stepper
  clamps to `maxSteps` and drops the backlog after a long stall (no spiral of
  death). `simTimeMs` advances by the fixed dt each tick.
- **World:** throwaway kinematic sphere orbiting the origin in XZ
  (`world.ts`) — content only to exercise the net path. Rapier replaces it in M3.
- **Snapshots:** 20 Hz (`SNAPSHOT_RATE_HZ`, within SEED's 15–20 Hz), decoupled
  from the tick by a millisecond accumulator, so the rate is independent of the
  tick ratio.
- **Per-client construction (SEED §3):** the loop iterates connections and builds
  a snapshot per connection — never a single global broadcast. `snapshotFor`
  takes `connId`; it is unused now (no AOI/filtering) but is the seam where every
  bandwidth lever hooks in later.

## Transport

- Server: uWebSockets.js (`transport-uws.ts`) behind `ServerTransport`.
- Client: standard `WebSocket` (`transport-ws.ts`) behind `ClientTransport` —
  one implementation for browser and Node ≥ 22, so bots reuse it headless.
- Payload is `ArrayBuffer` end to end. Inbound uWS buffers are neutered after the
  callback, so the server transport copies before handing off.
- **TCP/WS caveat:** WebSocket is reliable-ordered, so a lost packet head-of-line
  blocks later snapshots. The `*Transport` interfaces in `core` are the seam for a
  later UDP-like swap (SEED §2); the cost is to be quantified in netsim (M4).

## Client interpolation (`packages/client`)

- `createSnapshotClient` buffers snapshots and samples a view delayed by
  `interpolationDelayMs`.
- **Render clock (pre-clock-sync):** `renderServerTime = lastServerTimeMs +
  (localNow − localArrivalOfNewest) − interpolationDelayMs`. Replaced by real
  clock sync in M5.
- `interpolateAt` (pure, tested): finds the two snapshots bracketing the render
  time and lerps per entity; holds the nearest endpoint outside the buffered
  range (no extrapolation yet).
- Buffer is pruned beyond `maxBufferMs` behind the newest snapshot.

## ⚠ Design decision pending: interpolation buffer duration

`interpolationDelayMs` is a **game-feel design slider** (CLAUDE.md), not a
technical default. The demo uses **100 ms as a placeholder**. The real value is
Kodjo's call and is best made at **M4**, when netsim can show its effect under
jitter/loss — choosing it on jitter-free localhost is uninformative. It is a
runtime parameter: changing it is a one-line edit, no rework.
