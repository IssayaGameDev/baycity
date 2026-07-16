# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **M3 — physics in the loop complete.** The server simulates a
Rapier3d world (ground + falling balls); the client renders it in Three.js
(WebGL2), interpolated. No prediction/rewind/clock-sync yet. Program and build
order: `SEED.md` §7 (active program M1–M8).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — server tick + physics step, per-client snapshots, client interpolation + render clock, rendering. **Flags the pending interpolation-buffer design decision.**
- [physics.md](physics.md) — Rapier3d wrapper API, timestep, determinism stance.
- [protocol.md](protocol.md) — binary wire format v1 (framing + snapshot layout).
- ADRs (`adr/`, append-only decision records):
  - [0001-monorepo-tooling.md](adr/0001-monorepo-tooling.md) — pnpm workspaces, source-first TS, Vitest.
  - [0002-transport-and-client-clock.md](adr/0002-transport-and-client-clock.md) — uWS + standard-WebSocket transports; interim render clock.
  - [0003-physics-and-renderer.md](adr/0003-physics-and-renderer.md) — Rapier3d-compat wrapper; unopinionated Three.js stage.

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — message framing + binary snapshot codec (v1, position-only).
- `physics` — Rapier3d wrapper (init/world/body/step), headless.
- `server` — uWS transport, 30 Hz tick stepping the physics world, 20 Hz per-client snapshots.
- `client` — WebSocket transport, snapshot interpolation, render clock.
- `render-three` — WebGL2 stage (renderer/scene/camera/loop), re-exports THREE.
- `games/physics-3d` — throwaway browser demo (Three.js). Not the deferred reference game.

## Not built yet

Client prediction/reconciliation + netsim (M4), rewind + clock sync (M5), delta/quantization
(M6), HUD + input via `render-pixi` (M7), bots/load (M8). `render-pixi`, `tools/`, `infra/`
remain skeletons/empty.
