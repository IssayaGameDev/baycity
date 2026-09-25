# Workspace

pnpm monorepo. Node ≥ 22, `pnpm@10.32.1` (`packageManager`). TypeScript strict, source-first: `exports` → `./src/*.ts`, no emit; Vite, Vitest, `tsc --noEmit` read sources via `moduleResolution: bundler`. `pnpm-workspace.yaml`: `packages/*`, `modes/*`, `tools/*`, `infra/*`.

## Packages (`@mp/<dir>`)

→ = workspace deps from `package.json`. Headless = inherited `lib: ["ES2022"]`, no DOM.

| Package | One line | → |
| --- | --- | --- |
| `core` | fixed-timestep loop, `createSimClock`, entity model, math, transport interface | (none) |
| `net` | wire schemas, binary serialization, quantization, clock sync | core |
| `physics` | Rapier3d wrapper: bodies, kinematic character, triggers (ADR 0054); headless | core |
| `content` | node/component schema (ADR 0035), validation, prefabs, `instantiateLevel`, tracks (ADR 0029), assets (ADR 0026); takes a registry, never imports `components` | core, physics |
| `components` | declarations, registry, engine + shared gameplay components, `sharedComponents` (ADR 0077) | content, core, physics |
| `humanoid` | the one avatar (ADR 0062): rig, gait, capsule ground controller, `createLocomotion` (ADR 0061) | components, core, physics |
| `mode` | `ModeDescriptor` — the game contract (ADR 0052); `spawnFrom`, actions | components, content, core, humanoid, physics |
| `i18n` | typed `t()`, language tables (ADR 0016) | (none) |
| `server` | Colyseus `Server` + one `GameRoom`: snapshot relay, `filterBy(['game','level'])`, `DEFAULT_PORT = 9200` | core, net, `colyseus@0.16.5` |
| `client` | local authoritative sim, interpolation, clock sync, input; subpath `@mp/client/dom` (`tsconfig.dom.json`) | core, net, physics |
| `render-pixi` | PixiJS 2D UI layer (ADR 0015); DOM | core, pixi.js |
| `render-three` | Three.js stage + greybox pipeline, `createCharacterRig`; DOM | humanoid, content, core, three |
| `camera` | third-person orbit camera (ADR 0020/0055) | humanoid, core, render-three |
| `game-client` | services a browser game composes (ADR 0056/0065): `createNetHost`, `loadLevelInto`, `worldFromBase`, `createScene`, `createShell`; DOM | client, components, content, core, i18n, mode, net, physics, render-pixi, render-three, colyseus.js |
| `tps` | the shipped third-person game as a package, `startTpsClient` (ADR 0065); DOM | camera, client, components, content, core, game-client, humanoid, i18n, mode, net, physics, render-pixi, render-three, stats.js, tweakpane |

## Games (`@mode/<dir>`, `modes/*`)

Each exports `./editorMode` (`<NAME>_MODE: ModeDescriptor`) and `./rules` (headless registry + session). → components, content, core, game-client, humanoid, mode, physics, render-three, tps (keyboard + render-pixi).

| Dir | Descriptor | Port | Notes |
| --- | --- | --- | --- |
| `_template` | `TEMPLATE_MODE` | 5179 | the game to copy (ADR 0056); `_` hides it from the editor; no level → throws at boot |
| `parkour` | `PARKOUR_MODE` | 5174 | `main.ts` 16 lines |
| `swing` | `SWING_MODE` | 5175 | **same port as `tools/viewer`** |
| `keyboard` | `KEYBOARD_MODE` | 5177 | Keyboard Escape (ADR 0069/0073) |

Every game `vite.config.ts`: `plugins: [contentBanner(), gameContent('<game>')]` (what it carries of `content/`, `content-sync.md`), `allowedHosts: ['.trycloudflare.com', '.playgorbo.com']`, `proxy: '/relay' → http://localhost:9200` (ws, ADR 0074), `build.target: es2022`; keyboard and `_template` also `base: MP_BASE ?? '/'` (ADR 0086) and, with `MP_BASE` set, `/api` → `:8080` and no watch on `content/<game>/levels/**` (ADR 0089).

## Tools — see `tooling.md`, `editor.md`

| Dir | Run | → |
| --- | --- | --- |
| `editor` | `pnpm dev:editor`, 5176 | @mode/parkour, camera, humanoid, client, components, content, core, mode, physics, render-three; all games via glob; mounts `editor-server`'s API by relative import |
| `editor-server` | `pnpm --filter @mp/editor-server run start <config>`, 8080 on the box | content (relative path); `git`, `tsx` |
| `content-sync` | `pnpm sync:content` | none; a service token in `.env` (`content-sync.md`) |
| `viewer` | `pnpm dev:viewer`, 5175 | @mode/parkour, humanoid, components, content, core, mode, physics, render-three, tweakpane |
| `bots` | `pnpm --filter @mp/bots run load` | net, server, colyseus.js |
| `netsim` | library only | core |
| `share` | `pnpm share [game]` | none; `cloudflared` on PATH |

