# Editor — `tools/editor`

Level/prefab editor. `pnpm dev:editor` → `http://localhost:5176` (the dev host), or `https://editor.playgorbo.com` (the hosted one, `editor-server.md`, ADR 0083). Reads/writes `content/` through the content API. Authoring model ADR 0023, UI shell ADR 0024, game-explicit authoring ADR 0052.

## What it authors

| Document | On disk | Written via |
| --- | --- | --- |
| Level (node tree + `config`) | `content/<game>/levels/<name>.level.json` | `PUT /api/levels/<game>/<name>` (`saveFile`, `src/filesApi.ts`); locked while open (ADR 0083). Renamed and deleted through `POST /api/levels/move\|delete` (ADR 0110) |
| Prefab (a root `Node`) | `content/assets/prefabs/<name>.prefab.json` — an **asset** with a `.meta` id (ADR 0026) | created once by `Save as prefab…` (`createPrefab`, `src/assetsApi.ts`), then **edited live** in its own room (ADR 0091) |
| Game shared-component list | `content/<game>/game.json` | `PUT /api/games/<game>` (`saveGame`) — appended by adoption (ADR 0077) |
| Materials, clips | `content/assets/**` JSON | `PUT /assets/<path>` |

Both levels and prefabs are live rooms, so there is no Save and no file lock for either (ADR 0089, ADR 0091); only materials and clips are still locked files.

## Panel layout (`tools/editor/index.html`)

One CSS grid `#app`; `--left`/`--right`/`--bottom` written by `createSplitter` (`src/splitter.ts`). No UI framework; Tweakpane only inside the Inspector (ADR 0024).

`main.ts` is a **shell** (ADR 0121): the state it owns, construction, host literals, boot. A subsystem is its own module holding its own mutable state, reached through a getter-bag host — the convention the panels already use. Pure arithmetic is its own module again (`selection.ts`, `snap.ts`, `facePull.ts`, `surfaceGrid.ts`). Host entries are always arrows: a subsystem is constructed at module init and half of what it wants is declared further down.

| Subsystem | Owns | Host |
| --- | --- | --- |
| `itemMeshes.ts` | `instanceRoot`, `markerGroup`, the groups, the shadow budget, the cell toggle | `doc`, `loaded`, `runtime`, `mode`, `gameSettings`, `selected`, `afterBuild` |
| `play.ts` | the character, controller, loop, play view and lights, component runtime, game frame | `PlayHost` (23 getters) |
| `historyStore.ts` | the history, pending batches, `coalescing`, the held-back drag batches, `dirty`, the clipboard | `HistoryHost` |
| `liveSession.ts` | `collab`, the peer list, the last snapshot, `joining`, the deferred ops, the hold map and its key, the hold outlines, the presence timer | `LiveHost` |
| `motionPreview.ts` | the preview clock, whether it runs, the last frame. Poses via `Doc.posesAt(timeMs, { sequences: playing })` — one walk, not `poseOf` per node (ADR 0125, ADR 0142) | `MotionPreviewHost` |
| `cameraView.ts` | the orthographic camera, `isometric`, the nav gizmo and its drag flag, the stand-in background, the bounds box | `CameraViewHost` |
| `fileActions.ts` | nothing — it is behaviour: arm, rename, delete an asset or a level (ADR 0097, ADR 0110) | `FileActionsHost` |
| `prefabActions.ts` | nothing — enter, close, unlink, save as, revert, apply (ADR 0091, ADR 0111) | `PrefabActionsHost` |
| `nodeActions.ts` | nothing — delete, duplicate, create, frame, paste at a point; all on selection **roots** | `NodeActionsHost` |
| `menus.ts` | nothing — the right-click menus, declarative; had to follow the action clusters, not precede them | `MenuHost` |
| `pickTool.ts` | the raycaster, the ground plane, where a press landed, the face highlight, the pull in progress | `PickHost` |
| `gizmoTool.ts` | `edit` (tool, frame, snapping, one increment per tool), the drag-start poses, the two drag flags | `GizmoHost` |
| `pointTool.ts` | the open move step, its copy and the copy's own `TransformControls`, the drawn routes, its drag flag (ADR 0144) | `PointToolHost` |


