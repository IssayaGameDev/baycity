# Multiplayer Web Stack

A reusable multiplayer game stack for HTML5/TypeScript browser games — 3D via Three.js (WebGL2) with a PixiJS 2D HUD, server-authoritative netcode. Games are built as thin compositions on top of the stack.

**Status:** M7 — HUD & input. On top of the netcode (prediction, clock sync, lag comp, delta/quantization): a PixiJS 2D HUD stacked over the Three.js canvas, and one input abstraction behind keyboard/mouse and touch (virtual joystick). A built-in network simulator (`tools/netsim`) adds latency/jitter/loss. See `SEED.md` for the plan and `docs/INDEX.md` for system docs.

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

Move with **WASD / arrows** or drag the **virtual joystick** (bottom-left) and push the balls. **Click to shoot** other (orange) players — hits are lag-compensated. A PixiJS HUD draws the crosshair + status. Open a second browser tab to get a second player. Use the **Debug** pane (top-right) to add latency/loss and toggle **prediction** / **lag compensation**.

## Deploy

Not yet — deferred (see `SEED.md` §7).

## Docs

System documentation lives in `docs/`; start at `docs/INDEX.md`.
