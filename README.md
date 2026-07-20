# Multiplayer Web Stack

A reusable multiplayer game stack for HTML5/TypeScript browser games — 3D via Three.js (WebGL2) with a PixiJS 2D HUD, client-authoritative netcode. Games are built as thin compositions on top of the stack.

**Status:** client-authoritative stack (ADR 0011) with multiplayer **rooms on Colyseus** (ADR 0013) and a 3D TPS demo. Each client simulates its own entity and reports state; a Colyseus room relays peers, interpolated on a clock-synced timeline (no `@colyseus/schema`). Players auto-join rooms (fill-then-create, max 20), get auto-random names + nametags, and persist checkpoints locally. Includes delta + quantized snapshots, clock sync, and budget-validating bots. (History: server-authoritative through M10, then the authority model was reversed — ADR 0011.) See `docs/INDEX.md` for system docs and `docs/budgets.md` for load numbers.

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
pnpm dev:server   # Colyseus relay server, ws://localhost:9200
pnpm dev:tps      # http://localhost:5174  (open it)
```

Click the view to capture the mouse. **Mouse** orbits the camera, **WASD** moves (camera-relative; the character faces its movement), **Space** jumps. Your character is simulated locally (client-authoritative); the server relays your position to other players, who appear interpolated with a nametag. Open a second browser tab — both auto-join one shared room. Touch a green checkpoint disc and reload to respawn there; the cyan elevator runs off the shared clock (in sync across tabs). The **Debug** pane (top-right) tunes movement feel and camera.

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
