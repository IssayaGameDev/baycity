# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **M4 — prediction & reconciliation complete.** The local player
**and the balls** are client-predicted (client-side Rapier) and reconciled against
the server; remote players are interpolated; balls are pushable with instant local
response; `tools/netsim` simulates latency/jitter/loss. No rewind/lag-comp or clock
sync yet. Program and build order: `SEED.md` §7 (active program M1–M8).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — tick/snapshots, shared deterministic sim, client prediction/reconciliation, interpolation, netsim. **Flags the two pending game-feel design decisions.**
- [physics.md](physics.md) — Rapier3d wrapper API, timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v2 (snapshot / welcome / input).
- ADRs (`adr/`, append-only):
  - [0001-monorepo-tooling.md](adr/0001-monorepo-tooling.md) — pnpm, source-first TS, Vitest.
  - [0002-transport-and-client-clock.md](adr/0002-transport-and-client-clock.md) — uWS + WebSocket transports; interim render clock.
  - [0003-physics-and-renderer.md](adr/0003-physics-and-renderer.md) — Rapier3d-compat; unopinionated Three.js stage.
  - [0004-prediction-and-netsim.md](adr/0004-prediction-and-netsim.md) — shared deterministic sim, prediction/reconciliation, netsim.
  - [0005-predicting-props.md](adr/0005-predicting-props.md) — generic world predictor; predicting the balls (pull into the loop).

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — binary codecs: snapshot (v2), welcome, input.
- `physics` — Rapier3d wrapper (world/body/step/velocity/teleport/remove), headless + browser.
- `server` — uWS transport, room (players + input processing + per-client acks), throwaway balls; `@mp/server/sim` shared deterministic player sim.
- `client` — WebSocket transport, interpolation, predictor (prediction/reconciliation/smoothing).
- `render-three` — WebGL2 stage; re-exports THREE.
- `tools/netsim` — latency/jitter/loss transport wrapper.
- `games/physics-3d` — throwaway demo: WASD predicted player vs interpolated balls, netsim sliders, prediction toggle.

## Not built yet

Rewind + clock sync (M5), delta/quantization (M6), HUD + input abstraction via `render-pixi` (M7),
bots/load (M8). `render-pixi`, `tools/` beyond netsim, `infra/` remain skeletons/empty.