| Area | Element | Module |
| --- | --- | --- |
| Top | `#toolbar` — name (read-only), New, Duplicate, Back, gizmo Move/Rotate/Scale/**Face** (ADR 0119), space, snap + the active tool's increment with its unit (ADR 0114), Motion, Play, grid, markers, **Keys** (ADR 0120; hidden unless the game declares `surfaceGrid`). **No game picker and no level list** (ADR 0108): a game is a folder of levels, so opening is the Project panel's tree. No mode select and no Save either: both kinds of document are live rooms (ADR 0089, ADR 0091) | `src/toolbar.ts` |
| Left | `#hierarchy` — node tree + context menu. Rows alternate `--row-alt` by **rendered** position (`.row:not(.env):nth-child(even)`), declared before `:hover` and `.sel` so both win on source order | `src/hierarchy.ts`, `src/menu.ts` |
| Centre | `#view` — Three stage, orbit, transform gizmo, placement clicks | `src/main.ts`, `src/itemMeshes.ts`, `src/play.ts` |
| Right | `#insp-head`, `#inspector`, `#asset-inspector` | `src/inspector.ts`, `src/assetInspector.ts` |
| Bottom panel | `#palette` **Project** (asset tree, previews) | `src/projectPanel.ts`, `src/assetTree.ts`, `src/previews.ts` |
| Status | `#status` | `setStatus` |

Document model: `src/editorDoc.ts` (`Doc`, `levelDoc`, `prefabDoc`; a `Doc` captures its `registry`; every mutation is an op batch, below). Undo: `src/opHistory.ts` (inverse ops, ADR 0089). Shortcuts: `src/shortcuts.ts` (ADR 0030).

## Content API — `editor-server.md` (ADR 0083)

The routes are `tools/editor-server/src/api.ts`, mounted by `vite.config.ts` (`filesApi` plugin: `createContentApi` with `identify → local`, in-memory locks, no git) and by the hosted server. Clients: `src/filesApi.ts` (levels, games, `me`, `serverStatus`, `acquireLock`/`releaseLock`/`releaseLockBeacon`/`heartbeatLocks`, `uploadAsset`, `lockKey`, `ApiError` with `status` and `owner`), `src/assetsApi.ts` (`loadAssetLibrary`).

### Identity, locks, upload in the editor (`src/main.ts`)

| Piece | Behaviour |
| --- | --- |
| `me` | `GET /api/me` at boot; name shown first in the status bar; `heartbeatMs`/`maxUploadBytes` read from it |
| `heldLocks` | every key this tab holds; `takeLock(path)` → holder's name or `null`; `dropAllLocks()` releases all (→ the server commits the session) |
| `openFile` | `dropAllLocks()`, then **joins the level's live room** (`room.joinRoom(name)`, below). Levels only: a prefab is entered with `enterPrefab`, not opened as a file |
| `readOnlyBy` | a material or clip this tab could not lock; status bar shows `read-only · locked by X` |
| `saveNow` | returns `true` at once for a live room: every edit is already on the server |
| `newBlank` | `createLevel(null)` — a level exists the moment it is named (below) |
| materials | `lockAsset(id)` on select (`onSelectAsset`, kind `material`); refused ids in `lockedAssets` → `onMaterialChanged` refuses |
| heartbeat | `setInterval(heartbeatMs)`: `heartbeatLocks(held)`; a lost file lock is re-taken or turns the file read-only; `serverStatus().pushError` → `pushProblem` in the status bar |
| `pagehide` | `releaseLockBeacon` per held lock; `collab.beaconLeave()` |
| upload | `ProjectHost.onUpload(files, folder)` from a desktop drop on a folder row, folder tile or the grid (`dropTargetFor`, `folder` getter; not for *All folders* or the level's own); files over `maxUploadBytes` are named and skipped; `afterFileOp` uploads the rest |

`content/<game>/game.json` is written by `adopt` without a lock (gated only by others' locks).

The dev editor's `@content` alias is pinned to the repo's `content/` (`contentAlias(REPO_CONTENT)`): it edits that folder, never the live mirror (`content-sync.md`, ADR 0084).

**Watcher:** `watch.ignored: ['**/content/*/game.json']`. Every game's `rules.ts` imports its `content/<game>/game.json` and the editor bundles those modules, so a write would full-reload the editor and lose undo history right after the editor wrote it. The editor reads the files live over `/api/games`; the game's dev server still reloads (ADR 0077).

## Edits are ops (ADR 0089)

Every `Doc` mutator builds `Op`s (`@mp/content` `ops.ts`, `content.md`) and commits them through the one shared
`applyBatch` on its own level; what changed is reported on `doc.onOps({ ops, inverses })`. No-op edits (inverse
`null`) report nothing. Nodes are addressed on the wire by `NodeRef`: `refAt(i)` / `indexOfRef(ref)`.

| Mutator | Ops |
| --- | --- |
| `setTransform` / `setName` / `setParams` / `setComponentEnabled` / `addComponent` / `removeComponent` / `moveComponent` | the own op on an own node; the `setOverride*` / `addOverrideComponent` / `removeOverrideComponent` flavour on an inherited one (an inherited component's removal = `setOverrideParams unset` + `setOverrideEnabled null` + `setOverrideRemoved`). **Three cases, not two** (ADR 0098): `writeTarget` also catches a component a *placement* shows but does not have — inherited from its prefab **root** — and writes an override on the placement keyed by the root's id. `setParams` resolves it per component id, since the built-in-shape branch writes several at once. `moveComponent` stays refused: order belongs to the prefab's list. `setSequenceStages(i, id, stages)` takes the stages as shown: `setParams` on an own node, `setOverrideParams` on a component the placement added, otherwise `setOverrideSequence` with `diffStages(prefab's, shown)` (ADR 0139) |
| `placePrefab` / `placeNamed` / `placeEmpty` / `placePrimitive` / `placeModel` / `duplicate` / `paste` | `insertNode` (ids minted client-side; `reidSubtree` for copies, which repoints `nodeRef` parameters and sequence step targets, and the targets in a placement's `sequences` records). `placePrefab` writes the prefab's **asset id** and resolves the definition into `level.prefabs` without an op (ADR 0091) |
| `remove` / `move` / `reparent` | `removeNode` / `moveNode`. **`reparent` takes the re-expressed local transform and commits `moveNode` + `setTransform` in one batch** (ADR 0113): preserving the world pose changes the stored local numbers, and as a second commit that op landed in the *next* history entry — one Ctrl+Z then restored a transform belonging to an earlier reparent and a child jumped by its parent's whole transform. The transform is `localInside` over the **authored** poses (`motion.withAuthoredPoses`, ADR 0126): the groups hold authored *plus* the motion offset while the clock runs, so reading them wrote the animation's position into the file for good. It is the one write path that cannot subtract the offset afterwards, because the offset is in the old parent's frame and the value is in the new one |
| `linkToPrefab` | `replaceNode` (the node keeps its transform and name, loses its own components, gains the reference). `definitionOf` is pure: the definition becomes a **file**, which is the host's to write |
| `revert` | `setNodeOverride` (the record with the field gone, or `null`) |
| `overrideOpsFor` | pure — the ops the **prefab's own room** would take. The host sends them there, then calls `revert` here (ADR 0091) |
| `setEnvironment` / `setMode` / `setNetBounds` / `setCameraSeeThrough` | the same-named op; all four are level-only and a no-op in a prefab. `setCameraSeeThrough` is the Environment row's **Camera** section, `see through` (ADR 0148) |
| `setId` | not an op (the file name; live, the server sets it) |

`prefabDoc(root, registry, clips)` — a prefab is edited as a document of one root node, in its own live room
(below), so its ops carry no table scope.

**Undo** (`src/historyStore.ts` over `src/opHistory.ts`, ADR 0121): `createHistoryStore(host)` → `edits`.
`edits.withOps(d)` attaches `onDocOps` to every document; batches collect in `pending`; `edits.recordEdit(label)`
folds them (`foldBatches`: one transform op per target, last value, first inverse)
into `{ ops, inverses, label, selection: NodeRef[] }`. `undo` applies `inverses` with `applyBatch` straight on the
root level (nothing re-reported), rebuilds, restores the selection by ref; an entry whose ops no longer apply is
dropped with a status line. Undo inside a prefab
opened on top no longer pops back to the level. Live, the applied inverses go to the server as an ordinary batch
(`host.submit`): an undo is an edit the room sees.

**A drag is one entry**: `edits.beginDrag()` holds recording off while a hundred transform ops are reported, and
`edits.endDrag(label)` folds them, sends the room one message and records one entry. `abortDrag` clears without
folding. The gizmo, the face tool and the Inspector's `writeAxis` each held a verbatim copy of that sequence;
they call these now, and `coalescing` and `heldBack` are private to the module.

## Live levels (`src/collab.ts`, ADR 0089)

A level is not a file with a lock but a **live session** on the server (`editor-server.md`, *Live documents*):
every batch the document reports is applied locally at once and sent; the server numbers it and echoes it to
everyone, the sender included (the echo is the ack). Prefabs are rooms too (ADR 0091); materials and clips keep
the file lock.

```ts
createCollab(transport: LiveTransport, hooks: CollabHooks): Collab
// join(name) resolves on the first snapshot · leave · submit(batch) · flush() · hold(refs) · release(refs) · presence(data)
// beaconLeave() · connId() · name() · peers() · holds() · pending()
httpTransport(): LiveTransport   // EventSource in, fetch POST out, sendBeacon for the way out
```

| Piece | Behaviour |
| --- | --- |
| join | `openFile` (level) → `room.joinRoom(name)`, which resolves the snapshot it was greeted with — that level is what adoption, validation and `levelDoc` run on. `joining` is `joinRoom`'s own, so the first snapshot builds the caller's document while a later one (a reconnect) reinstalls it (ADR 0121). A join the server refuses is the load error |
| outbound | `onDocOps` → `pending` (history) **and** `collab.submit(batch)`; the batch is *unacked* until its echo. `applyHistory` submits the inverses it applied |
| inbound | a remote batch: unacked batches rolled back (inverses, newest first), remote applied, unacked re-applied (inverses recomputed; one that no longer applies is dropped and reported); `hooks.onApplied(ops)` → `repaintAfterOps` (`liveSession.ts`). A seq gap or a failing apply reopens the stream: the server greets with a fresh snapshot, `reinstallLevel` rebuilds the document over it (history kept), unacked batches are re-applied and re-sent |
| rejected | a 4xx on the POST: that batch and everything after it rolled back, the later ones re-applied, `onRejected` → `history.dropWhere` (the entry holding it) + status line + repaint |
| repaint | `repaintAfterOps(ops)`: transforms only (`setTransform` / `setOverrideTransform`) → `applyPreviewPoses` + `scheduleRebuild` + `inspectorSync` + track helper; anything else → environment/postfx re-applied, `host.rebuildViewport()`, selection put back by `indexOfRef`, `refreshUi` + `inspectorRebuild`. During a gizmo drag **or a play-test** ops queue in `deferredRemote` (the data is already changed) and repaint when it ends (`room.drainDeferred()`, from the drag's `mouseUp` and from both `play.stop` exits) — `rebuildLoaded` frees the physics world a play session's character lives in |
| Save | toolbar `live` hides Save and disables the name field; `dirty` stays `false` live (`recordEdit`, `applyHistory`), so `guardUnsaved` never asks. `saveNow` returns `true` |
| Play | `startFramePlay`: live → `collab.flush()` first (the game reads the file), else the prefab path `saveNow()` |
| New / Duplicate | `createLevel(from)`: `askName` (`confirm.ts`) → `^[\w-]+$` → refused if `listFiles('levels')` has it → `PUT /api/levels/<name>` a `blankLevel` with the active mode, or the open level (`loadLevelRaw`, the server's live copy) with `id` set → `refreshFileList` → `openFile`. Toolbar `Duplicate` in level mode |
| status bar | `live` or `live · with Adrien, Titouan` (peers other than this `connId`) |
| leave | `dropAllLocks` → `collab.leave()`; `pagehide` → `beaconLeave()` |

Two tabs of one person are two `connId`s: separate acks, separate holds.

### Rebuilding the viewport

`buildItems()` disposes every mesh under `instanceRoot` and builds a fresh `THREE.Group` per document item, so
**`instanceGroups` is a different array of different objects after every call**. Called on open, on a
structural repaint, on a remote batch, on entering and leaving a prefab — and, crucially, again from
`loadNewReferences(buildItems)` once newly referenced assets have loaded, which is **asynchronous** and goes
through no selection change.

Two things hold those groups, and both are re-pointed **inside** `buildItems`, at both of its exits:

| Holder | Function | Was stale as |
|---|---|---|
| the transform gizmo | `reattachGizmo()` | `TransformControls: The attached 3D object must be a part of the scene graph`, every frame, then a null `updateMatrixWorld` on the next click |
| collaborators' hold outlines | `rebuildHoldOutlines()` (`room.rebuildHolds`) | no outline at all on somebody else's selection: a group no longer in the scene draws nothing — silent, which is how the boxes before them outlived the gizmo's version |

Putting them at the call sites is what failed before: both sites ran them *before* `loadNewReferences`, so the
async rebuild landed afterwards and undid the work. `refreshBoundsBox()` is there for the same reason.

`rebuildHoldHelpers()` is also called on a holds event, since holds change with no rebuild at all.

### The navigation gizmo (ADR 0094)

`src/viewGizmo.ts`, top-right of the viewport, 128 px. Blender's shape, Unity's centre, no auto-switch.

| Gesture | Effect |
| --- | --- |
| click a ball | snap to that axis over 0.35 s, smoothstepped, keeping the orbit distance. Positive balls are filled and lettered `X`/`Y`/`Z`; negative are the same ball at 0.35 opacity |
| drag anywhere on it | orbit, past 4 px of slop — so a drag that starts on a ball orbits, and a click on it still snaps |
| click the centre | toggle perspective / isometric. The label under it reads `Persp` or `Iso` |

Snapping never changes the projection: two decisions, deliberately not fused (ADR 0094 on Blender's *Auto
Perspective*).

**The background.** A cubemap `scene.background` is perspective-only in practice (`rendering.md`), so
isometric gets a flat `THREE.Color` mixed from the level's `skyParams` instead, and the cube is restored on
the way back. Every path that installs an environment goes through **`installEnvironment`** — one function
replacing four pairs of `env.applyEnvironment` + `postfx.apply` calls — because a path that installs a sky
without re-applying this is a black viewport that only appears in isometric.

**Two cameras.** `stage.camera` stays perspective and stays the game's — play-in-place tunes its `fov` — and
`orthoCamera` sits beside it in `main.ts`. `activeCamera()` says which is live; `setProjection(ortho)` copies
the placement across, cuts the frustum so both show the same height at the orbit target, and re-points
`postfx.setCamera`, `controls.object` and `gizmo.camera`. Entering play forces perspective. `focusSelection`
and the picking raycast both go through `activeCamera()`.

**The pointer.** `document` in the **capture** phase, `stopPropagation` when the gizmo takes a press:
`OrbitControls` and the selection click listen on the canvas itself and were added first, so there is no
getting in front of them from there.

Drawn in the render step **after** `postfx.render()` — it clears depth and paints over the finished image —
and not at all while playing. `gizmoPointer` and `orbitAround` are pure and tested; the rest is WebGL.

### Network bounds, drawn (ADR 0093)

`level.config.netBounds` — how far from the origin a peer's position survives the wire. On the **Game** row's
Inspector panel, below the game picker.

| Piece | Behaviour |
| --- | --- |
| the number | `reach ±m` (10–20000, step 10), written by `Doc.setNetBounds`. Below it, the step this buys: `2 × m / 65535`, in cm. A level that has set one gets a **use the default** button, which writes `null` |
| the box | `THREE.Box3Helper` on `stage.scene`, red, sized `±bound` about the origin. **Off by default**, toggled by `show box` in the same section, hidden inside a prefab (a prefab has no bounds of its own) and re-sized at both `buildItems` exits |
| the reach report | `boundsReach()` — how many **top-level** objects have geometry past the bound, and the furthest metre anything reaches. Measured with `Box3.setFromObject` off the drawn groups, not authored positions: a wide platform counts by its edge, which is where a player can stand |

The box is the reason the number is safe to author. A bound too small for its level is a peer who freezes and
then stops being relayed at all, on everyone's screen but their own, with no error anywhere (ADR 0092) — so it
is drawn and counted rather than left a field in a file.

The bound reaches the relay through the **game**, not the editor: `startGameClient` passes
`levelData.config.netBounds` as a join option, and the room adopts the first one it is given
(`docs/platform/netcode.md`).

### Prefabs are live rooms too (ADR 0091)

A level references a prefab by asset id and holds no copy, so editing a prefab has to reach every level that
uses it. It does, because a prefab is a live document of its own.

| Piece | Behaviour |
| --- | --- |
| resolve on open | `openFile` runs `hydratePrefabs(level, editorPrefabs)` — `assets.prefabOf`, already in memory from boot — and keeps `hydratedPrefabs` (what it filled) and `missingPrefabs` (what it could not), naming the missing in the status line |
| resolve mid-session | three doors add a definition after the open — `placePrefab`, `paste` of a clip that carries one, and `linkToPrefab` (Save as prefab). Each records it in `Doc.resolvedPrefabs()`, and a save strips the open-time set **union** that (ADR 0124). None of them used to, so the definition reached disk — where `hydratePrefabs` skips an id the level already carries, so the frozen copy is read *instead of* the asset from then on, by the editor and the server, permanently. A placement that looks linked and silently stops following its prefab |
| enter a prefab | `enterPrefab(assetId)`: leave the level's room, `room.joinRoom(assetId, 'prefab')`, build `prefabDoc` over the snapshot's one root, `prefabOpen = { assetId, name, from }`. From a placement (`openPrefabOf`, the Inspector's **Open**, the Hierarchy and viewport menus) or from a prefab's Project tile — which is the only way to reach one that is placed nowhere |
| one at a time | The viewport, the physics world, the selection and the holds are singletons keyed to the open document, so a tab is in one room. **Back** (`closePrefab`) rejoins the level, which the server answers with a fresh snapshot, so anything that changed meanwhile is there |
| follow a prefab | a `prefab { assetId, ops }` event on the **level's** stream → `onPrefabOps`: `applyBatch` over `{ id, config: {}, nodes: [root] }`, whose root *is* the resolved definition, then a structural repaint and `previews.invalidate()`. No sequence and nothing sent back: the level's own file did not change |
| Apply to prefab | two rooms, one gesture. `Doc.overrideOpsFor(i)` → `collab.submitToPrefab(assetId, ops)` → only if the server took them, `Doc.revert(i)` here. Undo puts **this placement's** override back and does not take the change out of the prefab; the status line says so |
| dragging a piece **out** | Allowed (ADR 0133): `Doc.reparent` on an inherited node inserts its **resolved view** at the destination with fresh ids and records the removal on the placement, in one batch — so one Ctrl+Z. A piece is still refused as a *destination*, and still cannot be reordered inside the prefab |
| a drag carries the selection | Grabbing a **selected** row drags the whole selection, an unselected one drags it alone (ADR 0134). A plain press on a row of a multi-selection selects nothing until its click (`defersToClick`), so the drag still sees the selection. Roots only (`rootsOf`); every pose read before anything moves, from the authored poses (ADR 0126); addressed by **ref**, since each move renumbers the tree depth-first and every later index is stale. One history entry for the drag. The ones that cannot go where they were dropped are skipped and the status line counts them |
| removing a piece | A piece can be **deleted from one placement** (ADR 0133) — `NodeOverride.removedNodes`, the fourth of Unity's override kinds. The prefab keeps it and every other placement keeps it. Dropped in the **tree walk** as well as in `bakeOverrides`, because the tree is built from the prefab's own child objects so a write can reach the definition — a child dropped only while baking is still walked and drawn. Reported by `Doc.placementRemoved(i)`, read off the override records, since a removed piece has no index for `placementOverrides` to find. Revert puts it back; **Apply deletes it from the prefab**, so every placement everywhere loses it, emitted before the added children's inserts. Delete and Cut are no longer greyed on a piece; reorder, reparent and Create-child still are |
| copying a piece | An inherited node **can** be copied and duplicated (ADR 0131) — the copy is a plain object, so it is not an edit of the prefab. `Doc.copy` takes the node's resolved `view` (`bakeOverrides` recurses, so it is the whole subtree with this placement's overrides baked in, which is what was on screen); `paste` re-mints the ids as it does for any copy and puts it wherever you paste. `duplicate` puts it under the placement as an added child, since its siblings are the prefab's. Delete, Cut, reorder, reparent and Create-child stay refused: each would have to change the prefab. **Ctrl+X copies and leaves the original** — the menu greys Cut on a piece, so only the shortcut reaches it |
| a child added to a placement | Dropping a node onto a placement makes it the **level's** child beside the prefab's resolved ones, and `Doc.placementAdded(i)` is what finds them (ADR 0130). Carried by the placement-scope pair: **Apply** sends `insertNode` on the prefab's root in the same submission as the overrides, with re-minted ids (a prefab's are its own) and the transform unconverted (same frame), then the local copy goes and the prefab's echo brings it back inherited; **Revert** deletes it, because the prefab has no such child — Unity's *Added GameObject*, and one Ctrl+Z puts it back. Direct children only; a grandchild rides inside its parent's one `insertNode`. **A placement dropped onto a placement is skipped**: applying it would need the inner definition to resolve in the prefab's room, which ADR 0124 has not been worked through for |
| Revert/Apply have two scopes | an override is stored per inherited **piece** — and for the placement's own inherited **root** components, on the placement keyed by the prefab root's id (ADR 0098). `recordKey(n)` says where either lives, so the root is `placementOverrides`' first entry when it has changes; before ADR 0139 nothing read that record back. On a root the pair acts over every piece the placement owns: `Doc.placementOverrides(i)`, `Doc.revertPlacement(i)` (**one batch** — one Ctrl+Z, one message to the room), `Doc.placementOverrideOps(i)` (one submission, so a partial failure cannot half-apply). Owned by *this* placement only, so a nested one's pieces stay its own. Labels carry the scope: `Revert all to prefab` / `Apply all to prefab` with the count as the menu hint, and the Inspector strip reads `N overrides on M objects`. Before this the pair was permanently greyed on the prefab object and the Inspector said nothing there |
| unlink a placement | `Doc.unlinkNode(i)` — one `replaceNode` op (ADR 0111). The node keeps its id, transform and place in the tree and takes the resolved name, components and children, so an override becomes the value; the inherited subtree is cloned with fresh **node** ids, since a prefab's are scoped to itself. Refuses a non-placement and an inherited node. From the Hierarchy menu's *Unlink from prefab* and the Inspector's **Unlink**, left of **Open**. No confirm: one op, so Ctrl+Z puts the link back |
| no Save, no lock | both kinds of room write themselves. The toolbar has no mode select and no Save; the name field is read-only and says where a prefab is renamed. `New`, `Duplicate`, the file list and the game picker are disabled while in a prefab, titled *leave the prefab first* |

### Switching a node off (ADR 0099)

A checkbox in the **Inspector's header, immediately left of the name** and nothing else — the same shape a
component section's header has (`isec-en`, then the name), because it is the same control one level up
(ADR 0102). The Hierarchy is for finding and arranging, and a column of checkboxes down it competed with the
names; it still **dims** a switched-off row (`Row.disabled` / `Row.disabledAbove`, `.row.off`), which is how a
whole tree reads at a glance. Why an ancestor's state blocks the tick is a `title`, not body text.

`doc.setNodeEnabled(i, on)` → `setNodeEnabled` on an own node, `setOverrideNodeEnabled` on an inherited one, so
one placement of a prefab can drop a part the others keep. `InspectorHost.onSetEnabled` in `main.ts` treats it
as structural: `rebuildLoaded()` + `buildItems()`, the same as a delete, because what the level contains just
changed. The checkbox is itself disabled when an ancestor is off — the node's own flag is not what is keeping
it out then.

`buildItems` **builds no meshes** for a node that is off or has an ancestor that is. Not an invisible group:
three raycasts invisible objects, so that would leave it clickable in the viewport. The group is still created,
so indices, selection and the gizmo keep working — a disabled object can be moved, just not seen.

`Row.disabled` is the node's own answer, `Row.disabledAbove` an ancestor's. Both dim the row (`.row.off`).

### Deleting a prefab (ADR 0097)

`deleteAsset` in `src/main.ts`. Any other asset kind goes straight to the server; a prefab does this instead:

| Step | What |
| --- | --- |
| count | `listFiles('levels')` reports each level's `prefabs` (asset ids), so the confirm can say how many placements are in this level and which other levels use it |
| confirm | `askDestructive` (`src/confirm.ts`). Enter is **Cancel**, not the destructive button. Says the id does not come back — the `.meta` goes with the file, so a prefab created again later is a different asset |
| other levels | `loadLevelRaw` → `hydratePrefabs` → `unlinkPrefab` → `saveFile`. A `PUT` **409s while that level is open live**, and that refusal aborts the whole delete and names the level rather than rewriting a file under somebody |
| this level | `doc.unlinkPrefab(id)` — `replaceNode` ops, so it is one undo entry and everyone in the room sees it |
| the file | last. A failed unlink then costs nothing; the reverse order would leave placements pointing at a dead id |

The unlink itself is `@mp/content`'s (`content.md`), with the registry injected: only this side knows which
components are singletons and which parameters are node references. The editor-server has no registry.

### Save as prefab… (ADR 0091)

One action makes a prefab, replacing both `Extract to prefab` (which wrote no file) and prefab mode's Save
(which made no reference). On the Inspector link row and in the Hierarchy and viewport menus, all calling
`saveAsPrefab(index)`.

`askName` → `prefabTarget(project.folder(), name, taken)` (`src/prefabPath.ts`, pure and tested) →
`assets.createPrefab(path, doc.definitionOf(index))` → `reloadAssets()` → `doc.linkToPrefab(at, id, definition)`
→ `recordEdit('save as prefab')`.

- **The file goes first.** A failed write costs a status line; the reverse order would leave a placement
  pointing at nothing. If the write lands and the level edit does not, the file is an unreferenced prefab —
  visible in the Project panel and placeable by hand.
- **A name already in that folder is refused, never overwritten.** Writing over a prefab file keeps its `.meta`
  sidecar, so the asset id would live on while the contents changed and every level referencing it would
  quietly become something else.
- **The undo entry holds the level's `replaceNode`, not the file.** By then another level may reference it.
- The selection is re-found by `NodeRef` after the dialog and the two requests, since an index shifts under a
  remote edit.

### Presence — a drag seen from across the room

```ts
interface PosePresence { kind: 'pose'; poses: { ref: NodeRef; position: Vec3; rotation: Vec3; scale: Vec3 }[]; end?: boolean }
parsePresence(data: unknown): PosePresence | null   // collab.ts — peers' data, validated
```

| Piece | Behaviour |
| --- | --- |
| send | gizmo `dragging-changed` true → `startPresence()`: every 100 ms `collab.presence({ kind: 'pose', poses: dragPoses() })` — the selection's groups' local poses (`groupPose` + scale), not the document's. Drag end → `stopPresence()`: `{ poses: [], end: true }` |
| ops | `onDocOps` while `coalescing` pushes to `heldBack` instead of submitting; drag end folds them (`foldBatches`) and submits **one** batch, the same ops the history entry holds. Nothing else changes: without a drag every batch still goes at once |
| receive | `onPresence(data)`: `parsePresence` → for each pose `indexOfRef` → set the group's position/quaternion/scale; skipped for a node in my own selection while my gizmo drags. `end` → `applyPreviewPoses()` unless my gizmo is dragging (my drag end repaints). The hold outline follows, since it is drawn from the group each frame |
| nothing kept | presence is unnumbered and never written; the op at drag end is what lands, and a drag that came back to its start lands nothing |

Others' selection is what the hold outlines and badges show: a selection *is* a hold.

### Holds — a node is yours while selected

| Piece | Behaviour |
| --- | --- |
| `syncHolds` | after every `applySelection`/`deselect`: `room.syncHolds()` → `collab.setHolds(host.selectionRefs())` — the **whole** selection, skipped when unchanged (`lastHoldKey`). Hold messages queue one behind another in `collab.ts`, so a release can never overtake the hold before it. A refusal (`{ ok: false, holder, refused }`, a lost race) drops the refused nodes from the selection with a status line. `reinstallLevel` (new `connId`) re-sends; a `hello` with a new `connId` posts `leave` for the old one |
| heartbeat | the lock heartbeat also `collab.ping()`s while live: the server sweeps a connection it has not heard from in two minutes, holds with it |
| `heldBy(index)` | the name of another connection holding this node **or any ancestor** (`holdMap` by `refKey`), else `null` |
| `applySelection` | filters `heldBy(i) !== null` out, so the gizmo never attaches to a held node; `select`/`selectWith` say `X has that selected` (`refuseHeld`) |
| `onHoldsChanged` | on every `holds` event: `holdMap` rebuilt, my selection loses what someone else now holds, `rebuildHoldOutlines`, `hierarchy.render()` |
| Hierarchy | `rowsOf(doc, open, heldBy)` → `Row.held` (name or `''`); a held row has class `held` (dimmed), a `.badge.held` with the name, and only `onSelect` wired (no rename, no drag); `onReparent` onto a held parent is refused |
| viewport | an outline of the held node's group — its subtree — in a colour from a hash of the holder's `connId` (`HSL(h, 0.75, 0.6)`): `room.holdOutlines()`, one `OutlineGroup` per connection, cached and rebuilt on holds events and after structural repaints; drawn by the same pass as my own (below) |

Holds work the same inside a prefab's room. A hold there does **not** block a level's override on the same
node, and the reverse: they are different edits — the shared definition, and this one placement.

### The selection outline (ADR 0145)

`createPostFX(..., { outlines })` in `main.ts` asks each frame for my selection's groups in **white**
(`MY_OUTLINE` — collaborators' colours are all strong hues, so white is never one of theirs) followed by
`room.holdOutlines()`; nothing while playing. A group is a node's whole subtree, so a parent's outline takes
its children in, as Unity's does. Drawn whether or not something is in front — the whole silhouette, as
bright behind a wall as before it. `rendering.md` has the pass.

**Edges** (ADR 0146, `selectionEdges.ts`): on my selection only, a `LineSegments` of `shapeEdges(mesh.geometry)`
per mesh of the selected subtrees — not an `InstancedMesh` (a board's cells) nor a wireframe material (a light's
gizmo) — white at 0.7, depth-tested and pushed a thousandth of the distance toward the eye (2 cm along the view
in orthographic) by an `onBeforeCompile` on `project_vertex`. Each copies its mesh's `matrixWorld` every frame
after `updateWorldMatrix`, so it follows drags and the preview; the set is rebuilt only when the meshes under the
selection change. In the `selection-edges` group outside `instanceRoot`, so never picked. None while playing.

## Project panel — games at the top (ADR 0108)

`src/projectPanel.ts`. The tree is games first, then the shared asset library:

```
Keyboard  3      <- click: author for this game, its levels as tiles
  default        <- click: open it
  keyboard2
Parkour   6
assets           <- the existing folder tree, unchanged
  materials
  prefabs
```

- `Place` (`src/assetTree.ts`) is where the panel is looking: `{ at: 'game', game }` or
  `{ at: 'assets', folder }`. A union rather than a path with a magic prefix, because a game is not a folder of
  assets and its levels are not asset entries — the prefix version needs an `if` at every use of `folder`.
- `gameRows(games, levels)` (pure, tested) groups the level listing under its games, games by label and
  `default` first. A game with no levels is still a row: it is where the first one is made.
- **A level is not an asset entry.** Nothing references a level by id, so it has no `.meta` and is not in the
  asset database; it is its own row type keyed by the qualified `<game>/<name>`.
- Host hooks: `games`, `levels`, `openLevel`, `onOpenLevel`, `onPickGame`, `onNewLevel`. `Project.showGame`
  lets the editor point the tree at the open document's game, so what is open is always visible.
- `onPickGame` selects without opening: clicking a game to look at its levels must not discard the document
  you have. It is what `New` makes a level in, and what composes the registry while nothing is open.

## Right-clicking a level (ADR 0110)

`onLevelContext(at, qualified)` — the same split as `onContext`: the panel says what was clicked, `main.ts`
builds the menu. Open, Duplicate…, Rename…, Copy name, Delete…

| Item | Notes |
| --- | --- |
| Open | disabled for the one already open, and inside a prefab |
| Duplicate… | `createLevel(from)`, the toolbar button's operation; copies the server's current copy, so a level open live duplicates as it is now |
| Rename… | `askName`, then `renameLevel`. The **open** level works: flush, `collab.leave()`, rename, reopen — the server refuses a rename on an open document. A name in another game's folder moves it there |
| Copy name | the bare name, which is what `?level=` takes |
| Delete… | `askDestructive`, body naming what goes: no undo, whether it is the open one, whether it is the game's `default` and what boots instead, whether it is that game's only level. Deleting the open one boots into whatever is left |

A refusal leaves everything as it was and reopens what the editor left, so a 409 from somebody else holding
the level costs nothing.

## What opens at boot (`src/lastOpen.ts`, ADR 0109)

`openFile` writes the qualified name to `localStorage` (`editor.lastLevel`) once the open has succeeded;
`bootLevel(lastLevel(), levelEntries, activeMode?.name)` picks it back up, falling through to the active
game's first level, then any game's, then a blank document. Per browser, best-effort, and honoured only while
the name is still in the listing — a deleted or renamed level must not make every reload a load error.

## Game discovery (`src/modes.ts`)

- `MODES`: `import.meta.glob('../../../modes/*/src/editorMode.ts', { eager: true })`; every export passing structural `isDescriptor` (`name`, `registry`, `session`) is installed by `name`; duplicates warn, first wins.
- Paths containing `/modes/_` skipped → `modes/_template` never in the picker.
- `MODE_LIST` sorted by `label`; `modeOf(level)`; `soleMode()` = the only installed game, else `undefined`.
- `package.json` lists only `@mode/parkour`; other games enter via the glob's relative path. `tsconfig.json` includes `content/<game>/levels/*.level.json`, `content/*/game.json`.

