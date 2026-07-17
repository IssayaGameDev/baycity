# Multiplayer Web Stack

A reusable multiplayer game stack for HTML5/TypeScript browser games — 3D via Three.js (WebGL2) with a PixiJS 2D HUD, server-authoritative netcode. Games are built as thin compositions on top of the stack.

**Status:** M1–M8 stack complete + an M10 **3D TPS character-controller prototype** on top. The stack: server-authoritative netcode with client prediction/reconciliation, clock sync, rewind/lag-compensated hits, delta + quantized snapshots, a PixiJS HUD, keyboard/touch input, a network simulator, and budget-validating bots. The server hosts a pluggable game (ball demo or TPS). See `docs/INDEX.md` for system docs and `docs/budgets.md` for load numbers.

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

## Run the demo

Two terminals:

```sh
pnpm dev:server   # ws://localhost:9200
pnpm dev:demo     # http://localhost:5173  (open it)
```

Move with **WASD / arrows** or drag the **virtual joystick** (bottom-left) and push the balls. **Click to shoot** other (orange) players — hits are lag-compensated. A PixiJS HUD draws the crosshair + status. Open a second browser tab to get a second player. Use the **Debug** pane (top-right) to add latency/loss and toggle **prediction** / **lag compensation**.

## Run the TPS prototype (M10)

```sh
pnpm dev:server:tps   # server in TPS mode, ws://localhost:9200
pnpm dev:tps          # http://localhost:5174  (open it)
```

Click the view to capture the mouse. **Mouse** orbits the camera, **WASD** moves (camera-relative; the character faces its movement), **Space** jumps. Client-predicted, server-authoritative. Open a second tab for a second player.

## Load test

```sh
pnpm --filter @mp/bots run load                    # 20 bots, 10 s
BOTS=30 DURATION_MS=15000 pnpm --filter @mp/bots run load
```

Reports downstream bandwidth per client (budget 2) and server tick time (budget 3). See `docs/budgets.md`.

## Deploy

Not yet — deferred (see `SEED.md` §7).

## Docs

System documentation lives in `docs/`; start at `docs/INDEX.md`.
