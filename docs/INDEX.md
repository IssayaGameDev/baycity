# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **M1–M8 complete; M10 (3D TPS character-controller prototype) built on
top.** The full server-authoritative stack is in place (prediction/reconciliation, clock
sync, rewind/lag-comp, delta/quantization, PixiJS HUD, kb/touch input; budgets 2 & 3
validated with bots). The server now hosts a **pluggable game** (`GameSim`) — the ball
demo or the TPS world — and the TPS client adds an orbit/mouselook camera, camera-relative
predicted movement, and jump. **M9 (2D path)** remains deferred (SEED §7).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — tick/snapshots, prediction/reconciliation, interpolation, clock sync, rewind + lag comp. Records the game-feel values.
- [physics.md](physics.md) — Rapier3d wrapper API, timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v5 (snapshot / welcome / input(+jump) / ping / pong / fire / hit).
- [budgets.md](budgets.md) — the five budgets (SEED §5), how they're measured, latest load numbers.
- ADRs (`adr/`, append-only):
  - [0001](adr/0001-monorepo-tooling.md) tooling · [0002](adr/0002-transport-and-client-clock.md) transports · [0003](adr/0003-physics-and-renderer.md) physics+renderer
  - [0004](adr/0004-prediction-and-netsim.md) prediction+netsim · [0005](adr/0005-predicting-props.md) predicting props · [0006](adr/0006-clock-sync-and-lag-compensation.md) clock sync + lag comp
  - [0007](adr/0007-delta-and-quantization.md) delta + quantization · [0008](adr/0008-hud-and-input.md) HUD + input · [0009](adr/0009-load-validation.md) load validation
  - [0010](adr/0010-tps-character-controller.md) TPS character controller + pluggable game

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — binary codecs (v5): snapshot (delta + quantized), welcome, input(+jump), ping/pong, fire/hit; quantization utils.
- `physics` — Rapier3d wrapper (dynamic/fixed/kinematic bodies, **kinematic character controller**, velocity, damping), headless + browser.
- `server` — uWS transport, generic room over a `GameSim`, `rewind` + lag-comp; games: `ballGame` + `tpsGame`; shared sims `@mp/server/sim` (balls) and `@mp/server/tps` (character). `startServer({ mode })`.
- `client` — WebSocket transport, interpolation, world predictor (player + props), clock sync, input abstraction (`.` headless + `./dom` adapters).
- `render-three` — WebGL2 stage; re-exports THREE.
- `render-pixi` — PixiJS HUD (`createHud`): stacked transparent canvas, crosshair/status/joystick.
- `tools/netsim` — latency/jitter/loss transport wrapper.
- `tools/bots` — headless load clients + `load` harness; measures budgets 2 & 3.
- `games/physics-3d` — netcode demo: predicted player + pushable balls, click-to-shoot (lag-comp), PixiJS HUD, kb/touch input.
- `games/tps` — M10 prototype: 3D TPS character controller (orbit camera, camera-relative predicted movement, jump) on an obstacle course.

## Deferred (SEED §7, not built)

- **M9 — 2D path** (Rapier2d flavor + Pixi-only game). Deferred when scope narrowed to 3D.
- **Deploy** (Dockerfile + single-VPS) — re-scoped with Kodjo when a target exists. `infra/` empty.