## Registry a level is edited against (`src/main.ts`)

| Symbol | Role |
| --- | --- |
| `activeMode` | the opened level's **folder** — its name is qualified `<game>/<name>` (ADR 0108), so the game is known before the file is read (fallback `soleMode()`) — or a game clicked in the Project tree (`onPickGame`, which selects without opening anything) |
| `gameData` | per game, `content/<game>/game.json` via `loadGame` at boot (`reloadAssets`) and after each `adopt` |
| `registryFor(mode)` | `mode.registry` + `sharedComponents(gameData[mode.name] − present)` — live data merged over the bundled code |
| `registry()` | `registryFor(activeMode)`, or `DEFAULT_REGISTRY` with no game |
| `adoptable()` | `SHARED_COMPONENT_TYPES` the game lacks (`Boss`, `Bumper`, `Checkpoint`, `Goal`, `Hazard`, `Sequence`) |
| `adopt(types)` | shared ∧ new → `saveGame` → `gameData` → `reopenWithRegistry()` |

Adoption points (ADR 0077):
1. **Open** (`openFile`): `componentTypesInRaw(raw)` unknown-but-shared → adopted before `validateLevel`; any other unknown type is a load error in the status bar.
2. **Place** (`armAsset`): `missingIn(assetId)` splits a prefab's unknown types into `shared`/`foreign`; shared adopted before arming — not while a prefab is open on top (a prefab belongs to no game).
3. **Add Component** (Inspector button, Hierarchy submenu): `adoptable()` listed beside addable types; pick → `adopt` → `doc.addComponent`.

