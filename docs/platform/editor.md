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

Document model: `src/editorDoc.ts` (`Doc`, `levelDoc`, `prefabDoc`; a `Doc` captures its `registry`; every mutation is an op batch, below). Undo: `src/opHistory.ts` (inverse ops, ADR 0089). Shortcuts: `src/shortcuts.ts` (ADR 0030).

## Content API — `editor-server.md` (ADR 0083)

The routes are `tools/editor-server/src/api.ts`, mounted by `vite.config.ts` (`filesApi` plugin: `createContentApi` with `identify → local`, in-memory locks, no git) and by the hosted server. Clients: `src/filesApi.ts` (levels, games, `me`, `serverStatus`, `acquireLock`/`releaseLock`/`releaseLockBeacon`/`heartbeatLocks`, `uploadAsset`, `lockKey`, `ApiError` with `status` and `owner`), `src/assetsApi.ts` (`loadAssetLibrary`).

### Identity, locks, upload in the editor (`src/main.ts`)

| Piece | Behaviour |
| --- | --- |
| `me` | `GET /api/me` at boot; name shown first in the status bar; `heartbeatMs`/`maxUploadBytes` read from it |
| `heldLocks` | every key this tab holds; `takeLock(path)` → holder's name or `null`; `dropAllLocks()` releases all (→ the server commits the session) |
| `openFile` | `dropAllLocks()`; a **level joins its live session** (`collab.join(name)`, below — no file lock); a prefab takes `lockKey.asset(entry.path)`; refused → `readOnlyBy`, the file still opens |
| `readOnlyBy` | toolbar `readOnly` disables Save with a title; status bar shows `read-only · locked by X`; `saveNow` refuses |
| `saveNow` | prefabs: takes the lock for `docLockKey()` first (Save-as or a new file names it now). A live level returns `true` at once: there is nothing to save |
| `newBlank` | prefab: `dropAllLocks()`; nothing locked until the first Save. Level: `createLevel(null)` (below) |
| materials, clips | `lockAsset(id)` on select (`onSelectAsset`, kinds `material`/`animation`) and before a clip save; refused ids in `lockedAssets` → `onMaterialChanged` refuses |
| heartbeat | `setInterval(heartbeatMs)`: `heartbeatLocks(held)`; a lost file lock is re-taken or turns the file read-only; `serverStatus().pushError` → `pushProblem` in the status bar |
| `pagehide` | `releaseLockBeacon` per held lock; `collab.beaconLeave()` |
| upload | `ProjectHost.onUpload(files, folder)` from a desktop drop on a folder row, folder tile or the grid (`dropTargetFor`, `folder` getter; not for *All folders* or the level's own); files over `maxUploadBytes` are named and skipped; `afterFileOp` uploads the rest |

`content/games/<game>.json` is written by `adopt` without a lock (gated only by others' locks).

The dev editor's `@content` alias is pinned to the repo's `content/` (`contentAlias(REPO_CONTENT)`): it edits that folder, never the live mirror (`content-sync.md`, ADR 0084).

**Watcher:** `watch.ignored: ['**/content/games/**']`. Every game's `rules.ts` imports its `content/games/<game>.json` and the editor bundles those modules, so a write would full-reload the editor and lose undo history right after the editor wrote it. The editor reads the files live over `/api/games`; the game's dev server still reloads (ADR 0077).

## Edits are ops (ADR 0089)

Every `Doc` mutator builds `Op`s (`@mp/content` `ops.ts`, `content.md`) and commits them through the one shared
`applyBatch` on its own level; what changed is reported on `doc.onOps({ ops, inverses })`. No-op edits (inverse
`null`) report nothing. Nodes are addressed on the wire by `NodeRef`: `refAt(i)` / `indexOfRef(ref)`.

| Mutator | Ops |
| --- | --- |
| `setTransform` / `setName` / `setParams` / `setComponentEnabled` / `addComponent` / `removeComponent` / `moveComponent` | the own op on an own node; the `setOverride*` / `addOverrideComponent` / `removeOverrideComponent` flavour on an inherited one (an inherited component's removal = `setOverrideParams unset` + `setOverrideEnabled null` + `setOverrideRemoved`) |
| `place` (level) / `placePrefab` (level) | `internPrefab` when the key is new (`internOp`, key from `freeTableKey`) + `insertNode` |
| `place` / `placePrefab` / `placeEmpty` / `placeModel` / `duplicate` / `paste` | `insertNode` (ids minted client-side; `reidSubtree` for copies) |
| `remove` / `move` / `reparent` | `removeNode` / `moveNode` |
| `extract` | `internPrefab` + `replaceNode` |
| `revert` | `setNodeOverride` (the record with the field gone, or `null`) |
| `applyToPrefab` | the own ops **scoped `table: key`** on the definition + `setNodeOverride null` |
| `setEnvironment` / `setMode` | `setEnvironment` / `setMode` |
| `setId` | not an op (the file name; live, the server sets it) |

`prefabDoc(root, registry, clips, { table })` — a prefab opened on top (`openPrefabOf`) stamps every op with
`table`, so the same op applies to `level.prefabs[table]` on any copy; locally it applies to the wrapper whose one
root *is* that entry.

**Undo** (`src/opHistory.ts`): `main.ts` attaches `onDocOps` to every document (`withOps`); batches collect in
`pending`; `recordEdit(label)` folds them (`foldBatches`: one transform op per target, last value, first inverse)
into `{ ops, inverses, label, selection: NodeRef[] }`. `undo` applies `inverses` with `applyBatch` straight on the
root level (nothing re-reported), rebuilds, restores the selection by ref; an entry whose ops no longer apply is
dropped with a status line. `coalescing` still holds `recordEdit` off during a gizmo drag. Undo inside a prefab
opened on top no longer pops back to the level. Live, the applied inverses go to the server as an ordinary batch
(`collab.submit`): an undo is an edit the room sees.

## Live levels (`src/collab.ts`, ADR 0089)

A level is not a file with a lock but a **live session** on the server (`editor-server.md`, *Live documents*):
every batch the document reports is applied locally at once and sent; the server numbers it and echoes it to
everyone, the sender included (the echo is the ack). Prefabs and materials keep the file lock and Save.

```ts
createCollab(transport: LiveTransport, hooks: CollabHooks): Collab
// join(name) resolves on the first snapshot · leave · submit(batch) · flush() · hold(refs) · release(refs) · presence(data)
// beaconLeave() · connId() · name() · peers() · holds() · pending()
httpTransport(): LiveTransport   // EventSource in, fetch POST out, sendBeacon for the way out
```

| Piece | Behaviour |
| --- | --- |
| join | `openFile` (level) → `collab.join(name)`; the snapshot's level (`latestSnapshot`) is what adoption, validation and `levelDoc` run on. A join the server refuses is the load error |
| outbound | `onDocOps` → `pending` (history) **and** `collab.submit(batch)`; the batch is *unacked* until its echo. `applyHistory` submits the inverses it applied |
| inbound | a remote batch: unacked batches rolled back (inverses, newest first), remote applied, unacked re-applied (inverses recomputed; one that no longer applies is dropped and reported); `hooks.onApplied(ops)` → `repaintAfterOps`. A seq gap or a failing apply reopens the stream: the server greets with a fresh snapshot, `reinstallLevel` rebuilds the document over it (history kept), unacked batches are re-applied and re-sent |
| rejected | a 4xx on the POST: that batch and everything after it rolled back, the later ones re-applied, `onRejected` → `history.dropWhere` (the entry holding it) + status line + repaint |
| repaint | `repaintAfterOps(ops)`: transforms only (`setTransform` / `setOverrideTransform`) → `applyPreviewPoses` + `scheduleRebuild` + `inspectorSync` + track helper; anything else → environment/postfx re-applied, `buildItems` + `rebuildLoaded`, selection put back by `indexOfRef`, `refreshUi` + `inspectorRebuild`. During a gizmo drag ops queue in `deferredRemote` (the data is already changed) and repaint at drag end |
| Save | toolbar `live` hides Save and disables the name field; `dirty` stays `false` live (`recordEdit`, `applyHistory`), so `guardUnsaved` never asks. `saveNow` returns `true` |
| Play | `startFramePlay`: live → `collab.flush()` first (the game reads the file), else the prefab path `saveNow()` |
| New / Duplicate | `createLevel(from)`: `askName` (`confirm.ts`) → `^[\w-]+$` → refused if `listFiles('levels')` has it → `PUT /api/levels/<name>` a `blankLevel` with the active mode, or the open level (`loadLevelRaw`, the server's live copy) with `id` set → `refreshFileList` → `openFile`. Toolbar `Duplicate` in level mode |
| status bar | `live` or `live · with Adrien, Titouan` (peers other than this `connId`) |
| leave | `dropAllLocks` → `collab.leave()`; `pagehide` → `beaconLeave()` |

Two tabs of one person are two `connId`s: separate acks, separate holds. Holds and presence are wired but unused
until phase 3.

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

## Game settings (ADR 0087)

Under the Game row: one Tweakpane field per number setting in `activeMode.settings`, and **one section with a
graph per curve setting** (`src/curveEditor.ts`, ADR 0088: drag, click to add, double-click/Delete to remove,
fields for the selected point, `default`, its own undo/redo — Ctrl+Z/Ctrl+Y with the graph focused, or ↶ ↷ — since every edit saves at once; wheel zooms around the cursor (X over the bottom axis, Y over the left, both over the plot), right-/Shift-drag pans, `fit`/F reframes, `⤢` opens the same graph large over the viewport; log axis when `logY`; readout of the value under the pointer and the
last segment's ratio). `host.settings()` → `{ decls, values }`, values = `readSettings(decls, gameData[game].settings)`;
a change → `host.onSettingChanged(key, number | CurvePoint[])` → `gameData[game].settings[key] = value` and
`saveGame` writes the **whole** file (`components` + `settings`). `adopt` spreads the file too, so a component
adoption keeps the settings. `loadGame` accepts numbers and point lists (`normalizePoints`).

## Play

**A level plays in the real game** (ADR 0086): `startPlay` → `gamePageUrl()` (`me.games[activeMode.name]`,
from `/api/me`) → `startFramePlay(url)`: live level → `collab.flush()`; prefab → `saveNow()` if dirty (a refused save is no play); then an
`<iframe id="game-frame">` over `#centre` at `${url}?level=${fileState.name}`; `playing = true`, orbit off. Stop
(toolbar) removes the frame. Esc inside the frame is the game's pause; the `pointerlockchange` exit applies only
to the in-editor loop. Hosted: `url` is the proxied `/play/<game>/`; dev: `http://localhost:<port>/` with
`pnpm dev:<game>` running. A prefab, or a game the server has no page for, falls through to the loop below.

## Play-test in place (`startPlay`/`stopPlay`) — prefabs

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