`content/` — shared data, not a package: `levels/*.json`, `games/<game>.json`, `assets/**` + `.meta` sidecars; on master it arrives by merging the `content` branch. `.content-live/` — the git-ignored live mirror; `content-root.ts` + `.env` decide which of the two a dev server bundles (`@content` alias, `content-sync.md`). `deploy/editor/` — the hosted editor's setup/update scripts, unit and config example (`editor-server.md`). `infra/` — README only, deferred.

## Dependency laws (SEED §6)

1. **One-way:** `modes/tools → packages`, never back; `core` imports no sibling. Deliberate exception: editor and viewer depend on games (ADR 0052).
2. **Simulation never imports rendering.** Headless: `core`, `net`, `physics`, `humanoid`, `content`, `components`, `mode`, `i18n`, `server`, `client`. DOM lib only in `render-*`, `camera`, `game-client`, `tps`, browser apps. Enforced by the `lib` split at typecheck.
3. **Modes are thin compositions:** a game is `ModeDescriptor` + `rules.ts`; netcode and UI toolkit are absent from its `package.json`.

Not CI-enforced beyond (2).

## `content/<game>/game.json` (ADR 0077)

`{ "components": ["Bumper", "Hazard"], "settings"?: { … } }` — shared gameplay components the game opts into, and its settings (ADR 0087, edited in the editor's Game row; absent keys are the game's defaults). Imported by its `rules.ts` (`sharedComponents(game.components)`), appended by the editor over `/api/games`. Current: `_template` Hazard; `keyboard` Bumper, Hazard; `parkour`, `swing` Bumper, Checkpoint, Goal, Hazard, Track. A non-shared name throws at registry build.

**Vite watcher:** the editor ignores `**/content/*/game.json` (its bundle imports those files via every `rules.ts`; a write would full-reload it). Game dev servers do watch them.

## Scripts (root `package.json`)

| Script | Does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit -p tsconfig.json`, then `pnpm -r run typecheck` |
| `pnpm test` / `test:watch` | Vitest projects `unit` (`{packages,tools,modes}/*/src/**/*.test.ts`, `pool: forks`) + `live-server` (`tools/bots/src/matchmaking.test.ts`, `pool: threads`) |
| `pnpm check` | typecheck + test — milestone gate |
| `pnpm dev:server` | relay `ws://localhost:9200` (`tsx watch`; `PORT` overrides) |
| `pnpm dev:parkour` / `dev:swing` / `dev:keyboard` | game on its port |
| `pnpm dev:viewer` / `dev:editor` | 5175 / 5176 |
| `pnpm share [game]` | quick tunnel |
| `pnpm deploy:editor` | `ssh root@2.28.227.20 bash -s < deploy/editor/update.sh` — redeploy the hosted editor (ADR 0083) |
| `pnpm sync:content` | live mirror of the hosted editor's content into `.content-live/` (ADR 0084) |

Build: per browser app, `pnpm --filter <pkg> run build` (`vite build`); no root build script.

Run: `pnpm dev:server` + `pnpm dev:<game>`; two tabs auto-join one room. `?level=<file>` picks a `content/<game>/levels` file (also the matchmaking filter); `?server=wss://…` overrides the relay.

Conventions: cross-package imports by package name; tests colocated `src/**/*.test.ts`, import from `vitest`; `any` forbidden; `tsconfig.base.json` sets `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.

## Adding a package

1. `packages/<name>/package.json`: `@mp/<name>`, `type: module`, `exports: { ".": "./src/index.ts" }`, `typecheck: tsc --noEmit`; `tsconfig.json` extends `../../tsconfig.base.json`.
2. Browser → `lib: ["ES2022", "DOM", "DOM.Iterable"]`; headless → inherit.
3. Deps `"@mp/<dep>": "workspace:*"`, respecting law 1.
4. `src/index.ts` + one `src/*.test.ts`; `pnpm install`; `pnpm check`.

## Adding a game (`modes/_template/src/main.ts`)

1. Copy `modes/_template` → `modes/<yours>` (skip `node_modules`, `dist`).
2. Rename `TEMPLATE_MODE`, `TEMPLATE_REGISTRY`, `templateSession`; set `name`/`label` in `editorMode.ts`.
3. `package.json` → `@mode/<yours>`.
4. `vite.config.ts` → free port; keep `allowedHosts` + `/relay`; `gameContent('<game>')` with the new name.
5. Root `dev:<yours>` script → `pnpm install`. Add to `SHARED_GAMES` (`tools/share/src/index.ts`) to make it shareable.
6. `content/<yours>/game.json` (path imported by `rules.ts`) + a level in `content/<yours>/levels/`, authored in the editor with the game selected — the folder is what makes it yours (ADR 0108). Until then it throws at boot.

No tool or package edits: the editor globs `modes/*/src/editorMode.ts`; the server filters by `game`.
