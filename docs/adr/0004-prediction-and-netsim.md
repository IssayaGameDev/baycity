# ADR 0004 — Prediction, reconciliation, and network simulation

Status: accepted (M4). **Prediction/reconciliation superseded by ADR 0011** (client-
authoritative): the client's own body is now the authority, so there is no correction to
predict against. `netsim` is unaffected. Retained for history.

## Context

M4 adds client-side prediction of the local player with server reconciliation,
plus a network simulator (SEED §4, §7). Prediction requires the client and server
to simulate the player identically, and requires a way to exercise the netcode
under latency/jitter/loss.

## Decision

- **Shared deterministic player sim.** The player movement model + world/collision
  config live in one module (`@mp/server/sim`), used by the server (authority) and,
  via the demo, by the client predictor. Same values + same step ⇒ replay
  reproduces server state. Rapier is bit-deterministic on the same build, so
  corrections are near-zero in good conditions; a determinism test guards this.
- **Velocity-controlled dynamic player.** Input sets horizontal linear velocity;
  gravity/collision handle the rest. Grounded horizontal movement means restoring
  position (not velocity) on reconcile is sufficient — no velocity on the wire.
- **Generic predictor** (`@mp/client`) over an injected `PredictedSim`, so its
  reconciliation/replay/smoothing logic is unit-tested without physics.
- **Correction smoothing** as a decaying visual error offset (no snap), tunable via
  `correctionSmoothingMs`; the predicted player is render-interpolated between ticks.
- **Local-player collision via kinematic obstacles.** The client mirrors every other
  entity into its prediction world as a kinematic obstacle (synced from snapshots),
  so the local player is blocked/redirected with no pass-through. Only the local
  player's collision *response* is predicted; the obstacles' dynamics (being pushed,
  multi-player interactions) stay server-authoritative and arrive via interpolation.
- **Netsim as a `ClientTransport` wrapper** (`@mp/netsim`): delays/drops both
  directions. Works headless (bots/tests) and in the browser (demo sliders).
- **Protocol v2:** added `Input` (seq + moveX/Z) and `Welcome` (playerId) messages;
  snapshots gained per-client `lastProcessedInputSeq` — the natural home for the
  ack, since snapshots are already per-client (SEED §3).

## Rejected

- **Kinematic position-integration player** — simpler/deterministic, but wouldn't
  exercise client-side Rapier or the "pull a body into the prediction loop"
  capability (SEED §4). Chose the physics body.
- **Velocity on the wire for reconciliation** — unnecessary for a grounded player;
  revisit if jumping/air control is added.
- **A dedicated shared-sim package** — cleaner home than `@mp/server/sim`, but a
  structural addition (SEED §6 asks first). Deferred until gameplay sim grows or
  `@mp/server` is generalised to host a game-owned sim.
- **Predicting remote/prop dynamics client-side** — a prop pushed by multiple
  players can't be predicted accurately from one client. Remotes stay interpolated
  and server-authoritative; the client only uses them as kinematic collision
  obstacles for its own player (props not predicted by default, SEED §4).
- **No player↔prop collision / a "pass-through" demo** — rejected by Kodjo; the
  interaction must be realistic and multi-player.
