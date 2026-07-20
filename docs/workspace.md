# Workspace

pnpm monorepo. Node ≥ 22, pnpm 10 (pinned via `packageManager`). TypeScript
strict, source-first (no build step at this stage).

## Layout

- `packages/core` — fixed-timestep loop, entity model, math, transport interface. Imports no sibling.
- `packages/net` — schemas, binary serialization, quantization, clock sync. → core
- `packages/physics` — Rapier3d wrapper (`@dimforge/rapier3d-compat`), headless. → core
- `packages/server` — Colyseus `Server` + `TpsRoom`: per-client snapshot relay (no simulation, no schema), auto-join, roster. → core, net, physics, `colyseus`
- `packages/client` — local authoritative sim, interpolation, clock sync, input; headless-capable (bots). → core, net, physics
- `packages/render-pixi` — PixiJS 2D HUD, stacked canvas over Three (SEED §2). Browser (DOM lib). → core, pixi.js
- `packages/render-three` — Three.js WebGL2 stage; re-exports THREE. Browser (DOM lib). → core, three
- `tools/netsim` — latency/jitter/loss `ClientTransport` wrapper, headless. → core. (Not wired into the current client — ADR 0013.)
- `tools/bots` — headless `colyseus.js` load clients + `load` harness (budgets 2 & 3; live integration check). → net, server, `colyseus.js`
- `games/tps` — 3D TPS demo on Colyseus rooms (`colyseus.js`): Roblox-like controller, auto-join, nametags, local checkpoints, clock-driven elevator, static course. The current throwaway exercise.
- `infra/` — empty placeholder; populated later (SEED §7).

The server is a client-authoritative relay (ADR 0011) hosted on **Colyseus** (ADR 0013,
supersedes SEED §2's uWS transport): Colyseus owns transport/rooms/matchmaking/scale; `TpsRoom`
relays peer state (no `@colyseus/schema`). Colyseus is pinned to **0.16** (matched client/server),
default `ws` transport (uWS is a later swap), single-process for now (scale-out deferred to
deploy). The TPS sim lives under `@mp/server` for historical reasons (see subpaths below).

Subpaths (secondary entry points, each with its own tsconfig where the lib differs):
- `@mp/server/tps` — shared deterministic TPS character sim + world geometry. Run by the TPS
  client (its own body) and bots; the server no longer runs it. See ADR-0010/0011.
- `@mp/client/dom` — browser input adapters (keyboard, touch joystick), DOM-enabled via
  `packages/client/tsconfig.dom.json`, so the main `@mp/client` stays headless. See ADR-0008.

## Dependency laws (SEED §6)

1. **One-way flow:** `games → packages`, never the reverse. `core` imports no sibling.
2. **Simulation never imports rendering.** `core`, `net`, `physics`, `server`, `client`
   are headless — their tsconfig `lib` is `ES2022` only (no DOM). Only `render-*` add the
   DOM lib. A headless package that reaches for a DOM type fails typecheck. This is what
   makes bots free.
3. **Games are thin compositions.** Needing to modify `packages/` for a game is a stack gap.

Not yet CI-enforced — an automated boundary check (dependency direction + no DOM in
headless packages) is a later addition. Today the `lib` split enforces (2) at the type level.

## Conventions

- Package name is `@mp/<dir>`. **Source-first:** `package.json` `exports` points at
  `./src/index.ts`; there is no build/emit step. Vite (client/render), Vitest (tests), and
  `tsc --noEmit` (typecheck) all consume the TypeScript sources directly via
  `moduleResolution: bundler`. Add an emit step only when publishing or Node-native
  execution requires it.
- Cross-package imports use the package name (`import { X } from '@mp/core'`), never a
  relative path across a package boundary.
- Tests are colocated: `src/**/*.test.ts` (Vitest). Import APIs from `vitest` — no globals.
- Strict TS everywhere; `any` is forbidden (CLAUDE.md).

## Scripts (run from repo root)

- `pnpm test` — Vitest over all packages (pool `forks`, for the native uWS addon + sockets).
- `pnpm typecheck` — root config files, then `tsc --noEmit` in every workspace project
  (`pnpm -r run typecheck`), each applying its own `lib`.
- `pnpm check` — typecheck + test. The milestone gate.

## Run the demo

Two terminals from the repo root:

- `pnpm dev:server` — Colyseus relay server on `ws://localhost:9200` (via `tsx`).
- `pnpm dev:tps` — Vite dev server for the TPS demo, `games/tps` (`http://localhost:5174`).

Open the demo in two tabs to get two players auto-joined into one shared room.

The server runs through `tsx` (dev tooling; not a shipped/runtime dependency). The
browser client is served from TypeScript source by Vite (no stack build step).

## Adding a package

1. `packages/<name>/` with `package.json` (`name` `@mp/<name>`, `type: module`,
   `exports` → `./src/index.ts`, a `typecheck` script) and `tsconfig.json` extending
   `../../tsconfig.base.json`.
2. Browser package? Add `"lib": ["ES2022", "DOM", "DOM.Iterable"]` to its `compilerOptions`.
   Headless package? Leave `lib` inherited (no DOM).
3. Declare workspace deps as `"@mp/<dep>": "workspace:*"`, respecting the one-way flow.
4. Add `src/index.ts` and at least one `src/*.test.ts`. Run `pnpm install` then `pnpm check`.
