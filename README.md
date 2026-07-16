# Multiplayer Web Stack

A reusable multiplayer game stack for HTML5/TypeScript browser games — 3D via Three.js (WebGL2) with a PixiJS 2D HUD, server-authoritative netcode. Games are built as thin compositions on top of the stack.

**Status:** M3 — physics in the loop. The server simulates a Rapier3d world (ground + falling balls); the browser renders it in Three.js (WebGL2), interpolated. See `SEED.md` for the plan and `docs/INDEX.md` for system docs.

## Requirements

- Node ≥ 22
- pnpm 10 — `corepack enable` installs the version pinned in `package.json`

## Local dev

```sh
pnpm install
pnpm check      # typecheck + tests (milestone gate)
pnpm test       # tests only
pnpm typecheck  # types only
```

## Run the demo (M2)

Two terminals:

```sh
pnpm dev:server   # ws://localhost:9200
pnpm dev:demo     # http://localhost:5173  (open it)
```

You should see teal balls fall and bounce on a ground plane — the server's Rapier3d simulation, rendered in Three.js and interpolated on the client.

## Deploy

Not yet — deferred (see `SEED.md` §7).

## Docs

System documentation lives in `docs/`; start at `docs/INDEX.md`.
