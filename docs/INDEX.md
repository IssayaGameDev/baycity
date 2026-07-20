# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **client-authoritative (ADR 0011).** Each client simulates its own entity
and reports state; the server relays peers, interpolated on a clock-synced timeline. Wire
is delta + quantized snapshots (v6); budgets 2 & 3 validated with bots. The demo is a 3D
TPS character controller (orbit camera, camera-relative movement, jump) on a static course.
History: M1–M8 + an M10 TPS prototype were built server-authoritative (prediction/
reconciliation, rewind/lag-comp), then the authority model was reversed — see ADR 0011. The
ball demo was retired (recover at tag `m10`). **M9 (2D path)** remains deferred (SEED §7).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — client authority, relay + per-client snapshots, interpolation, clock sync. Records the game-feel values.
- [physics.md](physics.md) — Rapier3d wrapper API, timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v6 (snapshot / welcome / state / ping / pong).
- [budgets.md](budgets.md) — the five budgets (SEED §5), how they're measured, latest load numbers.
- ADRs (`adr/`, append-only):
  - [0001](adr/0001-monorepo-tooling.md) tooling · [0002](adr/0002-transport-and-client-clock.md) transports · [0003](adr/0003-physics-and-renderer.md) physics+renderer
  - [0004](adr/0004-prediction-and-netsim.md) prediction+netsim · [0005](adr/0005-predicting-props.md) predicting props · [0006](adr/0006-clock-sync-and-lag-compensation.md) clock sync + lag comp
  - [0007](adr/0007-delta-and-quantization.md) delta + quantization · [0008](adr/0008-hud-and-input.md) HUD + input · [0009](adr/0009-load-validation.md) load validation
  - [0010](adr/0010-tps-character-controller.md) TPS character controller + pluggable game · [0011](adr/0011-client-authoritative.md) **client-authoritative (reverses SEED §4)** · [0012](adr/0012-roblox-like-character-controller.md) Roblox-like kinematic controller

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — binary codecs (v6): snapshot (delta + quantized), welcome, state, ping/pong; quantization utils.
- `physics` — Rapier3d wrapper (dynamic/fixed/kinematic bodies, **kinematic character controller**, velocity, damping), headless + browser.
- `server` — uWS transport, client-authoritative **relay** room (per-client delta snapshots, no simulation), clock-sync ping/pong; shared sim `@mp/server/tps` (character). `startServer()`.
- `client` — WebSocket transport, interpolation, local authoritative controller (`localController`), clock sync, input abstraction (`.` headless + `./dom` adapters).
- `render-three` — WebGL2 stage; re-exports THREE.
- `render-pixi` — PixiJS HUD (`createHud`): stacked transparent canvas, crosshair/status/joystick. (Not used by the current demo.)
- `tools/netsim` — latency/jitter/loss transport wrapper.
- `tools/bots` — headless load clients (report synthetic state) + `load` harness; measures budgets 2 & 3.
- `games/tps` — 3D TPS with a Roblox-like kinematic character controller (orbit camera, camera-relative movement with ground accel, force-limited air control, fixed-apex jump; ADR 0012; live-tunable) on a static obstacle course.

## Deferred (SEED §7, not built)

- **M9 — 2D path** (Rapier2d flavor + Pixi-only game). Deferred when scope narrowed to 3D.
- **Deploy** (Dockerfile + single-VPS) — re-scoped with Kodjo when a target exists. `infra/` empty.
