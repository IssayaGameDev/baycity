# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **M8 — bots & load validation complete. The active program (M1–M8)
is complete.** Headless bots measure budget 2 (bandwidth) and budget 3 (server tick)
— both comfortably under at 20 bots (`budgets.md`). The full server-authoritative
stack is in place: prediction/reconciliation, clock sync, rewind/lag-comp,
delta/quantization, PixiJS HUD, kb/touch input. M9–M10 (2D path, reference game +
deploy) are deferred (SEED §7).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — tick/snapshots, prediction/reconciliation, interpolation, clock sync, rewind + lag comp. Records the game-feel values.
- [physics.md](physics.md) — Rapier3d wrapper API, timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v4 (snapshot / welcome / input / ping / pong / fire / hit).
- [budgets.md](budgets.md) — the five budgets (SEED §5), how they're measured, latest load numbers.
- ADRs (`adr/`, append-only):
  - [0001](adr/0001-monorepo-tooling.md) tooling · [0002](adr/0002-transport-and-client-clock.md) transports · [0003](adr/0003-physics-and-renderer.md) physics+renderer
  - [0004](adr/0004-prediction-and-netsim.md) prediction+netsim · [0005](adr/0005-predicting-props.md) predicting props · [0006](adr/0006-clock-sync-and-lag-compensation.md) clock sync + lag comp
  - [0007](adr/0007-delta-and-quantization.md) delta + quantization · [0008](adr/0008-hud-and-input.md) HUD + input · [0009](adr/0009-load-validation.md) load validation

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — binary codecs (v4): snapshot (delta + quantized), welcome, input, ping/pong, fire/hit; quantization utils.
- `physics` — Rapier3d wrapper (dynamic/fixed/kinematic bodies, velocity, damping), headless + browser.
- `server` — uWS transport, room (players, inputs, per-client acks, ping/pong, fire), `@mp/server/sim` shared sim, `rewind` ring buffer + lag-comp hit test.
- `client` — WebSocket transport, interpolation, world predictor (player + props), clock sync, input abstraction (`.` headless + `./dom` adapters).
- `render-three` — WebGL2 stage; re-exports THREE.
- `render-pixi` — PixiJS HUD (`createHud`): stacked transparent canvas, crosshair/status/joystick.
- `tools/netsim` — latency/jitter/loss transport wrapper.
- `tools/bots` — headless load clients + `load` harness; measures budgets 2 & 3.
- `games/physics-3d` — demo: predicted player + pushable balls, click-to-shoot (lag-comp), PixiJS HUD, kb/touch input, Tweakpane Debug pane.

## Deferred (SEED §7, not built)

- **M9 — 2D path** (Rapier2d flavor + Pixi-only game). Dropped when scope narrowed to 3D.
- **M10 — reference game + deploy** (Dockerfile + single-VPS). Re-scoped with Kodjo when a deploy target exists.
- `render-pixi` HUD is built; `infra/` remains an empty placeholder.
