# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **client-authoritative rooms on Colyseus (ADR 0011 + 0013), with a data-driven
content pipeline (ADR 0014).** Each client simulates its own entity and reports state; the
server (a Colyseus `Room`) relays peers, interpolated on a clock-synced timeline — no
`@colyseus/schema`. Product framing: an "extremely simplified Roblox" — a platform hosting a few
**modes** that share one stack. **Parkour** is the first mode (`modes/parkour`, `ParkourRoom`).

Content is **data** (`@mp/content`): prefabs/levels of authored collider primitives + a swappable
greybox visual layer, a loader (colliders + markers + physics-backed triggers + clock-driven
behaviors + a renderer-agnostic visual list), a parametric greybox **kit** + generators. Rendered
by a polished shared pipeline (`@mp/render-three`: IBL, ACES, soft shadows, GTAO/SMAA/bloom).
Gameplay **triggers are a piece's own collider**, detected by real engine contact. Inspect it
locally with the **viewer** (`tools/viewer`, `pnpm dev:viewer`). Server stays content-free.

Wire is delta + quantized snapshots (v7); budgets 2 & 3 validated with bots. Colyseus pinned to
**0.16** (matched client/server); default `ws` transport (uWS is a later swap); scale-out infra
(Redis/multi-region) deferred to deploy. History: server-authoritative through M10 (ADR 0011
reversed it); ball demo retired (tag `m10`); world/controller relocated out of `@mp/server/tps`
(ADR 0014). **M9 (2D path)** remains deferred (SEED §7).

## Docs

- [workspace.md](workspace.md) — monorepo layout (packages/modes/tools), dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — client authority, Colyseus rooms + relay, per-client snapshots, interpolation, clock sync, roster/names. Records the game-feel values.
- [physics.md](physics.md) — Rapier3d wrapper API (bodies, rotation, kinematic character controller + collisions), timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v7 (snapshot / welcome / state / ping / pong / roster) over a Colyseus channel.
- [budgets.md](budgets.md) — the five budgets (SEED §5), how they're measured, latest load numbers.
- Content schema/loader/kit are self-documenting via `@mp/content` types + ADR 0014 (no prose doc).
- ADRs (`adr/`, append-only):
  - [0001](adr/0001-monorepo-tooling.md) tooling · [0002](adr/0002-transport-and-client-clock.md) transports · [0003](adr/0003-physics-and-renderer.md) physics+renderer
  - [0004](adr/0004-prediction-and-netsim.md) prediction+netsim · [0005](adr/0005-predicting-props.md) predicting props · [0006](adr/0006-clock-sync-and-lag-compensation.md) clock sync + lag comp
  - [0007](adr/0007-delta-and-quantization.md) delta + quantization · [0008](adr/0008-hud-and-input.md) HUD + input · [0009](adr/0009-load-validation.md) load validation
  - [0010](adr/0010-tps-character-controller.md) TPS controller + pluggable game · [0011](adr/0011-client-authoritative.md) **client-authoritative (reverses SEED §4)** · [0012](adr/0012-roblox-like-character-controller.md) Roblox-like kinematic controller
  - [0013](adr/0013-colyseus-rooms.md) **Colyseus rooms foundation** · [0014](adr/0014-content-pipeline.md) **data-driven content pipeline + modes layering** · [0015](adr/0015-ui-rendering.md) **PixiJS for all game UI**

## Built

- `core` — math (incl. quaternion helpers), entity model, fixed-timestep loop, transport interface.
- `net` — binary codecs (v7): snapshot (delta + quantized), welcome, state, ping/pong, roster; quantization utils. `NET_CHANNEL` is the Colyseus channel they ride.
- `physics` — Rapier3d wrapper: dynamic/fixed/kinematic bodies (position + rotation), **kinematic character controller** (with contact reporting), headless + browser.
- `character` — the stack-level kinematic character controller (`stepCharacter`, `CharacterTuning`; ADR 0012), mode-agnostic. Relocated out of `@mp/server/tps`.
- `content` — data-driven content: schema (prefab/level/collider/marker/behavior/visual), validation, the **loader** (`instantiateLevel`), the greybox **kit** + generators. Headless, no rendering. ADR 0014.
- `server` — **Colyseus** `Server` (`startServer()`) hosting `ParkourRoom`: client-authoritative relay (per-client delta snapshots, no simulation, no schema), auto-join, roster/names, clock-sync ping/pong. Content-free.
- `client` — `colyseus.js` transport (`joinOrCreate`), interpolation, local authoritative controller (`localController`), clock sync, input abstraction (`.` headless + `./dom` adapters).
- `render-three` — WebGL2 stage + the polished greybox pipeline (IBL, ACES, soft shadows, GTAO/SMAA/bloom, style→material, level-view); re-exports THREE + OrbitControls.
- `render-pixi` — PixiJS 2D HUD (`createHud`), transparent canvas stacked over Three. The designated layer for **all game UI** (ADR 0015); not yet wired into the demo.
- `tools/netsim` — latency/jitter/loss transport wrapper. (Not wired into the current client — ADR 0013.)
- `tools/bots` — headless `colyseus.js` load clients + `load` harness; measures budgets 2 & 3 and doubles as the live integration check.
- `tools/viewer` — localhost content inspector (`pnpm dev:viewer`): picker, orbit, collider/marker/trigger overlays, jump-reachability gizmo, play-in-place. ADR 0014.
- `modes/parkour` — the parkour mode on Colyseus rooms: Roblox-like controller (live-tunable), auto-join, nametags, data-driven level (loads a throwaway kit sampler), checkpoints/hazard/fall via physics triggers + a persistence adapter. (Rename of `games/tps`.)
- `content/levels` — level JSON (`level1.json`, the ported original world).

## Deferred (SEED §7, not built)

- **Goal/win rule, other modes** (obby-tower variant, keyboard-run grind + progression), **glTF art layer**, **full in-viewer editor**, **account-backed persistence** — accounted for by seams (ADR 0014), not built.
- **M9 — 2D path** (Rapier2d + Pixi-only). Deferred when scope narrowed to 3D.
- **Deploy** (Dockerfile + single-VPS) — re-scoped with Kodjo when a target exists. `infra/` empty.
