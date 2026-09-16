# Multiplayer Web Stack

A reusable multiplayer game stack for HTML5/TypeScript browser games — 3D via Three.js (WebGL2) with a PixiJS 2D HUD, client-authoritative netcode. Games are built as thin compositions on top of the stack.

**Status:** client-authoritative stack (ADR 0011) with multiplayer **rooms on Colyseus** (ADR 0013) and games as modes: `modes/parkour` (the reference obby), `modes/swing`, and `modes/keyboard` (a Keyboard Escape clone, the game in active development — `docs/games/keyboard/`). Each client simulates its own entity and reports state; a Colyseus room relays peers, interpolated on a clock-synced timeline (no `@colyseus/schema`). Players auto-join rooms (fill-then-create, max 20), get auto-random names + nametags, and persist checkpoints locally. Includes delta + quantized snapshots, clock sync, and budget-validating bots. (History: server-authoritative through M10, then the authority model was reversed — ADR 0011.) See `docs/INDEX.md` for system docs and `docs/platform/budgets.md` for load numbers.

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
file from `content/<game>/levels/` instead (`?level=level1`); the name also picks the room, so tabs on
different levels will not see each other. Author those files with `pnpm dev:editor`.

With no `?level=` you get **`content/<game>/levels/default.level.json`**: a floor, a climb, a gap, an elevator, a
turntable, a hazard pad, a checkpoint and a goal. One of each mechanic, deliberately a placeholder rather than
designed content — it exists so the game always boots into something. It is a normal level file, so open it in
the editor and change it.

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

Reports downstream bandwidth per client (budget 2) and server tick time (budget 3). See `docs/platform/budgets.md`.

## Deploy

The game itself is not deployed yet. The **editor** is: `https://editor.playgorbo.com`, a Hetzner box behind
Cloudflare Access, for the people making content (`CONTRIBUTING.md`). Their work lands on the `content` branch;
merge it into master when it is good.

```sh
pnpm deploy:editor   # after editor or game changes: merge master into content on the box, rebuild, restart
pnpm sync:content    # live mirror of the box's content into .content-live/, so the local game sees every save
```

Day to day: `pnpm dev:server`, `pnpm dev:keyboard`, `pnpm sync:content`; edit at `editor.playgorbo.com`; the game
reloads on save. Play in the hosted editor runs the real game on the open level (ADR 0086); it also lives at `https://dev.playgorbo.com` (ADR 0085). Needs a `.env` from `.env.example` with an Access service token. First-time box setup and the
config are in `deploy/editor/` (`docs/platform/editor-server.md`, `docs/platform/content-sync.md`).

## Docs

System documentation lives in `docs/`; start at `docs/INDEX.md`.
