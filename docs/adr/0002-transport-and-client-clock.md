# ADR 0002 — Transport implementations and the pre-sync client clock

Status: accepted (M2)

## Context

The walking skeleton needs concrete transports behind `@mp/core`'s
`ServerTransport`/`ClientTransport`, and the client needs a server-time base for
interpolation — before clock sync exists (that is M5).

## Decision

- **Server transport = uWebSockets.js** (SEED-locked). Behind `ServerTransport`.
- **Client transport = standard `WebSocket`.** Node ≥ 22 exposes a global
  `WebSocket` (undici) with the same API as the browser's, so a single
  implementation runs both in the browser and headless in Node — bots get
  networking for free (SEED §6, law 2). Typed via `@types/node` when the DOM lib
  is absent, so it stays in the headless `@mp/client` package.
- **`ArrayBuffer` as the transport payload type** — zero conversion across
  uWS, browser WebSocket, and Node WebSocket.
- **Interim render clock** — the client estimates "server now" by extrapolating
  the newest snapshot's `serverTimeMs` with locally-elapsed time, minus the
  interpolation delay. Good enough for localhost/M2; real clock sync (M5)
  replaces it.
- **Snapshot cadence decoupled from the tick** via a millisecond accumulator, so
  20 Hz snapshots ride cleanly on a 30 Hz tick.

## Rejected

- **`ws` library for the client/server** — would deviate from the SEED-locked
  uWS on the server and add a dependency on the client where the platform global
  already suffices.
- **Tying snapshot rate to an integer tick ratio** — would force 15 Hz (every 2
  ticks) instead of allowing 20 Hz.
- **Waiting for clock sync before any interpolation** — would block the walking
  skeleton on M5 work for no M2 benefit.

## Note

WebSocket/TCP head-of-line blocking is a known limitation; the transport
interfaces are the seam for a later UDP-like swap (SEED §2), with the cost to be
measured in netsim (M4).
