# Multiplayer Web Stack

A reusable multiplayer game stack for HTML5/TypeScript browser games — 3D via Three.js (WebGL2) with a PixiJS 2D HUD, server-authoritative netcode. Games are built as thin compositions on top of the stack.

**Status:** M4 — prediction & reconciliation. The local player (WASD) is client-predicted with client-side Rapier and reconciled against the authoritative server; remote balls are interpolated. A built-in network simulator (`tools/netsim`) adds latency/jitter/loss. See `SEED.md` for the plan and `docs/INDEX.md` for system docs.

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

Move your yellow player with **WASD / arrow keys**. Teal balls are server-simulated physics (interpolated). Use the sliders to add latency/loss, and toggle **Prediction** off to feel the input lag it hides.

## Deploy

Not yet — deferred (see `SEED.md` §7).

## Docs

System documentation lives in `docs/`; start at `docs/INDEX.md`.