File list filtered by game: `visibleLevels()` keeps entries whose `mode` — the folder they are in — equals `activeMode.name`. There is no unassigned case left: a `.level.json` outside a game's `levels/` is not listed at all (ADR 0108).

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

## Shapes are built-in meshes (ADR 0090)

A `Mesh` naming a `builtin:` id draws a unit shape sized by the node's **scale** (`content.md`), and that node's
colliders are held at the matching unit shape — so scale is the one size a person reads and edits.

| Piece | Behaviour |
| --- | --- |
| picker | `assetOptions('model')` lists `BUILTIN_LABELS` first, then the uploaded models: a built-in is picked like a file |
| locked collider | `Doc.setParams` on a `Mesh` with a built-in rewrites every `Collider` on the node to `unitColliderFor(model)` **in the same batch** (one undo); `addComponent(Collider)` on such a node is born unit; `Doc.builtinOf(i)` says which built-in, or `null` |
| Inspector | with `builtinOf` non-null the `collider` field is one row — `unit box · size is the object's scale` — instead of the kind picker and the dimensions |
| Create | `createMenu` (blank space, Hierarchy *Create child*, viewport *Create here*) offers Box, Rounded box, Platform, Wall, Sphere, Capsule (`PRIMITIVE_ORDER`) then `Empty`; each is `Doc.placePrimitive(kind, position, parent)` = unit collider + `Mesh` + unsurfaced `Renderer` + the preset scale. In a prefab's room the same menu applies (`placeNamed` is the by-name variant its palette used) |
| drawn at final size | `buildAll` **parents each group before building its meshes**, because the next row asks for the group's *world* scale; asked first it reported the node's own, leaving the holder carrying the parent chain's scale (invisible for meshes built at `ws`, which the leftover cancelled; wrong for anything at an absolute size, ADR 0120). `buildItemMeshes` (`itemMeshes.ts`) counter-scales the mesh holder by the group's world scale and builds every shape from the **world** dimensions (`geometryForBuiltin(id, ws)`, or `geometryForCollider(scaleCollider(shape, ws))`), a model file keeping the scale. So a bevel is computed on the real size, as the game computes it from the baked collider — the editor used to stretch it |
| redraw on scale | `meshes.rebuildSubtree(i)` after a scale gizmo drag, a typed transform, and a remote transform op: meshes are built from the world scale, so a node's change is its subtree's |
| previews | `previews.ts` walks with the accumulated scale and does the same, so a Project tile shows the shape the viewport does |

