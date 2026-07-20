# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **client-authoritative rooms on Colyseus (ADR 0011 + 0013).** Each client
simulates its own entity and reports state; the server (a Colyseus `Room`) relays peers,
interpolated on a clock-synced timeline — no `@colyseus/schema`. Auto-join (`joinOrCreate`
fill-then-create, max 20, solo → own room), auto-random names + billboard nametags, local
checkpoints, a clock-driven demo elevator. Wire is delta + quantized snapshots (v7); budgets
2 & 3 validated with bots. Colyseus pinned to **0.16** (matched client/server); default `ws`
transport (uWS is a later swap); scale-out infra (Redis/multi-region) deferred to deploy.
History: server-authoritative through M10 (ADR 0011 reversed it); ball demo retired (tag
`m10`). **M9 (2D path)** remains deferred (SEED §7).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — client authority, Colyseus rooms + relay, per-client snapshots, interpolation, clock sync, roster/names. Records the game-feel values.
- [physics.md](physics.md) — Rapier3d wrapper API, timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v7 (snapshot / welcome / state / ping / pong / roster) over a Colyseus channel.
- [budgets.md](budgets.md) — the five budgets (SEED §5), how they're measured, latest load numbers.
- ADRs (`adr/`, append-only):
  - [0001](adr/0001-monorepo-tooling.md) tooling · [0002](adr/0002-transport-and-client-clock.md) transports · [0003](adr/0003-physics-and-renderer.md) physics+renderer
  - [0004](adr/0004-prediction-and-netsim.md) prediction+netsim · [0005](adr/0005-predicting-props.md) predicting props · [0006](adr/0006-clock-sync-and-lag-compensation.md) clock sync + lag comp
  - [0007](adr/0007-delta-and-quantization.md) delta + quantization · [0008](adr/0008-hud-and-input.md) HUD + input · [0009](adr/0009-load-validation.md) load validation
  - [0010](adr/0010-tps-character-controller.md) TPS character controller + pluggable game · [0011](adr/0011-client-authoritative.md) **client-authoritative (reverses SEED §4)** · [0012](adr/0012-roblox-like-character-controller.md) Roblox-like kinematic controller · [0013](adr/0013-colyseus-rooms.md) **Colyseus rooms foundation**

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — binary codecs (v7): snapshot (delta + quantized), welcome, state, ping/pong, roster; quantization utils. `NET_CHANNEL` is the Colyseus channel they ride.
- `physics` — Rapier3d wrapper (dynamic/fixed/kinematic bodies, **kinematic character controller**, velocity, damping), headless + browser.
- `server` — **Colyseus** `Server` (`startServer()`) hosting `TpsRoom`: client-authoritative relay (per-client delta snapshots, no simulation, no schema), auto-join, roster/names, clock-sync ping/pong; shared sim + world/checkpoint/platform defs `@mp/server/tps`.
- `client` — `colyseus.js` transport (`joinOrCreate`), interpolation, local authoritative controller (`localController`), clock sync, input abstraction (`.` headless + `./dom` adapters).
- `render-three` — WebGL2 stage; re-exports THREE.
- `render-pixi` — PixiJS HUD (`createHud`): stacked transparent canvas, crosshair/status/joystick. (Not used by the current demo.)
- `tools/netsim` — latency/jitter/loss transport wrapper. (Not wired into the current client — ADR 0013.)
- `tools/bots` — headless `colyseus.js` load clients (report synthetic state) + `load` harness; measures budgets 2 & 3 and doubles as the live integration check.
- `games/tps` — 3D TPS on Colyseus rooms: Roblox-like kinematic controller (ADR 0012, live-tunable), auto-join, nametags, local checkpoints, a clock-driven elevator, on a static obstacle course.

## Deferred (SEED §7, not built)

- **M9 — 2D path** (Rapier2d flavor + Pixi-only game). Deferred when scope narrowed to 3D.
- **Deploy** (Dockerfile + single-VPS) — re-scoped with Kodjo when a target exists. `infra/` empty.
