# Editor — `tools/editor`

Level/prefab editor. `pnpm dev:editor` → `http://localhost:5176` (the dev host), or `https://editor.playgorbo.com` (the hosted one, `editor-server.md`, ADR 0083). Reads/writes `content/` through the content API. Authoring model ADR 0023, UI shell ADR 0024, game-explicit authoring ADR 0052.

## What it authors

| Document | On disk | Written via |
| --- | --- | --- |
| Level (node tree + `config`) | `content/levels/<name>.json` | `PUT /api/levels/<name>` (`saveFile`, `src/filesApi.ts`); locked while open (ADR 0083) |
| Prefab (a root `Node`) | `content/assets/prefabs/<name>.prefab.json` — an **asset** with a `.meta` id (ADR 0026) | `PUT /assets/<path>` (`savePrefab`/`createPrefab`, `src/assetsApi.ts`) |
| Game shared-component list | `content/games/<game>.json` | `PUT /api/games/<game>` (`saveGame`) — appended by adoption (ADR 0077) |
| Materials, clips | `content/assets/**` JSON | `PUT /assets/<path>` |

`saveNow` (`src/main.ts`) sets the document `id` to the file name and writes the **root** document, not a prefab opened on top (`docStack`).

## Panel layout (`tools/editor/index.html`)

One CSS grid `#app`; `--left`/`--right`/`--bottom` written by `createSplitter` (`src/splitter.ts`). No UI framework; Tweakpane only inside the Inspector (ADR 0024).

| Area | Element | Module |
| --- | --- | --- |
| Top | `#toolbar` — level/prefab mode, **Game** picker, file list, name, Save, New, Back, gizmo T/R/S, space, snap/step, Play, grid, markers | `src/toolbar.ts` |
| Left | `#hierarchy` — node tree + context menu | `src/hierarchy.ts`, `src/menu.ts` |
| Centre | `#view` — Three stage, orbit, transform gizmo, placement clicks | `src/main.ts` |
| Right | `#insp-head`, `#inspector`, `#asset-inspector` | `src/inspector.ts`, `src/assetInspector.ts` |
| Bottom tabs | `#palette` **Project** (asset tree, previews) / `#timeline` **Animation** (ADR 0051) | `src/projectPanel.ts`, `src/assetTree.ts`, `src/previews.ts`, `src/timeline.ts`, `src/trackEdit.ts` |
| Status | `#status` | `setStatus` |

Document model: `src/editorDoc.ts` (`Doc`, `levelDoc`, `prefabDoc`; a `Doc` captures its `registry`). Undo: `src/history.ts`. Shortcuts: `src/shortcuts.ts` (ADR 0030).

## Content API — `editor-server.md` (ADR 0083)

The routes are `tools/editor-server/src/api.ts`, mounted by `vite.config.ts` (`filesApi` plugin: `createContentApi` with `identify → local`, in-memory locks, no git) and by the hosted server. Clients: `src/filesApi.ts` (levels, games, `me`, `serverStatus`, `acquireLock`/`releaseLock`/`releaseLockBeacon`/`heartbeatLocks`, `uploadAsset`, `lockKey`, `ApiError` with `status` and `owner`), `src/assetsApi.ts` (`loadAssetLibrary`).

### Identity, locks, upload in the editor (`src/main.ts`)

