# Workspace

pnpm monorepo. Node ≥ 22, pnpm 10 (pinned via `packageManager`). TypeScript
strict, source-first (no build step at this stage).

## Layout

- `packages/core` — fixed-timestep loop, entity model, math, transport interface. Imports no sibling.
- `packages/net` — schemas, binary serialization, quantization, clock sync. → core
- `packages/physics` — Rapier3d wrapper, headless-capable. → core
- `packages/server` — rooms, tick, per-client snapshots, rewind. → core, net, physics
- `packages/client` — prediction/reconciliation, interpolation, input; headless-capable (bots). → core, net, physics
- `packages/render-pixi` — PixiJS 2D/HUD renderer. Browser (DOM lib). → core
- `packages/render-three` — Three.js WebGL2 renderer. Browser (DOM lib). → core
- `games/walking-skeleton` — throwaway M2 browser demo (Vite + canvas), composes `client`/`net`/`core`. Not the deferred reference game.
- `tools/`, `infra/` — empty placeholders; populated later (SEED §7).

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

## Run the M2 demo

Two terminals from the repo root:

- `pnpm dev:server` — server on `ws://localhost:9200` (via `tsx`).
- `pnpm dev:demo` — Vite dev server for the browser demo (`http://localhost:5173`).

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
