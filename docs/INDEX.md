# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **M6 — per-client snapshots & protocol hardening complete.** Snapshots
are per-client **deltas** with **quantized** positions (u16/axis); schema versioning is
guarded. Builds on M5 (clock sync, rewind, lag comp) and M4 (prediction). Program:
`SEED.md` §7 (active M1–M8).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — tick/snapshots, prediction/reconciliation, interpolation, clock sync, rewind + lag comp. Records the game-feel values.
- [physics.md](physics.md) — Rapier3d wrapper API, timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v3 (snapshot / welcome / input / ping / pong / fire / hit).
- ADRs (`adr/`, append-only):
  - [0001](adr/0001-monorepo-tooling.md) tooling · [0002](adr/0002-transport-and-client-clock.md) transports · [0003](adr/0003-physics-and-renderer.md) physics+renderer
  - [0004](adr/0004-prediction-and-netsim.md) prediction+netsim · [0005](adr/0005-predicting-props.md) predicting props · [0006](adr/0006-clock-sync-and-lag-compensation.md) clock sync + lag comp · [0007](adr/0007-delta-and-quantization.md) delta + quantization

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — binary codecs (v4): snapshot (delta + quantized), welcome, input, ping/pong, fire/hit; quantization utils.
- `physics` — Rapier3d wrapper (dynamic/fixed/kinematic bodies, velocity, damping), headless + browser.
- `server` — uWS transport, room (players, inputs, per-client acks, ping/pong, fire), `@mp/server/sim` shared sim, `rewind` ring buffer + lag-comp hit test.
- `client` — WebSocket transport, interpolation, world predictor (player + props), clock sync.
- `render-three` — WebGL2 stage; re-exports THREE.
- `tools/netsim` — latency/jitter/loss transport wrapper.
- `games/physics-3d` — demo: predicted player + pushable balls, click-to-shoot (lag-comp), Tweakpane Debug pane.

## Not built yet

HUD + input abstraction via `render-pixi` (M7), bots + load/budget validation (M8).
`render-pixi`, `infra/` remain skeletons/empty.