## The game's surface cells (ADR 0120)

The `Keys` toggle draws what the active game would generate on a box surface, so a platform can be sized and
placed before the level has run. Keyboard's caps are generated at load and are neither nodes nor colliders
(ADR 0069), which left an author placing platforms blind.

The editor names no game: it asks `activeMode.surfaceGrid(components, worldSize, settings)` (`mode.md`) and the
game decides from the node's own components. `settings` is the live `gameData[mode.name].settings`, so a Game
row edit to the key pitch re-lays every preview.

| Piece | Behaviour |
| --- | --- |
| geometry | `surfaceGrid.ts` — `gridQuads(grid, size)` → one `CellQuad { x, y, z, side }` per cell, in the node's own metres, at `size.y / 2 + 0.002` (the top face, where `capsFor` puts a cap's base). Pure and tested |
| drawn | one `THREE.InstancedMesh` per board over a shared `PlaneGeometry` rotated flat and a shared translucent material (`depthWrite: false`, `polygonOffset` −1/−1 — the camera's 0.1/1000 range leaves the 2 mm lift no depth precision at distance, so the bias is in buffer units and slope-scaled; not `depthTest: false`, which would draw a floor of cells through a wall in front of it), added by `buildSurfaceCells` (`itemMeshes.ts`) **inside the item's mesh holder** — which already carries the inverse world scale, so a child of it is in world metres oriented with the node |
| the frame | the holder's world scale must be 1, which needs the **true** world scale, which needs the group already parented (see *Shapes are built-in meshes*). A cell is placed at an absolute size, so nothing cancels a leftover parent scale: it came out stretched by it and on the wrong cell count. `surfaceGrid.test.ts` locks the invariant |
| live for free | the holder is under the node's group, so a move, a turn or a reparent re-runs nothing. A **size** change rebuilds the item's meshes, and this rides along: a face pull (ADR 0119) re-lays the cells on every drag frame |
| not pickable | `mesh.raycast = () => {}`. Picking raycasts the mesh holder, so without it the quads would swallow clicks and hand `faceUnder` a flat upward normal, breaking the Face tool on every board |
| which nodes | `builtin:box` and `builtin:rounded-box` only — there scale *is* the surface (ADR 0090). A sphere has no face, and a `Keyboard` on one generates nothing, which the empty preview now shows |
| toggle | its own button, not `Markers`: fitting platforms together is when spawn discs and rule pillars are clutter. `meshes.setCells` + a rebuild rather than setting `visible`, since three raycasts invisible objects. Hidden when the game declares no `surfaceGrid` |
| culling | `computeBoundingSphere()` per mesh, against the instances rather than the unit quad at the origin |

## The preview clock (ADR 0142, ADR 0125)

**Motion** runs the level's sequences in the viewport with no physics, no character and no rules. It
poses the editor's item groups, so it goes through the **document**, where play goes through the instantiated
frame tree.

That is why it has to pose the whole tree in **one** walk. `Doc` addresses nodes by depth-first index and
recomputes the list per call on purpose (the note at the top of `editorDoc.ts`); asking `poseOf` per index cost
four full walks per node, each resolving every placement and baking every override, plus a separate ancestor
climb. Measured at 400 nodes: 17.17 ms a frame, against 0.20 ms for `posesAt`. At 1000
nodes, 96.32 ms against 0.21 ms.

`posesAt(timeMs, { sequences? })` carries each parent's accumulated rotation and scale **down** — a
depth-first list puts a parent before its children. No cache: the index-per-call rule is unchanged, `nodes()`
is just called once instead of `4n` times. `poseOf(i, t, opts)` is `posesAt(t, opts)[i]`, so there is one
composition to keep agreeing with the loader, not two — `editorDoc.test.ts` compares it with the loader's on a
turned node, a scaled parent, a turned parent and a turning one.

**Sequences** (ADR 0142). `PreviewPose` = `LocalPose` + `turn: Quat` (multiplied on the right of the euler) +
`scale` (the local scale now) + `opacity` + `shown`. The loader's rule, read from the document: a node's own
sequences aimed at it and its parent's aimed at it by id, a parent's turn and scale carried to its children,
`shown` false below a disabled node. Compiled per distinct sequence (`sequencesOn`, keyed by content, since the
Inspector patches params in place).

| | |
| --- | --- |
| when | **only while Motion runs** — stopped, every object is as it was set up, so a platform that starts invisible can be seen and clicked (ADR 0137) |
| move, turn | the group's position and quaternion |
| scale | `group.scale`: meshes are built at world size inside a holder counter-scaled at build, so this stretches them and the branch below, like the game's `drawScale` |
| disable | `group.visible = false`, which hides the branch |
| fade | a node `fadesAt` gets its own transparent material copies in `buildItemMeshes` (`holder.userData.fading`); the preview sets their opacity and hides the holder at 0 |
| collider on / off | nothing to draw — the editor has no physics |

A drag mid-preview writes `unpreviewed(group, offsetAt(i, t))` (`gizmoTool.ts`, pure, tested): a sequence's
move subtracted, its turn divided off the right, its scale divided out — so the file gets the authored
transform, never the animation (ADR 0050, ADR 0126). `offsetAt` is a `PreviewOffset`
`{ position, turn, scale }`, with sequences exactly when the preview shows them.

## Play — `src/play.ts`

`createPlay(host)` → `Play { active, start, stop, frame }` (ADR 0121). It owns `char`, `controller`, `playLoop`,
`playView`, `playLights`, `playComponents`, `gameFrame`, `ownPos` and the `active` flag; the
twenty-three things it needs from the editor arrive as `PlayHost`, all getters. `main.ts` holds only that host
literal and calls `play.frame(dt)` from the render loop — `true` when a session took the frame, so the edit
clock runs only when it did not.

**A level plays in the real game** (ADR 0086): `start` → `host.gamePageUrl()` (`me.games[activeMode.name]`,
from `/api/me`) → `startFramePlay(url)`: live level → `host.flush()`; prefab → `host.saveNow()` if dirty (a refused save is no play); then an
`<iframe id="game-frame">` over `#centre` at `${url}?level=${host.levelName()}` (bare, ADR 0108); `active = true`, orbit off. Stop
(toolbar) removes the frame. Esc inside the frame is the game's pause; the `pointerlockchange` exit applies only
to the in-editor loop. Hosted: `url` is the proxied `/play/<game>/`; dev: `http://localhost:<port>/` with
`pnpm dev:<game>` running. A prefab, or a game the server has no page for, falls through to the loop below.

## Play-test in place (`play.start`/`play.stop`) — prefabs

The game's own code, not a copy (ADR 0052):

| Piece | Source |
| --- | --- |
| Spawn | `host.mode().spawn(loaded)`; `{0,3,0}` with no game |
| Rules | `host.mode().session(loaded)` → `ModeSession` |
| Components | `createComponentRuntime(loaded, host.registry(), { character, effects: rules.effects, … })` incl. `player` components and `playerDefs(host)` (ADR 0059/0061) |
| Movement | `playComponents.locomote(...)` — no game / no locomotion component → no movement |
| Actions | `heldActions()` from the game's `actions` |
| Loop | `createLocalController` + `startFixedLoop`; tick: `fixedUpdate` → `loaded.update` → `world.step` → `locomote` → `world.step` (ADR 0058). Each `frame` pumps the loop and draws at `playLoop.alpha()` (ADR 0140) |
| Contacts | `contact([...collisions, ...overlaps])` (ADR 0054) |
| Death | `rules.takeDeath()` → `setPosition(rules.respawnAt())`, velocities zeroed; no ragdoll, no persistence |
| Teleport | `rules.takeTeleport?.()` non-null → same reposition (ADR 0073) |
| View | `addLevel(..., { cutout })` — occlusion cutout as in game (ADR 0055) |

Esc / pointer-lock loss exits play; play stops track preview.

## Pulling a face (ADR 0119, amended by 0128 and 0129)

A fourth tool, **Face**: click a face on a selected box and it stays lit; drag it and that face moves along
its own normal while the opposite one stays. The scale tool grows a box about its centre, so both faces move —
which is why a wall butted against a floor edge came away from it.

**A press claims any face it lands on**, chooses it and starts the drag in one motion (ADR 0119's press,
ADR 0129's lasting highlight). A press that never moves aborts the pull, so the same gesture means "just
choose this one" and no empty entry reaches the history. The plates always show what a press right now would
pull: a face under the pointer wins, and with the pointer off every face the chosen set stays lit. A click on
empty space lets go; a press that travels from empty space is an orbit. The choice is released on a tool
change and whenever the object selection drops the chosen box — done in `reattachGizmo`, because every
selection change goes through it and `pickTool` is constructed below the selection code (ADR 0121).

No shortcut (the useful letters are taken). Not a `TransformControls` mode: the gizmo detaches while Face is
active and the canvas runs its own press/move/release.

| Piece | Function |
| --- | --- |
| which face a hit normal names | `faceFromNormal` — largest component, so a rounded box's fillets resolve to their face |
| which face the *other* selected boxes move | `faceTowards` — the one pointing most nearly the way the drag is going (ADR 0128) |
| how far the pointer dragged | `distanceAlongAxis` — nearest point on the normal line to the pointer ray; `null` down the axis, caller holds the last value |
| where it lands | `snappedPull` — snaps the face's **plane offset along its normal**, not the distance dragged |
| the transform | `pulled` — size `+= d`, centre `+= d/2 × sign` **along the node's axis rotated into the parent's frame**; clamped on the *size* so the far face holds |

All five pure and tested (`src/facePull.ts`). **Built-in box and rounded box only**, since for those scale is
the whole size (ADR 0090) and a pull is a transform edit; an authored collider would need its half-extents
edited too. One history entry per drag, coalesced like a gizmo drag.

**The drag moves the whole selection** (ADR 0128), not just the primary, and **starts on any selected box** —
nearest under the pointer. One distance comes off the pointer on the grabbed face's line and every selected
box moves its own face that far along its own normal; each snaps where *its* face lands, so boxes that began
off the grid come out flush. Snapping off, they all move by the same amount instead — both behaviours out of
the one toggle. Non-box nodes in the selection drop out silently.

**One highlight per selected box**, kept until the choice is released, so which face each one will move is
visible for as long as you want to look at it — the question the world-direction rule raises. The hover
preview runs only while nothing is chosen, so one set of plates is lit at a time. A pool of plates over one
shared geometry and material. The status line carries the grabbed box's size plus `+N`.
`MATCH_FACE_BY_WORLD_DIRECTION` in `pickTool.ts` is the switch between world direction and the same lettered
axis on every box.

**Scale is the node's frame, position is the parent's**, and `pulled` takes the pulled axis carried into the
parent's frame (`g.quaternion` applied to it) as a required argument for exactly that reason. Nudging
`position[axis]` instead moves the centre along the *parent's* axis while the face moves along the *node's*,
so a rotated box slid sideways as it grew and the anchored face did not hold: measured on an authored platform
at rotation (-90, -75, -90), a 5 m pull dragged that face 3.54 m; a box turned 180° moved the whole 5 m,
backwards. Every rotated box was affected bar one turned about the axis being pulled. The rotated cases are in
`facePull.test.ts`; the six original ones all used an unrotated box, which is why it stood.

## Hiding a node in the viewport (ADR 0132)

Unity's eye column: hidden nodes are **not drawn and cannot be clicked**, and the game is unaffected. Not
the `active` checkbox (ADR 0099), which switches a node off *in the level* and is content.

| Piece | Where |
|---|---|
| the set, and what a toggle covers | `src/hiddenView.ts` — `createHiddenView`, `keysUnder(doc, i, onlyThis)`. Pure and tested. Keyed by `refKey`, so a prefab's piece is keyed by its placement and hiding one wall does not hide it in every tower. Every descendant is named rather than hidden by implication, which keeps alt-click and a branch toggle two different sets |
| not drawn, not clickable | `itemMeshes` builds no meshes for a hidden node (`PickHost.hidden`). Picking raycasts the meshes, so both halves fall out of the one rule; the group survives, so indices and child frames are untouched |
| the control | a fixed 18 px gutter at the left of a Hierarchy row, **outside** the indentation so the column lines up at any depth. Empty until the row is hovered, always drawn once hidden — which is the condition ADR 0102 set for a control living here. A hidden row does **not** dim: dimming already means switched off |
| alt-click | that node alone; a plain click takes the subtree |
| **Reveal** | a toolbar toggle showing everything without forgetting it; hidden while nothing is hidden. Local and momentary, never sent |
| shared and durable | `POST .../hidden` → the server's `stateDir/hidden.json`, relayed live as the `hidden` event and carried on the `snapshot` (`editor-server.md`). The whole set every time, never a delta |

## Snapping (ADR 0114)

One increment **per tool**, in `edit.steps`; the toolbar shows the active tool's with its unit and its own
bounds, so it stays one field.

| Tool | Default | Range | Unit | Snapped by |
| --- | --- | --- | --- | --- |
| Move | 0.5 | 0.05–10 | m | **us** — `snapTranslation`, on the **corner** (ADR 0117) |
| Rotate | 15 | 1–90 | ° | **us** — `snapRotation` on `objectChange` |
| Scale | 0.1 | 0.05–5 | × | `TransformControls.setScaleSnap` (absolute) |
| Face | 0.5 | 0.05–10 | m | **us** — `snappedPull`, on the face's plane (ADR 0119) |

**Translation snaps the minimum corner of the world axis-aligned box**, not the centre (ADR 0117). A box is a
centre plus a size, so centre-snapping puts the edges on the grid only for even cell counts and halfway
between for odd ones — which is where keycaps hung over a platform's edge. Corner-snapped, any size fills
whole cells. `worldHalfExtents` (`|R| · h`) is why a wall rotated onto its edge snaps by the face you are
butting against something. Placing a new object still snaps the click point, so its centre lands on the grid.

Rotation is ours because three snaps `rotationAngle`, the distance dragged, so a round amount is added to
wherever you already were and round angles are unreachable. `snapAnglesDeg` (`src/snap.ts`, pure and tested)
rounds each Euler axis onto an absolute grid instead. Applied to the **primary only**, before the write-back
and before `mirrorDragToSelection`, so the others get the snapped delta and a group keeps its relative angles
— the same shape as translation. The placement grid uses the same `snapToGrid`.

**A written rotation is rounded in degrees**, not radians: `roundAngle` (`src/snap.ts`) keeps four places of
a degree and stores the radians unrounded, so a typed 90 reads back 90 (ADR 0136). Positions and scales keep
`r4`.

## Numbers in the Inspector (ADR 0113)

Every numeric field in the object-editing path passes `dragSpeed(n)` — `{ pointerScale: n }` — and **never
`step`**. Tweakpane's `step` is both a drag increment and a constraint anchored to the value the field was
built with (`new StepConstraint(step, initialValue)`), so a scale field built at 32.98 with `step: 0.05` can
only reach `32.98 ± n × 0.05` and 33 is unreachable, silently. A transform or a size has a continuous domain,
so nothing may be unreachable; `pointerScale` is independent, so the drag feel is unchanged. Covered by a
tripwire test that reproduces the constraint arithmetic. The Environment and Network **sliders** keep `step`
deliberately — they are bounded and snapping suits a slider.

## Inspector — what the widgets bind to (ADR 0101)

`boundState(defaults, params)` = `structuredClone({ ...defaults, ...params })`. Exported and pure so the
invariant has a test.

The deep copy is load-bearing. A spread aliases every nested value, and on an **inherited** component those
values are the **prefab's own** objects (`bakeOverrides` returns them untouched where no override changed them,
ADR 0033). Tweakpane writes *into* a bound object rather than replacing it — `writePoint3d` → `writeProperty`
→ `valueObj[name] = value` — so a shallow copy let a drag on one placement edit the prefab definition in
memory, every frame, before any op existed: other placements of that prefab redrew, and the next one's slider
started from the mutated number.

A `stages` parameter shows as one summary row, `N stages · M steps`, where it is not a `Sequence`'s.

## Inspector — a sequence (ADR 0143, ADR 0147)

A `Sequence`'s section is drawn by `sequenceEditor.ts` from its stages, in our own DOM and one look (no
Tweakpane); every edit is a pure function in `sequenceEdit.ts` and one `Doc.setSequenceStages` (or
`setSequencesStages` for a drag between two sequences on the node — one commit). The Inspector keeps which
steps are open (several at once) and which sequence's ⚙ popover is open, so both survive the rebuild each edit
causes.

