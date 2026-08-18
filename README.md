# Multiplayer Web Stack

A reusable multiplayer game stack for HTML5/TypeScript browser games — 3D via Three.js (WebGL2) with a PixiJS 2D HUD, client-authoritative netcode. Games are built as thin compositions on top of the stack.

**Status:** client-authoritative stack (ADR 0011) with multiplayer **rooms on Colyseus** (ADR 0013) and a 3D obby/parkour demo (`modes/parkour`). Each client simulates its own entity and reports state; a Colyseus room relays peers, interpolated on a clock-synced timeline (no `@colyseus/schema`). Players auto-join rooms (fill-then-create, max 20), get auto-random names + nametags, and persist checkpoints locally. Includes delta + quantized snapshots, clock sync, and budget-validating bots. (History: server-authoritative through M10, then the authority model was reversed — ADR 0011.) See `docs/INDEX.md` for system docs and `docs/budgets.md` for load numbers.

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
pnpm dev:parkour  # http://localhost:5174  (open it)
```

Click the view to capture the mouse. **Mouse** orbits the camera, **WASD** moves (camera-relative; the character faces its movement), **Space** jumps, **Esc** opens the pause screen. Your character is simulated locally (client-authoritative); the server relays your position to other players, who appear interpolated with a nametag. Open a second browser tab — both auto-join one shared room. Touch a green checkpoint pad to respawn there; moving platforms run off the shared clock, so they are in sync across tabs. The **Debug** pane (top-right) tunes movement feel and camera. **On a phone**: drag the left thumbstick to move, tap-and-hold the bottom-right button to jump, drag anywhere else to look, pinch to zoom — untested on a real device so far (see `docs/INDEX.md`).

By default you get the built-in **gym** — the test course below. Add `?level=<name>` to load a level
file from `content/levels/` instead (`?level=level1`); the name also picks the room, so tabs on
different levels will not see each other. Author those files with `pnpm dev:editor`.

You spawn on a 64 m slab holding a sampler of every kit piece. The obstacle courses sit past its
edges, over open void — walk **+z** for the beam course, **+x** for the pad course, and **+x along
the z = 20 line** for the curved-beam course. Behind spawn (**−z**) is the platform-carry bench.

Other dev servers, each independent of the game:

```sh
pnpm dev:viewer   # http://localhost:5175 — inspect content in isolation
pnpm dev:editor   # http://localhost:5176 — visual level/prefab editor
```

## Load test

```sh
pnpm --filter @mp/bots run load                    # 20 bots, 10 s
BOTS=30 DURATION_MS=15000 pnpm --filter @mp/bots run load
```

Reports downstream bandwidth per client (budget 2) and server tick time (budget 3). See `docs/budgets.md`.

## Deploy

Not yet — deferred; see the deferred list in `docs/INDEX.md`. `infra/` is empty.

## Docs

System documentation lives in `docs/`; start at `docs/INDEX.md`.
