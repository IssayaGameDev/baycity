# Workspace

pnpm monorepo. Node ≥ 22, pnpm 10 (pinned via `packageManager`). TypeScript
strict, source-first (no build step at this stage).

## Layout

- `packages/core` — fixed-timestep loop, `createSimClock` (fixed-step time for clock-driven content), entity model, math (incl. quaternion helpers), transport interface. Imports no sibling.
- `packages/net` — schemas, binary serialization, quantization, clock sync. → core
- `packages/physics` — Rapier3d wrapper (`@dimforge/rapier3d-compat`), bodies (position+rotation) + kinematic character controller, headless. → core
- `packages/character` — the stack-level kinematic character controller (`stepCharacter`, `CharacterTuning`; ADR 0012), mode-agnostic, plus the blocky 11-part **rig** and **procedural animator** (renderer-agnostic: emits a `Pose`). → core, net, physics
- `packages/content` — data-driven content: schema, validation, loader (`instantiateLevel`), greybox kit + generators (ADR 0014). Headless, no rendering. → core, net, physics
- `packages/i18n` — tiny dependency-free localization (ADR 0016): typed `t()`, per-language tables, browser-locale match + runtime switch. Headless. → (none)
- `packages/server` — Colyseus `Server` + `ParkourRoom`: per-client snapshot relay (no simulation, no schema), auto-join, roster. Content-free. → core, net, `colyseus`
- `packages/client` — local authoritative sim, interpolation, clock sync, input; headless-capable (bots). → core, net, physics
- `packages/render-pixi` — PixiJS 2D **UI layer** (ADR 0015): stacked transparent canvas over Three, overlay + pointer-lock-aware input, reusable widgets (panel/button/slider/list). Browser (DOM lib). → core, pixi.js
- `packages/render-three` — Three.js WebGL2 stage + polished greybox pipeline (IBL, ACES, soft shadows, GTAO/SMAA/bloom, style→material, level-view) + `createCharacterRig` (realizes `@mp/character`'s rig data, applies a `Pose`). Browser (DOM lib). → character (rig data, types only at runtime), core, content (types), three
- `tools/netsim` — latency/jitter/loss `ClientTransport` wrapper, headless. → core. (Not wired into the current client — ADR 0013.)
- `tools/bots` — headless `colyseus.js` load clients + `load` harness (budgets 2 & 3; live integration check). → net, server, `colyseus.js`
- `tools/viewer` — localhost content inspector (`pnpm dev:viewer`): picker, orbit, overlays, jump gizmo, play-in-place (ADR 0014). → character, content, core, physics, render-three
- `tools/share` — opt-in remote debugging (`pnpm share`): relay + page behind two Cloudflare quick tunnels, prints one link. No workspace deps; shells out to `cloudflared`.
- `modes/parkour` — the parkour mode on Colyseus rooms (`colyseus.js`): Roblox-like controller, auto-join, nametags, data-driven level (kit sampler), physics-trigger checkpoints/hazard/fall + persistence adapter. (Rename of `games/tps`.) → character, client, content, core, net, physics, render-three
- `content/` — level JSON (`levels/level1.json`). Shared content, not a package.
- `infra/` — empty placeholder; populated later (SEED §7).

The server is a client-authoritative relay (ADR 0011) hosted on **Colyseus** (ADR 0013,
supersedes SEED §2's uWS transport): Colyseus owns transport/rooms/matchmaking/scale;
`ParkourRoom` relays peer state (no `@colyseus/schema`) and runs no content (ADR 0014). Colyseus
is pinned to **0.16** (matched client/server), default `ws` transport (uWS is a later swap),
single-process for now (scale-out deferred to deploy).

Subpaths (secondary entry points, each with its own tsconfig where the lib differs):
- `@mp/client/dom` — browser input adapters (keyboard, and the touch controls of ADR 0022: stick + jump button + look/pinch routing), DOM-enabled via
  `packages/client/tsconfig.dom.json`, so the main `@mp/client` stays headless. See ADR-0008.

## Dependency laws (SEED §6)

1. **One-way flow:** `modes/tools → packages`, never the reverse. `core` imports no sibling.
2. **Simulation never imports rendering.** `core`, `net`, `physics`, `character`, `content`,
   `server`, `client` are headless — their tsconfig `lib` is `ES2022` only (no DOM). Only
   `render-*` (and browser apps under `modes`/`tools`) add the DOM lib. A headless package that
   reaches for a DOM type fails typecheck. This is what makes bots + the loader free.
3. **Modes are thin compositions.** Needing to modify `packages/` for a mode is a stack gap.

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

- `pnpm test` — Vitest over `packages`/`tools`/`modes` `src/**/*.test.ts` (pool `forks`, for the Rapier WASM addon + sockets).
- `pnpm typecheck` — root config files, then `tsc --noEmit` in every workspace project
  (`pnpm -r run typecheck`), each applying its own `lib`.
- `pnpm check` — typecheck + test. The milestone gate.

## Run the demo

Two terminals from the repo root:

- `pnpm dev:server` — Colyseus relay server on `ws://localhost:9200` (via `tsx`).
- `pnpm dev:parkour` — Vite dev server for the parkour mode, `modes/parkour` (`http://localhost:5174`).

Open the demo in two tabs to get two players auto-joined into one shared room.

To inspect content in isolation: `pnpm dev:viewer` — the content viewer, `tools/viewer`
(`http://localhost:5175`); no server needed.

## Play with someone off-network (debug only)

`pnpm share` (needs `cloudflared` on PATH). Reuses whatever dev servers are already
running, starts the rest, opens a Cloudflare quick tunnel per port and prints one link
to send. Ctrl+C tears down the whole tree.

The page and the relay land on separate origins, so the page reads its relay endpoint
from `?server=wss://…` (`modes/parkour/src/main.ts`), falling back to
`ws://<page host>:9200`. Vite accepts the tunnel's `Host` via `allowedHosts` in
`modes/parkour/vite.config.ts`. Quick-tunnel hostnames are random per run, so the link
changes every session. Traffic is relayed through Cloudflare's edge — latency is
inflated, so never read game-feel or clock-sync numbers off it.

The server runs through `tsx` (dev tooling; not a shipped/runtime dependency). Browser apps are
served from TypeScript source by Vite (no stack build step).

## Adding a package

1. `packages/<name>/` with `package.json` (`name` `@mp/<name>`, `type: module`,
   `exports` → `./src/index.ts`, a `typecheck` script) and `tsconfig.json` extending
   `../../tsconfig.base.json`.
2. Browser package? Add `"lib": ["ES2022", "DOM", "DOM.Iterable"]` to its `compilerOptions`.
   Headless package? Leave `lib` inherited (no DOM).
3. Declare workspace deps as `"@mp/<dep>": "workspace:*"`, respecting the one-way flow.
4. Add `src/index.ts` and at least one `src/*.test.ts`. Run `pnpm install` then `pnpm check`.