| Piece | Behaviour |
| --- | --- |
| `me` | `GET /api/me` at boot; name shown first in the status bar; `heartbeatMs`/`maxUploadBytes` read from it |
| `heldLocks` | every key this tab holds; `takeLock(path)` → holder's name or `null`; `dropAllLocks()` releases all (→ the server commits the session) |
| `openFile` | `dropAllLocks()`, then `takeLock(lockKey.level(name))` / `lockKey.asset(entry.path)`; refused → `readOnlyBy`, the file still opens |
| `readOnlyBy` | toolbar `readOnly` disables Save with a title; status bar shows `read-only · locked by X`; `saveNow` refuses |
| `saveNow` | takes the lock for `docLockKey()` first (Save-as or a new file names it now) |
| `newBlank` | `dropAllLocks()`; nothing locked until the first Save |
| materials, clips | `lockAsset(id)` on select (`onSelectAsset`, kinds `material`/`animation`) and before a clip save; refused ids in `lockedAssets` → `onMaterialChanged` refuses |
| heartbeat | `setInterval(heartbeatMs)`: `heartbeatLocks(held)`; a lost file lock is re-taken or turns the file read-only; `serverStatus().pushError` → `pushProblem` in the status bar |
| `pagehide` | `releaseLockBeacon` per held lock |
| upload | `ProjectHost.onUpload(files, folder)` from a desktop drop on a folder row, folder tile or the grid (`dropTargetFor`, `folder` getter; not for *All folders* or the level's own); files over `maxUploadBytes` are named and skipped; `afterFileOp` uploads the rest |

`content/games/<game>.json` is written by `adopt` without a lock (gated only by others' locks).

The dev editor's `@content` alias is pinned to the repo's `content/` (`contentAlias(REPO_CONTENT)`): it edits that folder, never the live mirror (`content-sync.md`, ADR 0084).

**Watcher:** `watch.ignored: ['**/content/games/**']`. Every game's `rules.ts` imports its `content/games/<game>.json` and the editor bundles those modules, so a write would full-reload the editor and lose undo history right after the editor wrote it. The editor reads the files live over `/api/games`; the game's dev server still reloads (ADR 0077).

## Game discovery (`src/modes.ts`)

- `MODES`: `import.meta.glob('../../../modes/*/src/editorMode.ts', { eager: true })`; every export passing structural `isDescriptor` (`name`, `registry`, `session`) is installed by `name`; duplicates warn, first wins.
- Paths containing `/modes/_` skipped → `modes/_template` never in the picker.
- `MODE_LIST` sorted by `label`; `modeOf(level)`; `soleMode()` = the only installed game, else `undefined`.
- `package.json` lists only `@mode/parkour`; other games enter via the glob's relative path. `tsconfig.json` includes `content/levels/*.json`, `content/games/*.json`.

## Registry a level is edited against (`src/main.ts`)

| Symbol | Role |
| --- | --- |
| `activeMode` | from the opened level's `config.mode.name` (fallback `soleMode()`), or the toolbar Game picker (`setGame` also opens that game's first level) |
| `gameData` | per game, `content/games/<game>.json` via `loadGame` at boot (`reloadAssets`) and after each `adopt` |
| `registryFor(mode)` | `mode.registry` + `sharedComponents(gameData[mode.name] − present)` — live data merged over the bundled code |
| `registry()` | `registryFor(activeMode)`, or `DEFAULT_REGISTRY` with no game |
| `adoptable()` | `SHARED_COMPONENT_TYPES` the game lacks (`Bumper`, `Checkpoint`, `Goal`, `Hazard`, `Track`) |
| `adopt(types)` | shared ∧ new → `saveGame` → `gameData` → `reopenWithRegistry()` |

Adoption points (ADR 0077):
1. **Open** (`openFile`): `componentTypesInRaw(raw)` unknown-but-shared → adopted before `validateLevel`; any other unknown type is a load error in the status bar.
2. **Place** (`armAsset`): `missingIn(assetId)` splits a prefab's unknown types into `shared`/`foreign`; shared adopted before arming — not while a prefab is open on top (a prefab belongs to no game).
3. **Add Component** (Inspector button, Hierarchy submenu): `adoptable()` listed beside addable types; pick → `adopt` → `doc.addComponent`.

File list filtered by game: `visibleLevels()` keeps entries whose `mode` is absent or equals `activeMode.name`.

## Refusing another game's private components (ADR 0076)

- `unknownComponentTypes(root, registry)` (`src/editorDoc.ts`), pure.
- `unplaceableWhy(assetId)` non-null only for `foreign` types → Project tile greyed, reason in tooltip (`unplaceableWhy` host option, `src/projectPanel.ts`); context-menu "Place in the level" disabled with the same reason.
- `Doc.placePrefab` returns `-1` on any remaining unknown type — second gate.

## Play-test in place (`startPlay`/`stopPlay`)

The game's own code, not a copy (ADR 0052):

| Piece | Source |
| --- | --- |
| Spawn | `activeMode.spawn(loaded)`; `{0,3,0}` with no game |
| Rules | `activeMode.session(loaded)` → `ModeSession` |
| Components | `createComponentRuntime(loaded, registry(), { character, effects: rules.effects, … })` incl. `player` components and `playerDefs(host)` (ADR 0059/0061) |
| Movement | `playComponents.locomote(...)` — no game / no locomotion component → no movement |
| Actions | `heldActions()` from the game's `actions` |
| Loop | `createLocalController` + `startFixedLoop`; tick: `fixedUpdate` → `loaded.update` → `world.step` → `locomote` → `world.step` (ADR 0058) |
| Contacts | `contact([...collisions, ...overlaps])` (ADR 0054) |
| Death | `rules.takeDeath()` → `setPosition(rules.respawnAt())`, velocities zeroed; no ragdoll, no persistence |
| Teleport | `rules.takeTeleport?.()` non-null → same reposition (ADR 0073) |
| View | `addLevel(..., { cutout })` — occlusion cutout as in game (ADR 0055) |

Esc / pointer-lock loss exits play; play stops track preview.

## Inspector — Add Component (`src/inspector.ts`)

`addComponentSection` per component. `Add Component` lists `doc.registry` types not on the node plus `host.adoptable()`; disabled when both empty. Adopted types go through `host.adopt(type)` then are added to the rebuilt document. Params default from `registry.defaults(type)`. Prefab placements: "push into shared prefab" → `Doc.applyOverrides` (host `applyToPrefab`).

## Level validation test (`src/levels.test.ts`)

Every `content/levels/*.json`: `validateLevel(raw, MODES[config.mode.name]?.registry ?? DEFAULT_REGISTRY)` must not throw. Tripwires: level dir non-empty, `MODES` non-empty. Lives here because only the editor can import every game's registry without inverting dependencies.