| | |
| --- | --- |
| header | `Sequence  <name>`, `sequenceSummary` (repeat and offset when not the defaults, then the pass length), ⚠ with a count, then **clock, loop and axes as icon toggles** (`SEQUENCE_TOGGLES`: a click flips it, lit when not the default, `.over` when overridden, dim when mixed across a selection) and **⚙**: a popover of name, repeat (Forever / Count + passes) and offset (%) |
| card | a stage: number, ⚠, length, `+` on hover (the step palette, into this stage); dragged by its header; right-click duplicate / delete |
| rail | a `.seq-link` above each card and one at the end: a `+` on hover inserts a stage there; a step dropped on it becomes a stage of its own there |
| row | `stepFace`: the kind's icon on a tinted chip, name, `→ child`, values rounded to a tenth, the duration from `compiled.steps` in a right-hand column (none for an instant), the ease's curve; `×` on hover; click opens; right-click duplicate / delete. Open, it is only icon, name and × — the fields say the rest |
| palette | a 3×3 popover of step kinds with their icons (`STEP_CHOICES`); the new step is added **open** |
| fields | target (`Doc.childTargets`), then per kind: point / axis + angle / factor / opacity %, as `scrubField`s with red/green/blue X Y Z; time as a segmented switch (Seconds / Speed / Stage, and Spin for a turn) and its number; ease as a button with its curve, opening a grid of every curve (linear, then ten families × in / out / in-out); collider and enable as a switch |
| drag | `sequenceDrag.ts` (below) |

