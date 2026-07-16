# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **M2 — walking skeleton complete.** One server-authoritative
sphere syncs server→client over WebSocket and is interpolated on the client. No
physics/prediction/rewind/clock-sync yet. Program and build order: `SEED.md` §7
(active program M1–M8).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — server tick/snapshot cadence, per-client snapshots, client interpolation + render clock. **Flags the pending interpolation-buffer design decision.**
- [protocol.md](protocol.md) — binary wire format v1 (framing + snapshot layout).
- ADRs (`adr/`, append-only decision records):
  - [0001-monorepo-tooling.md](adr/0001-monorepo-tooling.md) — pnpm workspaces, source-first TS, Vitest, per-package typecheck.
  - [0002-transport-and-client-clock.md](adr/0002-transport-and-client-clock.md) — uWS + standard-WebSocket transports; interim render clock.

## Built

- `core` — math, entity model, fixed-timestep loop, transport interface.
- `net` — message framing + binary snapshot codec (v1).
- `server` — uWS transport, 30 Hz tick, 20 Hz per-client snapshots, throwaway sphere world.
- `client` — WebSocket transport, snapshot interpolation, render clock.
- `games/walking-skeleton` — throwaway browser demo (Vite + canvas). Not the deferred reference game.

## Not built yet

`physics` (M3), prediction/reconciliation (M4), rewind + clock sync (M5), delta/quantization
(M6), HUD + input via `render-pixi` (M7), bots/load (M8). `render-three`/`render-pixi`,
`tools/`, `infra/` remain skeletons/empty.
