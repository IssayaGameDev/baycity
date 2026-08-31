# Workspace

pnpm monorepo. Node ≥ 22, pnpm 10 (pinned via `packageManager`). TypeScript
strict, source-first (no build step at this stage).

## Layout

- `packages/core` — fixed-timestep loop, `createSimClock` (fixed-step time for clock-driven content), entity model, math (incl. quaternion helpers), transport interface. Imports no sibling.
- `packages/net` — schemas, binary serialization, quantization, clock sync. → core
- `packages/physics` — Rapier3d wrapper (`@dimforge/rapier3d-compat`), bodies (position+rotation) + kinematic character controller + trigger volumes (ADR 0054), headless. → core
- `packages/humanoid` — **one avatar** (ADR 0062, renamed from `character`): a blocky 11-part **rig** (`humanoidRig.ts`), its **procedural gait** (`bipedGait.ts`, renderer-agnostic — emits a `Pose`), and a Roblox-like capsule **ground controller** for a third-person camera (`groundController.ts`: `stepCharacter`, `CharacterTuning`; ADR 0012). Deliberately **not** mode-agnostic — a game opts in by depending on it, and reaches the controller through `createLocomotion` (ADR 0061). → components, core, physics (+ content, tests only)
- `packages/content` — data-driven content: the **node/component schema** (ADR 0035), validation, prefab resolution, the loader (`instantiateLevel`), the keyframe-track evaluator (`track.ts`, ADR 0029) and the asset layer (`assets.ts`, ADR 0026). Headless, no rendering. The kit and its generators were deleted in ADR 0027: nothing here produces geometry. **Never imports `@mp/components`** — where it needs a component's declaration it takes a registry as an argument. → core, net, physics
- `packages/components` — the component system (ADR 0035): the parameter-declaration layer, the registry, and the built-in definitions (engine: `Collider`/`Mesh`/`Renderer`/`MaterialOverride`/`Spawn`/`Light`; gameplay: `Checkpoint`/`Goal`/`Hazard`/`Bumper`/`Track`). Headless. → content, core (physics in tests only, where the component runtime needs a real world to be driven against)
- `packages/mode` — **the platform's game contract** (ADR 0052): one `ModeDescriptor` per game, carrying its composed component registry, character tuning, rule gizmo colours, spawn and rules `session`. No level-settings declaration: a game's rules are components, so a kill plane is a `Hazard` on a collider rather than a `fallY` knob (ADR 0053). Headless. Adding a game means writing one of these, not editing a tool. → character, components, content, core
- `packages/i18n` — tiny dependency-free localization (ADR 0016): typed `t()`, per-language tables, browser-locale match + runtime switch. Headless. → (none)
- `packages/server` — Colyseus `Server` + one `GameRoom` for every game (ADR 0052): per-client snapshot relay (no simulation, no schema), auto-join, roster. Content-free. → core, net, `colyseus`
- `packages/client` — local authoritative sim, interpolation, clock sync, input; headless-capable (bots). → core, net, physics
- `packages/render-pixi` — PixiJS 2D **UI layer** (ADR 0015): stacked transparent canvas over Three, overlay + pointer-lock-aware input, reusable widgets (panel/button/slider/list). Browser (DOM lib). → core, pixi.js
- `packages/game-client` — **the browser client every game runs** (ADR 0056): `startGameClient(descriptor)` owns the Three stage, post-FX, asset and level bundling, joining a room, interpolation, peer views, nametags, the ragdoll and spawn assembly, the pause screen, the debug pane, touch and the render loop. A game supplies a `ModeDescriptor` and an `index.html` with `#view` and `#status`. `client.ts` is one long composition root, **moved not redesigned** from `modes/parkour/src/main.ts`; decomposing it is a follow-up behind a stable entry point. Browser (DOM lib). → camera, character, client, components, content, core, i18n, mode, net, physics, render-pixi, render-three, colyseus.js, tweakpane
- `modes/_template` — **the game to copy** (ADR 0056): a `ModeDescriptor`, a minimal headless `rules.ts`, a three-line `main.ts` that lists the six steps, and a working app shell (`index.html`, vite config on a spare port). `_`-prefixed so the editor's game picker skips it. It has no level, so it throws until one is authored for it. If its `main.ts` ever has to grow, something that belongs in a package has leaked into a game. → character, components, content, core, game-client, mode, physics, render-three
- `modes/swing` — the second game, made by copying `_template` (ADR 0056). Takes the whole shared gameplay library, since its first level is a copy of parkour's; keeps no progress yet, so its checkpoints and goal are authorable and inert. `pnpm dev:swing`. → same as `_template`
- `packages/camera` — the **third-person orbit camera** (ADR 0020/0055, extracted by ADR 0056): boom, zoom, occlusion, the see-through hole, the landing dip, the own-rig hide. No DOM (the host calls `lookMouse`/`zoomNotch`) and no physics import (`observe` takes the two casts), which is what keeps the occlusion decision testable without a world. Tunables are **data** (`CAMERA_TUNABLES`), so it never learns what a Tweakpane is. Browser (DOM lib). → character, core, render-three
- `packages/render-three` — Three.js WebGL2 stage + polished greybox pipeline (IBL, ACES, soft shadows, GTAO/SMAA/bloom, material assets compiled from shader definitions, level-view, the standard bevel of ADR 0044, the procedural sky and single-input sun of ADR 0046, the content lights of ADR 0047, the per-level sun of ADR 0048) + `createCharacterRig` (realizes `@mp/humanoid`'s rig data, applies a `Pose`). Browser (DOM lib). → humanoid (rig data, types only at runtime), core, content (types), three
- `tools/netsim` — latency/jitter/loss `ClientTransport` wrapper, headless. → core. (Not wired into the current client — ADR 0013.)
- `tools/bots` — headless `colyseus.js` load clients + `load` harness (budgets 2 & 3; live integration check). → net, server, `colyseus.js`
- `tools/viewer` — localhost content inspector (`pnpm dev:viewer`): picker, orbit, overlays, jump gizmo, play-in-place (ADR 0014). Each catalog entry names the game its level belongs to (ADR 0052), which is where its registry and rule gizmo colours come from. → character, components, content, core, mode, physics, render-three
- `tools/editor` — localhost level/prefab editor (`pnpm dev:editor`; ADR 0023 authoring, ADR 0024 UI): fixed-panel DOM shell (toolbar/hierarchy/viewport/inspector/palette/status, CSS grid + hand-rolled splitters), prefab references + per-node component overrides, an Inspector generated from each component's declared parameters (ADR 0035), play-in-place on the game's own rules. Tweakpane is the Inspector panel only. **Which game it authors for is explicit** (ADR 0052): descriptors are globbed from `modes/*/src/editorMode.ts`, so it depends on every game — the direction that works, since a game cannot import a tool without a cycle. Reads/writes `content/` through a Vite dev-server file API (`vite.config.ts`), so it is a dev tool only. → character, client, components, content, core, mode, physics, render-three, every mode
- `tools/share` — opt-in remote debugging (`pnpm share`): relay + page behind two Cloudflare quick tunnels, prints one link. No workspace deps; shells out to `cloudflared`.
- `modes/parkour` — the parkour mode on Colyseus rooms (`colyseus.js`). Exports `./rules` (headless: its composed registry and rules session — run by both its own client and the editor's play-in-place, so they cannot drift) and `./editorMode` (its `ModeDescriptor`): Roblox-like controller, auto-join, nametags, data-driven levels (`default.json`, or any file by name), checkpoints/hazard/fall read as **components on the node whose collider was touched** (ADR 0035) + persistence adapter. (Rename of `games/tps`.) → character, client, components, content, core, mode, net, physics, render-three
- `content/` — level JSON as **node trees** (`levels/`; prefab files under `assets/prefabs/` are root nodes — ADR 0035) and the **asset tree** (`assets/`: textures, models, materials, shaders, sounds, fonts, each with a `.meta` sidecar holding its id — ADR 0026). What `tools/editor` reads and writes, and what the parkour mode loads by name (`?level=<file>`; no param → the code gym). Shared content, not a package. See ADR 0023.
- `infra/` — empty placeholder; populated later (SEED §7).

The server is a client-authoritative relay (ADR 0011) hosted on **Colyseus** (ADR 0013,
supersedes SEED §2's uWS transport): Colyseus owns transport/rooms/matchmaking/scale;
`GameRoom` relays peer state (no `@colyseus/schema`) and runs no content (ADR 0014). Colyseus
is pinned to **0.16** (matched client/server), default `ws` transport (uWS is a later swap),
single-process for now (scale-out deferred to deploy).

Subpaths (secondary entry points, each with its own tsconfig where the lib differs):
- `@mp/client/dom` — browser input adapters (keyboard, and the touch controls of ADR 0022: stick + jump button + look/pinch routing), DOM-enabled via
  `packages/client/tsconfig.dom.json`, so the main `@mp/client` stays headless. See ADR-0008.

## Dependency laws (SEED §6)

1. **One-way flow:** `modes/tools → packages`, never the reverse. `core` imports no sibling.
2. **Simulation never imports rendering.** `core`, `net`, `physics`, `character`, `content`, `components`,
   `server`, `client` are headless — their tsconfig `lib` is `ES2022` only (no DOM). Only
   `render-*` (and browser apps under `modes`/`tools`) add the DOM lib. A headless package that
   reaches for a DOM type fails typecheck. This is what makes bots + the loader free.
3. **Modes are thin compositions.** Since ADR 0056 this is enforced by the dependency graph rather than asked for: a mode depends on `@mp/game-client` and its own rules' packages, and *cannot* import the netcode or the UI toolkit because they are not in its `package.json`. Parkour's `main.ts` is 12 lines. Needing to modify `packages/` for a mode is a stack gap. Since ADR 0052 this holds for the **tools** too: a game contributes a `ModeDescriptor` and nothing else, so adding one touches no package and no tool. The editor depends on every mode, which is the one place the arrow points sideways rather than down — a tool that authors for N games has to know them, and a game cannot import a tool without a cycle.

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