**Controls** (`controls.ts`): `scrubField` — drag sideways to change (`scrubbed`: `perPixel`, landing on `grain`,
Shift ten times finer), click to type (Enter / blur commits, Escape reverts), **one commit when the drag or the
typing ends**; its `key` (`<component>:<step>:<field>`) lets the field clicked next take the focus back after the
first one's edit rebuilt the panel. `segmented`. One popover at a time (`openPopover` / `closePopover`), gone on a
press elsewhere, Escape, a resize or a scroll outside it; `onDismiss` only for the person's dismissal.
Icons: `seqIcons.ts`, SVG paths on a 24-unit grid, stroked in `currentColor`; curves: `easeCurve.ts`, drawn from
`easeAt`, the box grown to hold an overshoot.

**Drag** (`sequenceDrag.ts`): pointer events, not HTML5. A press on a row or a card header becomes a drag after
4 px, so a click still opens; the original is hidden, a copy follows the pointer, and a placeholder opens where
it would land — `placeFor(kind, y, layout)`, pure: a stage before the first stage whose middle is below the
pointer; a step on a rail link becomes a stage there, over a card joins it before the first step whose middle
is below, past either end a stage there. Neighbours slide (FLIP, 140 ms); the panel scrolls within 36 px of its
edge; Escape cancels. Every editor on screen registers a `DropTarget`, so a drop can land in another sequence
on the same node, and one from another node is refused.

A multi-selection edits the header's settings on every node and says to select one object for the stages. On a placement,
`Doc.sequenceOverrideOf(i, id)` gives the record: its changed and added steps and added stages get `.over`,
and the header's badge adds changed, added and removed steps to the parameter count. `ComponentView.inherited`
is per component — a placement root's components from its prefab are inherited — so the ⋯ offers Revert rather
than Reset for them.

## Viewport — a sequence's points (ADR 0144)

`Inspector.openPoint()`: the open move step opened last (`openSteps` keeps opening order), in an open section
of the one selected object; every rebuild calls `InspectorHost.pointsChanged`, which is `points.refresh()`.
`afterBuild` refreshes too, and `points.frame()` runs every frame.

| | |
| --- | --- |
| the copy | `copyOf(target group)`: its meshes and its children's, geometry shared, one see-through material. Rebuilt on refresh, and when the target's holder was rebuilt under it; never mid-drag |
| its handles | a second `TransformControls`, translate only, in the toolbar's space. The object's gizmo detaches while a point is open (`GizmoHost.editingPoint`) |
| a drag | `beginDrag` … `endDrag('move point')`; each `objectChange` snaps the copy's corner (`cornerSnapOf`) and writes `to`, rounded to 4 places, when it changed, then rebuilds the Inspector. A remote repaint waits (`gizmoDragging` covers it), `afterDrag` = `rebuildLoaded` + `drainDeferred` |
| the route | one selected object: `Doc.routesAt(i)` — its own sequences' steps aimed at itself, then its parent's aimed at it, switched-off ones left out; a `Line` from its place through the points, a numbered `Sprite` per point, `DOT` of the viewport's height in either projection |
| where | `pointToWorld(to, axes, frame)` (`sequencePoints.ts`); `frame.rest` = the parent group's world matrix × the target's local pose — the group's own when Motion is stopped, `transformOf` while it runs |
| picking | the overlay group `sequence-points` sits outside `instanceRoot`, which is all a click raycasts |

`Doc.stepTargetOf(i, target)` is the node a step aims at: `i` for `SELF`, a direct child by id, else `null`.

## Inspector — several objects at once (ADR 0112)

With more than one selected the panel edits **what they have in common**.

| Piece | Behaviour |
| --- | --- |
| which components | the intersection, paired by **type and ordinal** (`peersOf`, pure and tested): the nth `Collider` with the nth `Collider`. Ids cannot pair them (minted per component) and type alone cannot (a node may carry two). A component only some of them have is **hidden** |
| a value they agree about | the normal Tweakpane widget, showing it |
| a value they differ about | a plain input, **blank**, `—` placeholder, in a `.irow` (`addMixedParam`). Tweakpane's number box cannot be empty, and a pre-filled one would be a claim about values it has not got. Untouched writes nothing. Per **axis** for vec3 and the transform |
| a compound value | a collider shape is reported as differing, not offered blank |
| writing | `Doc.setParamsAcross(targets, patch)` — each node's ops concatenated into **one** commit, so one undo entry and one message to the room |
| transform | `host.selectionTransforms()` + `host.writeAxis(field, axis, value)`; three inputs per row, each writing its axis to every selected node. Also what fixed typing moving only the primary while a drag moved all |
| Reset / Remove / enable | every selected node; the menu labels carry the count |
| Add Component | anything **any** of them can take, added to each that can |

## Inspector — Add Component (`src/inspector.ts`)

`addComponentSection` per component. `Add Component` lists `doc.registry` types not on the node plus `host.adoptable()`; disabled when both empty. With several selected it lists what **any** of them can take and adds it to each that can (ADR 0112). Adopted types go through `host.adopt(type)` then are added to the rebuilt document. Params default from `registry.defaults(type)`. Prefab placements: "push into shared prefab" → `Doc.applyOverrides` (host `applyToPrefab`).

## Level validation test (`src/levels.test.ts`)

Every `content/<game>/levels/*.level.json`: `validateLevel(raw, MODES[<folder>]?.registry ?? DEFAULT_REGISTRY)` must not throw — the folder is the game (ADR 0108), which a tag inside the file could contradict. Tripwires: some levels found, `MODES` non-empty. Lives here because only the editor can import every game's registry without inverting dependencies.
