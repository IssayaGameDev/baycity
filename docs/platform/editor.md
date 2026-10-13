# Editor — `tools/editor`

Level/prefab editor. `pnpm dev:editor` → `http://localhost:5176` (the dev host), or `https://editor.playgorbo.com` (the hosted one, `editor-server.md`, ADR 0083). Reads/writes `content/` through the content API. Authoring model ADR 0023, UI shell ADR 0024, game-explicit authoring ADR 0052.

## What it authors

| Document | On disk | Written via |
| --- | --- | --- |
| Level (node tree + `config`) | `content/<game>/levels/<name>.level.json` | made with `PUT /api/levels/<game>/<name>` (`saveFile`, `src/filesApi.ts`), then edited live (ADR 0089). Renamed and deleted through `POST /api/levels/move\|delete` (ADR 0110) |
| Prefab (a root `Node`) | `content/assets/prefabs/<name>.prefab.json` — an **asset** with a `.meta` id (ADR 0026) | created once by `Save as prefab…` (`createPrefab`, `src/assetsApi.ts`), then **edited live** in its own room (ADR 0091) |
| Game data file (shared components, settings) | `content/<game>/game.json` | a live document: `POST /api/live/game/<game>/ops` (`gameSync`, ADR 0162) — its list appended by adoption (ADR 0077) and trimmed from the games window (ADR 0175), its settings from the games window |
| Materials | `content/assets/**/*.mat.json` | a live document: `POST /api/live/asset/<id>/ops` (`assetSync.ts`, ADR 0159); a new one is created with `PUT /content/<path>` |

Levels and prefabs are live rooms and materials and game files live documents, so there is no Save and no lock for any of them (ADR 0089, ADR 0091, ADR 0159, ADR 0162).

## Panel layout (`tools/editor/index.html`)

One CSS grid `#app`; `--left`/`--right`/`--bottom` written by `createSplitter` (`src/splitter.ts`). No UI framework and no widget library: every control is ours (`src/controls.ts`, ADR 0152).

`main.ts` is a **shell** (ADR 0121): the state it owns, construction, host literals, boot. A subsystem is its own module holding its own mutable state, reached through a getter-bag host — the convention the panels already use. Pure arithmetic is its own module again (`selection.ts`, `snap.ts`, `facePull.ts`, `surfaceGrid.ts`). Host entries are always arrows: a subsystem is constructed at module init and half of what it wants is declared further down.

| Subsystem | Owns | Host |
| --- | --- | --- |
| `itemMeshes.ts` | `instanceRoot`, `markerGroup`, the groups, the shadow budget, the cell toggle | `doc`, `loaded`, `runtime`, `mode`, `gameSettings`, `selected`, `afterBuild` |
| `play.ts` | the game frame (ADR 0172) | `PlayHost` (13 getters) |
| `historyStore.ts` | the history (a level edit, an asset edit, a turn), pending batches, `coalescing`, the held-back drag batches, an action's held batches, the open turns, the clipboard | `HistoryHost` |
| `actions/` | nothing — the editor's actions as data, the tab's set installed at the end of `main.ts` (ADR 0194, `editor-actions.md`) | `ActionHost` |
| `liveSession.ts` | `collab`, the peer list, every `connId` this tab has had (`mineEver`), the last snapshot, `joining`, the deferred ops, the hold map and its key, the hold outlines, the presence timer | `LiveHost` |
| `assistant/` | the assistant's button, chat and tab (ADR 0192, `assistant.md`) | `AssistantDockHost` |
| `follow.ts` | whom this tab follows, the pose it glides to and whether the leader's holds are still to be taken; who follows it, the send timer and the last pose sent (ADR 0155, ADR 0184) | `FollowHost` |
| `people.ts` | the icons it drew and whose card is open (ADR 0155) | `PeopleState` getter + `PeopleActions` |
| `motionPreview.ts` | the preview clock, whether it runs, the last frame. Poses via `Doc.posesAt(timeMs, { sequences: playing })` — one walk, not `poseOf` per node (ADR 0125, ADR 0142) | `MotionPreviewHost` |
| `cameraView.ts` | the orthographic camera, `isometric`, the nav gizmo and its drag flag, the stand-in background, the bounds box, the far plane | `CameraViewHost`, `farToSee` |
| `fileActions.ts` | nothing — it is behaviour: ready a dropped asset (`whenPlaceable`), rename, delete an asset or a level (ADR 0097, ADR 0110) | `FileActionsHost` |
| `assetWatch.ts` | the long poll's position and its back-off; `main.ts` keeps the paths waiting to be applied (ADR 0156) | `AssetWatchHost` |
| `prefabActions.ts` | nothing — enter, close, unlink, save as, revert, apply (ADR 0091, ADR 0111) | `PrefabActionsHost` |
| `nodeActions.ts` | nothing — delete, duplicate, create, frame, paste at a point; all on selection **roots** | `NodeActionsHost` |
| `menus.ts` | nothing — the right-click menus, declarative; had to follow the action clusters, not precede them | `MenuHost` |
| `pickTool.ts` | the raycaster, the ground plane, where a press landed, the face highlight, the pull in progress; `placeAsset(kind, id, at)` | `PickHost` |
| `dragPlace.ts` | the asset a tile drag carries and its see-through copy (ADR 0164) | `DragPlaceHost` |
| `gizmoTool.ts` | `edit` (tool, frame, snapping, one increment per tool), the drag-start poses, the two drag flags | `GizmoHost` |
| `pointTool.ts` | the open move step, its copy and the copy's own `TransformControls`, the drawn routes, its drag flag (ADR 0144) | `PointToolHost` |


| Area | Element | Module |
| --- | --- | --- |
| Top | `#toolbar` (ADR 0149), a 3-column grid: the game button (`tb-game`, `game › level ▾`, which opens the games window, ADR 0162), or `game ▾ › level › prefab` inside a prefab — the level is a button and the way back; **Motion** (with its clock while it runs, `setClock`) and **Play** in the middle; **undo / redo**, **Admin** (an admin's only: `me.admin`, opens `/admin.html` in a tab, ADR 0200), the **bell** and **who is in the room** at the right end (ADR 0155). No New or Duplicate (the games window's), no level list (ADR 0108), no mode select and no Save: both kinds of document are live rooms (ADR 0089, ADR 0091) | `src/toolbar.ts`, `src/people.ts` |
| Over the viewport | `#overlays` in `#centre` (ADR 0149): a layer that passes the pointer through, its panels (`.ov`) taking it back; **hidden while playing**. Left edge, vertical: Move / Rotate / Scale / **Face** (ADR 0119). Top left: Global / Local (globe / cube), the magnet, the active tool's increment with its unit (ADR 0114). Top right, left of the navigation gizmo: Grid, Markers, **Keys** (ADR 0120; hidden unless the game declares `surfaceGrid`), **Reveal** (ADR 0132; hidden while nothing is). Under the gizmo: the Persp / Iso button (ADR 0094). Icons only (`icons.ts`), each named with its key in its tooltip | `src/toolbar.ts`, `src/cameraView.ts` |
| Left | `#hierarchy` — node tree + context menu; how a row reads and drags is **The Hierarchy** below (ADR 0150). Rows alternate `--row-alt` by **rendered** position (`.row:where(:not(.env)):nth-child(even)`), declared before `:hover` and `.sel` so both win on source order | `src/hierarchy.ts`, `src/hierarchyDrag.ts`, `src/menu.ts` |
| Centre | `#centre`: `#banner` above `#stage`, which holds `#view` — Three stage, orbit, transform gizmo, placement clicks — and the layers over it: `#overlays`, `#toasts`, `#vhint`, `#readout`, `#hint` | `src/main.ts`, `src/itemMeshes.ts`, `src/play.ts`, `src/notices.ts` |
| Right | `#insp-head`, `#inspector`, `#asset-inspector` | `src/inspector.ts`, `src/assetInspector.ts` |
| Bottom panel | `#palette` **Project** (asset tree, previews) | `src/projectPanel.ts`, `src/assetTree.ts`, `src/previews.ts` |

Document model: `src/editorDoc.ts` (`Doc`, `levelDoc`, `prefabDoc`; a `Doc` captures its `registry`; every mutation is an op batch, below). Undo: `src/opHistory.ts` (the stack, inverse ops, ADR 0089), each entry undone step by step around what others changed since, `src/undoSteps.ts` (ADR 0194, `editor-actions.md`). Shortcuts: `src/shortcuts.ts` (ADR 0030).

## Content API — `editor-server.md` (ADR 0083)

The routes are `tools/editor-server/src/api.ts`, mounted by `vite.config.ts` (`filesApi` plugin: `createContentApi` with `identify → local`, no git) and by the hosted server. Clients: `src/filesApi.ts` (levels, games, `me`, `serverStatus`, `uploadAsset`, `ApiError` with `status`), `src/assetsApi.ts` (`loadAssetLibrary`).

### Identity and upload in the editor (`src/main.ts`)

No file locks and no Save: levels and prefabs are live rooms, materials and game files live documents (ADR 0173).

| Piece | Behaviour |
| --- | --- |
| `me` | `GET /api/me` at boot; `heartbeatMs`/`maxUploadBytes` read from it |
| `openFile` | `leaveFile()` (leave the rooms — the server commits that session — reset following, drop held drag batches), then **joins the level's live room** (`room.joinRoom(name)`, below). Levels only: a prefab is entered with `enterPrefab`, not opened as a file |
| `newBlank` | `createLevel(null)` — a level exists the moment it is named (below) |
| heartbeat | `setInterval(heartbeatMs)`: `room.ping()` while live; `serverStatus().pushError` → `pushProblem`, a banner line `not on GitHub yet: …` |
| `pagehide` | `room.beaconLeave()` |
| upload | `ProjectHost.onUpload(files, folder)` from a desktop drop on a folder row, folder tile or the grid (`dropTargetFor`, `folder` getter; not while searching), or the **+** menu's *Upload files…*; files over `maxUploadBytes` are named and skipped; `afterFileOp` uploads the rest |

## Live levels (`src/collab.ts`, ADR 0089)

A level is a **live session** on the server (`editor-server.md`, *Live documents*): every batch the document
reports is applied locally at once and sent; the server numbers it and echoes it to everyone, the sender included
(the echo is the ack). Prefabs are rooms too (ADR 0091).

```ts
createCollab(transport: LiveTransport, hooks: CollabHooks): Collab
// join(name) resolves on the first snapshot · leave · submit(batch) · flush() · hold(refs) · release(refs) · presence(data)
// beaconLeave() · connId() · name() · peers() · holds() · connection() · pending()
httpTransport(): LiveTransport   // EventSource in, fetch POST out, sendBeacon for the way out
```

| Piece | Behaviour |
| --- | --- |
| join | `openFile` (level) → `room.joinRoom(name)`, which resolves the snapshot it was greeted with — that level is what adoption, validation and `levelDoc` run on. `joining` is `joinRoom`'s own, so the first snapshot builds the caller's document while a later one (a reconnect) reinstalls it (ADR 0121). A join the server refuses is the load error |
| outbound | `onDocOps` → `pending` (history) **and** `collab.submit(batch)`; the batch is *unacked* until its echo. `applyHistory` submits the inverses it applied |
| inbound | a remote batch: unacked batches rolled back (inverses, newest first), remote applied, unacked re-applied (inverses recomputed; one that no longer applies is dropped and reported); `hooks.onApplied(ops)` → `repaintAfterOps` (`liveSession.ts`). A seq gap or a failing apply reopens the stream: the server greets with a fresh snapshot, `reinstallLevel` rebuilds the document over it (history kept), unacked batches are re-applied and re-sent |
| rejected | a 4xx on the POST: that batch and everything after it rolled back, the later ones re-applied, `onRejected` → `history.dropWhere` (the entry holding it) + an error toast + repaint |
| repaint | `repaintAfterOps(ops)`: transforms only (`setTransform` / `setOverrideTransform`) → `applyPreviewPoses` + `scheduleRebuild` + `inspectorSync` + track helper; else `repaintFor(ops, typeOf)` (`remoteRepaint.ts`, ADR 0167) — the environment re-applied only for `setEnvironment` / `setCameraSeeThrough`; nodes of the one-node kinds → `rebuildSubtree` each, `applyPreviewPoses`, `scheduleRebuild`, hold outlines, `hierarchyRender`, `inspectorRefresh` only when the Inspector shows one of them (or the environment; ADR 0168), and their subtrees again once new references load; names → the Hierarchy only; anything else — a structural op, a `table` op, a sequence or a component gone, a component of a type that `drives` others (`repaintFor`'s third argument, `open.drives`, ADR 0210), an op not on its list — `host.rebuildViewport()`, selection put back by `indexOfRef`, `refreshUi` + `inspectorRebuild`. During a gizmo drag ops queue in `deferredRemote` (the data is already changed) and repaint when it ends (`room.drainDeferred()`, from the drag's `mouseUp`). Play holds nothing back: the game in its frame has a world of its own |
| Play | `play.start`: `collab.flush()` first — the game reads the level from the server (ADR 0172) |
| New / Duplicate | `createLevel(from)`: `askName` (`confirm.ts`) → `^[\w-]+$` → refused if `listFiles('levels')` has it → `PUT /api/levels/<name>` a `blankLevel` with the active mode, or the open level (`loadLevelRaw`, the server's live copy) with `id` set → `refreshFileList` → `openFile`. From the games window: *New level* (`onNewLevel`, `createLevel(null, game)`) and a level's *Duplicate…* |
| peers | `room.peers()`: `{ connId, name }` per connection in the room, this tab's included, from its `peers` events; `[]` with no room open. `peerChanges(before, after, mineEver)` (pure) → a toast `X joined` / `X left` per `peers` event — not for the room as it was on joining (`joining`), and never for a `connId` that was ever this tab's (a reconnect's old one is listed a moment under your name) |
| connection | `Connection` = `connecting` (join, a reopened stream, `onRetry` from the `EventSource` retrying) → `live` (a snapshot) → `lost` (`onDrop`); `null` after `leave`. `hooks.onConnection` → `host.presenceChanged()` |
| leave | `dropAllLocks` → `collab.leave()`; `pagehide` → `beaconLeave()` |

Two tabs of one person are two `connId`s: separate acks, separate holds.

### Rebuilding the viewport

`buildItems()` disposes every mesh under `instanceRoot` and builds a fresh `THREE.Group` per document item, so
**`instanceGroups` is a different array of different objects after every call**. It reads the document in one
`reading` pass, as `rebuildSubtree` and the Hierarchy's `render` do (ADR 0167). `disposeMeshes` frees only what
`itemMeshes` made (`mine`: a node's shape, a grey or faded material, a gizmo's, and every light, with its shadow
map; a node's text by its own `dispose`) and never the runtime's materials, a model's shape or the key cells' — two frames late (`throwAway`), once the
replacement has drawn, so a shader is never freed while it is still wanted. `drawn(open, i)` — switched on, not
under a switched-off node (ADR 0099), not hidden (ADR 0132) — is the one test for the full build and a one-item
rebuild (`rebuildItem`, `rebuildSubtree`) alike. The shadow cap (`EDITOR_SHADOW_CAP` 4,
ADR 0047) goes to the first lights wanting a shadow in document order, each holder recording `wantsShadow` /
`castsShadow`: `buildItems` deals them as it goes; a one-item rebuild takes its light's answer from the lights
before it and, when whether it wants one changed, `reshareShadows` deals again, rebuilding any light that gains or
loses one (`createLight` sets a shadow camera up only for a caster). A node's `Text` (ADR 0189) is
`createText(textStyleOf(doc.textSpec(i)))` (with what a component pointing at it `drives`, ADR 0210) in its holder, its scale put back to the world scale the holder undoes,
pickable, and on the fade list when the node fades — the game's drawing, from the same `textOf`, its font from
`runtime.fontUrl`. A `font` field's picker leaves out a woff2, and `assetRefusal` refuses one dropped (ADR 0190). Called on open, on a
structural repaint, on a remote batch, on entering and leaving a prefab — and, crucially, again from
`loadNewReferences(buildItems)` once newly referenced assets have loaded, which is **asynchronous** and goes
through no selection change. Only when something new arrived: `AssetRuntime.load` resolves `true` then, and every
caller has drawn already.

Two things hold those groups, and both are re-pointed **inside** `buildItems`, at both of its exits:

| Holder | Function | Was stale as |
|---|---|---|
| the transform gizmo | `reattachGizmo()` | `TransformControls: The attached 3D object must be a part of the scene graph`, every frame, then a null `updateMatrixWorld` on the next click |
| collaborators' hold outlines | `rebuildHoldOutlines()` (`room.rebuildHolds`) | no outline at all on somebody else's selection: a group no longer in the scene draws nothing — silent, which is how the boxes before them outlived the gizmo's version |

Putting them at the call sites is what failed before: both sites ran them *before* `loadNewReferences`, so the
async rebuild landed afterwards and undid the work. `refreshBoundsBox()` is there for the same reason.

`rebuildHoldHelpers()` is also called on a holds event, since holds change with no rebuild at all.

### The navigation gizmo (ADR 0094, ADR 0149)

`src/viewGizmo.ts`, top-right of the viewport, 128 px (`ViewGizmo.size`). Unity's shape and centre, no
auto-switch. Six cones pointing in at a cube: `+X`/`+Y`/`+Z` in the axis colours (`0xff4466`, `0x88ff44`,
`0x4488ff`) with a letter beyond each, the negative three grey (`0x8a93a0`). Picked by raycast against
invisible **reach** spheres (0.3 per cone, 0.26 round the cube, in a ±1.45 frame), not the drawn shapes;
the **nearest** wins, so what is in front is what is clicked.

| Gesture | Effect |
| --- | --- |
| hover | the part under the pointer turns `0xffd54a`, with a pointer cursor (`hover(event \| null)`, from a document `pointermove` in `cameraView.ts`; off while a button is held or playing) |
| click a cone | snap to that axis over 0.35 s, smoothstepped, keeping the orbit distance |
| drag anywhere on it | orbit, past 4 px of slop — so a drag that starts on a cone orbits, and a click on it still snaps |
| click the cube | toggle perspective / isometric |
| click **Persp** / **Iso** under it | the same toggle: an HTML button (`.ov-proj`) in the overlay layer, so it works when a cone pointing out of the screen covers the cube |

Snapping never changes the projection: two decisions, deliberately not fused (ADR 0094 on Blender's *Auto
Perspective*).

**The background.** A cubemap `scene.background` is perspective-only in practice (`rendering.md`), so
isometric gets a flat `THREE.Color` mixed from the level's `skyParams` instead, and the cube is restored on
the way back. Every path that installs an environment goes through **`installEnvironment`** — one function
replacing four pairs of `env.applyEnvironment` + `postfx.apply` calls — because a path that installs a sky
without re-applying this is a black viewport that only appears in isometric.

**Two cameras.** `stage.camera` stays perspective, and `orthoCamera` sits beside it in `main.ts`. `activeCamera()` says which is live; `setProjection(ortho)` copies
the placement across, cuts the frustum so both show the same height at the orbit target, and re-points
`postfx.setCamera`, `controls.object` and `gizmo.camera`. `focusSelection`
and the picking raycast both go through `activeCamera()`.

**The far plane** (ADR 0201): outside play, every frame (`view.update`), the active camera's `far` is
`farToSee(position, reach, floor)` — the distance to the level's bounding sphere's far side × 1.05, rounded up to
100 m, never below `floor`: the stage's own 1000 m in perspective, the ortho camera's 2000 in isometric. `reach` is
`Box3.setFromObject(instanceRoot)`'s sphere, measured at most every 500 ms. Playing, `stage.camera.far` is the
game's 1000 again. `near` stays 0.1; GTAO reads `far` each frame.

**The pointer.** `document` in the **capture** phase, `stopPropagation` when the gizmo takes a press:
`OrbitControls` and the selection click listen on the canvas itself and were added first, so there is no
getting in front of them from there.

Drawn in the render step **after** `postfx.render()` — it clears depth and paints over the finished image —
and not at all while playing. `gizmoPointer` and `orbitAround` are pure and tested; the picking, the hover and
the snap are tested through `createViewGizmo` with no renderer (its own camera's matrix is set at
construction for that reason — picking reads it, and before the first render it was the identity).

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
| resolve on open | `openFile` runs `hydratePrefabs(level, editorPrefabs)` — `assets.prefabOf`, already in memory from boot — and keeps `hydratedPrefabs` (what it filled) and `missingPrefabs` (what it could not), naming the missing in a warning |
| resolve mid-session | three doors add a definition after the open — `placePrefab`, `paste` of a clip that carries one, and `linkToPrefab` (Save as prefab). Each records it in `Doc.resolvedPrefabs()`, and a save strips the open-time set **union** that (ADR 0124). None of them used to, so the definition reached disk — where `hydratePrefabs` skips an id the level already carries, so the frozen copy is read *instead of* the asset from then on, by the editor and the server, permanently. A placement that looks linked and silently stops following its prefab |
| enter a prefab | `enterPrefab(assetId)`: leave the level's room, `room.joinRoom(assetId, 'prefab')`, build `prefabDoc` over the snapshot's one root, `prefabOpen = { assetId, name, from }`. From a placement (`openPrefabOf`, the Inspector's **Open**, the Hierarchy and viewport menus) or from a prefab's Project tile — which is the only way to reach one that is placed nowhere |
| one at a time | The viewport, the physics world, the selection and the holds are singletons keyed to the open document, so a tab is in one room. **Back** (`closePrefab`) rejoins the level, which the server answers with a fresh snapshot, so anything that changed meanwhile is there |
| follow a prefab | a `prefab { assetId, ops }` event on the **level's** stream → `onPrefabOps`: `applyBatch` over `{ id, config: {}, nodes: [root] }`, whose root *is* the resolved definition, then a structural repaint and `previews.invalidate()`. No sequence and nothing sent back: the level's own file did not change |
| Apply to prefab | two rooms, one gesture. `Doc.overrideOpsFor(i)` — the record's fields (transform, name, params, component enables and removals, added components, sequences, `nodeEnabled`), then `childrenToPrefab`: the children it added, inserted with fresh ids, and every child `moveNode`d into the order shown (ADR 0151) → `collab.submitToPrefab(assetId, ops)` → only if the server took them, `Doc.revert(i)` here. Undo puts **this placement's** override back and does not take the change out of the prefab; the confirmation says so |
| **children: one door** (ADR 0151) | Every edit of what a node shows under it goes through its **host**: `hostOf(parent)` is a `list` (an object of the level: its `children`; the level: its forest; in a prefab, `null` is the root's children) or a `record` (a placement — keyed by the prefab root's id — or one of its pieces: `childrenFor`'s children, plus ADR 0130's `children` on the placement, shown last). `insertOps` / `removeOps` / `reorderOps` turn "show this here" into ops: on a record, `insertOverrideChild`, a removal (`setOverrideNodeRemoved`) for a piece or `removeNode` for an added child, and `setOverrideChildOrder` **only** when the order shown is not the natural one (inherited, then added) — `null` when it becomes natural again. The first edit that orders a placement's children moves ADR 0130's into the record, same ids. `DocNode.slot` is where a node is **shown** among its siblings (`siblingIndexOf`), `index` where it is stored; `childCount` counts the tree |
| a drag, a reparent | `Doc.reparent(from, parent, at, transform?)`, `at` a shown slot before the move. Same host: a **reorder**, the transform left alone — a piece stays a piece. A **piece** anywhere else: a copy of its view with fresh ids inserted there, then its removal recorded (ADR 0133). An own node between two lists: `moveNode` + `setTransform` (ADR 0113). Into or out of a record: `removeNode` then an insert, same node, same ids. `canReparent`: not into its own subtree, not beside a prefab's root, and anything with a host takes a child — a piece included. The Hierarchy's drop (`dropAt`) offers every row. Grabbing a **selected** row drags the whole selection, an unselected one drags it alone (ADR 0134); roots only (`rootsOf`); every pose read before anything moves, from the authored poses (ADR 0126); addressed by **ref**; one history entry; what cannot go there is skipped and counted in a warning |
| removing a piece | A piece is **deleted from one placement** (ADR 0133) — `NodeOverride.removedNodes`, kept on the removed piece's own record so clearing that record brings it back. The prefab keeps it and every other placement keeps it. Dropped in the **tree walk** as well as in `bakeOverrides`. Reported by `Doc.placementRemoved(i)`, read off the records, since a removed piece has no index. Revert puts it back; **Apply deletes it from the prefab**, first, so every placement everywhere loses it. Delete and Cut (copy, then delete) work on a piece like on anything else |
| copying a piece | A piece copies as what it looks like (ADR 0131) — `Doc.copy` takes its resolved `view`, the whole subtree with this placement's overrides baked in, a plain object and not an edit of the prefab. `paste` re-mints the ids and puts it wherever you paste; `duplicate` puts it **beside** the piece, in the placement's record, placed there by a recorded order. `reidSubtree` re-mints what a copied placement added under its pieces too, and follows those ids in its `childOrder` |
| a child added to a placement | Created, pasted or dropped on a placement, it goes in the record of the prefab's **root** (ADR 0151), not the placement's `children` (ADR 0130's storage, still read); a component added on the placement likewise goes in that record's `added`. `Doc.placementAdded(i)` finds the roots of what was added, anywhere under the placement, for the counts. **Apply** inserts each into the prefab under the piece it hangs from, re-minted (a prefab's ids are its own), transform unconverted (same frame); **Revert all** clears every record — which takes added children, orders and removals with it — and strips ADR 0130's children and components off the placement, one batch (it used to remove added children one by one after clearing the records that held them, and threw). **A placement added under a placement is not applied**: the inner definition would have to resolve in the prefab's room, which ADR 0124 has not been worked through for |
| Revert/Apply have two scopes | an override is stored per inherited **piece** — and for the placement's own inherited **root** components, on the placement keyed by the prefab root's id (ADR 0098). `recordKey(n)` says where either lives, so the root is `placementOverrides`' first entry when it has changes; before ADR 0139 nothing read that record back. On a root the pair acts over every piece the placement owns: `Doc.placementOverrides(i)`, `Doc.revertPlacement(i)` (**one batch** — one Ctrl+Z, one message to the room), `Doc.placementOverrideOps(i)` (one submission, so a partial failure cannot half-apply). Owned by *this* placement only, so a nested one's pieces stay its own. Labels carry the scope: `Revert all to prefab` / `Apply all to prefab` with the count as the menu hint, and the Inspector's **Overrides ▾** says `N overrides on M objects` (ADR 0152). Before this the pair was permanently greyed on the prefab object and the Inspector said nothing there |
| unlink a placement | `Doc.unlinkNode(i)` — one `replaceNode` op (ADR 0111). The node keeps its id, transform and place in the tree and takes the resolved name, components and children, so an override becomes the value; the prefab's pieces are cloned with fresh ids, since a prefab's are scoped to itself — and what the placement **added** keeps its ids, since the level's references name them (ADR 0151). Refuses a non-placement and an inherited node. From the Hierarchy menu's *Unlink from prefab* and the last item of the Inspector's **Overrides ▾**. No confirm: one op, so Ctrl+Z puts the link back |
| no Save, no lock | both kinds of room write themselves. The top bar has no mode select and no Save; it reads `level › prefab`, and the level is the way back (ADR 0149). A prefab is renamed in the Project panel |

**The prefab grid** (`src/prefabGrid.test.ts`, ADR 0151): every gesture — rename, switch off, delete, duplicate,
create a child, reorder, move into, paste into, Revert, Apply — on every kind of node (an object of the level,
a placement, a piece, a child added under a piece), each checked in the editor's tree, after the level is
written and reopened with its prefabs resolved from their files, in what `effectiveNode` builds, and through
undo back to the exact starting JSON — plus Apply run over the prefab's own document, which must come out
looking like the placement, and unlink keeping the level's ids. Seventeen failed before the rebuild (ADR 0151);
each carries a comment saying what used to go wrong.

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

`deleteAsset` in `src/fileActions.ts`. What a path covers is `deletedBy(entries, path)` (pure): the file, or a **folder and every asset under it** — its prefabs each unlinked as one alone is. With no prefab among them it goes straight to the server (a folder with anything in it after a `confirm`); otherwise:

| Step | What |
| --- | --- |
| count | `listFiles('levels')` reports each level's `prefabs` (asset ids), so the confirm can say how many placements are in this level and which other levels use any of them; `deleteWording` (pure) says it, a folder's naming its prefabs |
| confirm | `askDestructive` (`src/confirm.ts`). Enter is **Cancel**, not the destructive button. Says the id does not come back — the `.meta` goes with the file, so a prefab created again later is a different asset |
| other levels | `unlinkedLevel` (pure): `hydratePrefabs` → `unlinkPrefab` per id → `stripHydrated` of **everything hydration filled** plus the deleted ids — stripping only the deleted one wrote every other prefab the level places into its file as a frozen copy (ADR 0124) — then `saveFile`. A `PUT` **409s while that level is open live**, and that refusal aborts the whole delete and names the level rather than rewriting a file under somebody |
| this level | `doc.unlinkPrefab(id)` per id placed here — `replaceNode` ops, so it is one undo entry and everyone in the room sees it |
| the file | last. A failed unlink then costs nothing; the reverse order would leave placements pointing at a dead id |

The unlink itself is `@mp/content`'s (`content.md`), with the registry injected: only this side knows which
components are singletons and which parameters are node references. The editor-server has no registry.

**Several at once** (`fileOps.deleteAssets(paths)`, ADR 0166): a path inside another being deleted drops out; one left
is `deleteAsset`; else one `askDestructive` (`severalWording`: how many, the files going, and — prefabs among them
placed — that those objects are unlinked), `unlinkEverywhere` as for one, then `AssetLibrary.removeMany`.

### Save as prefab… (ADR 0091)

One action makes a prefab, replacing both `Extract to prefab` (which wrote no file) and prefab mode's Save
(which made no reference). In the Hierarchy and viewport menus, both calling
`saveAsPrefab(index)`.

`prefabFolderFor(project.folder(), game, uses)` → `askName` (its hint names the folder) → `prefabTarget(folder, name, taken)` (`src/prefabPath.ts`, pure and tested) →
`assets.createPrefab(path, doc.definitionOf(index))` → `reloadAssets()` → `doc.linkToPrefab(at, id, definition)`
→ `recordEdit('save as prefab')`.

- **Where it goes** (ADR 0218, Kodjo's call): the folder open in the Project panel when it may hold it — Shared's
  when every asset the definition uses (`assetsUsedBy`, direct) is Shared's, the level's own game's always — else
  `<game>/assets/prefabs/` of the level's game. Never another game's: the level could not place it.
- **The file goes first.** A failed write costs an error toast; the reverse order would leave a placement
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
| receive | `onPresence(from, data)`: a camera, a follow or a Motion preview goes to `follow.ts` (*Who is in the room* below); else `parsePresence` → for each pose `indexOfRef` → set the group's position/quaternion/scale; skipped for a node in my own selection while my gizmo drags. `end` → `applyPreviewPoses()` unless my gizmo is dragging (my drag end repaints). The hold outline follows, since it is drawn from the group each frame |
| nothing kept | presence is unnumbered and never written; the op at drag end is what lands, and a drag that came back to its start lands nothing |

Others' selection is what the hold outlines and badges show: a selection *is* a hold.

### Holds — who has what selected (ADR 0158)

A hold is a selection, **shown and never refused** to a person: several people may have one node, and anyone selects
and edits anything. An agent's edit is refused on another connection's hold (`room.heldByOthers`, ADR 0194). Two edits to one thing: the last batch to reach the server is what stays, and everyone repaints to it.

| Piece | Behaviour |
| --- | --- |
| `syncHolds` | after every `applySelection`/`deselect`: `room.syncHolds()` → `collab.setHolds(host.selectionRefs())` — the **whole** selection, skipped when unchanged (`lastHoldKey`). Hold messages queue one behind another in `collab.ts`, so a release can never overtake the hold before it. `reinstallLevel` (new `connId`) re-sends; a `hello` with a new `connId` posts `leave` for the old one |
| heartbeat | the editor's heartbeat `collab.ping()`s while live: the server sweeps a connection it has not heard from in two minutes, holds with it |
| `holdMap` | `refKey` → every `Hold` on it, theirs and mine; `holdersOf(index)` the others on that node itself (not its ancestors) |
| `onHoldsChanged` | on every `holds` event: `holdMap` rebuilt, `rebuildHoldOutlines`, `hierarchy.render()` — nothing leaves my selection |
| Hierarchy | `rowsOf(doc, open, holders)` → `Row.held: Holder[]` (`{ name, colour }`, from `room.holdersOf` + `peerCss`); a `.badge.held` per person in their colour (`--peer`), a title naming them; the row selects, renames and drags as any other |
| viewport | an outline of the held node's group — its subtree — in the holder's `peerColour(connId)` (a hash to `HSL(h, 0.75, 0.6)`; `peerCss` for CSS — the icon and the badge take the same): `room.holdOutlines()`, one `OutlineGroup` per connection, cached and rebuilt on holds events and after structural repaints; drawn by the same pass as my own (below) |

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

## The Hierarchy (ADR 0150)

`src/hierarchy.ts` draws `rowsOf` (pure); `src/hierarchyDrag.ts` moves rows. Rows are 24 px, indented
`ROW_BASE + depth × INDENT` (6 + 16 px a level).

| Part | |
| --- | --- |
| Level, Environment | above the tree, a rule under them: `level` / `sun` icons (`icons.ts`), not emoji. **Level** is the level's network bounds (ADR 0162, `levelSelected`, Inspector card `@level`); which game it is for is its folder |
| guides | `.guides`: a 1 px `--guide` line per level above the row, under the twist of the row it hangs from — a repeating gradient `depth × 16` px wide |
| twist | the `chevron` icon, turned −90° while shut |
| cube | `rowIcon(row)`: `prefab` (filled) in `--link` for a placement, `object` in light blue (`is-piece`) for a prefab's piece, `object` in grey for the level's own. A placement's name stays `--link` |
| name | italic and dim when switched off, here or above (ADR 0099); a switched-off row's cube at 0.45 |
| eye | right end, before the count (ADR 0132, `Hiding a node` below): on hover, and always once hidden |
| badge | `×N` for a prefab placed more than once, nothing else (`inline` went); and one per person who else has it selected (ADR 0158) |

**Drag** — pointer events, not HTML5. A press becomes a drag after 4 px; a plain press selects nothing — the click
does (`defersToClick(mode, button)`, ADR 0176) — so a drag leaves the selection and the Inspector alone. It carries the
whole selection when the grabbed row is in it (ADR 0134), else that row; what a drop does is `Doc.reparent`'s. Off the
list, `outside(x, y)` → `refFieldAt` (the Inspector reference field under the pointer, *Inspector — reference fields*):
offered the grabbed row once per field (`offer` lights or greys it), `take` on the drop instead of a reparent, `leave`
on moving off. `ping(index)`: `reveal` + `.ping` for 1.2 s, the selection untouched — a reference field's press. A copy with the grabbed
row's cube and name (`+N` for more) follows the pointer; the carried rows dim. Where it lands is
`dropAt(rows, y, wantDepth, canOnto)`, pure, over the rows measured each frame:

| Pointer over | Lands |
| --- | --- |
| a row's middle 40 %, when some carried row can go under it — a prefab's piece too (ADR 0151) | **into** it, last (`drop-onto` lights it) |
| its top or bottom 30 % — or its halves, for a row nothing carried can go into | the gap beside it |
| past either end | the gap at that end |

A gap offers the depths that keep the tree what it shows: before the row below at its depth; or after the row
above at any depth from the row below's up to its own, closing the groups it ends. The pointer's x picks
(`(x − left − ROW_BASE − INDENT / 2) / INDENT`, rounded, clamped), so at the end of a group, left leaves it. A
fixed `.hier-line` marks the gap, indented to that depth. A place no carried row can go shows nothing
(`Doc.canReparent`); on the drop, the rows that cannot are skipped (`onReparent`). Holding 600 ms over a shut row
opens it; the list scrolls within 28 px of its edge; Escape cancels; the click after a drag is swallowed
(`rowJustDragged`).

**Scrollbars**, every panel: `::-webkit-scrollbar` 12 px wide with no buttons, the thumb drawn 6 px (8 on hover)
inside a transparent border that still takes the pointer; Firefox gets `scrollbar-color` only, because Chromium
ignores the pseudo-elements wherever that is set.

## Project window — the asset libraries (ADR 0161, ADR 0163)

`src/projectPanel.ts`, `createProjectPanel(container, host)` → `{ render, folder(), openersChanged(), reveal(path), named(path) }`. Levels are
the games window's (ADR 0162).

```
[+]  Shared › materials                     [🔍 search…     ×  All ▾]
┌ tree ───────────┐┌ tiles ──────────────────────────────────────┐
│ ▾ 🗀 Keyboard    ││ 🗀 sub   ◼ brick   ◼ red (AL)   …          │   <- the open game's own library (ProjectHost.game)
│   🗀 materials   ││                                             │
│ ▾ 🗀 Shared      ││                                             │   <- SHARED, `content/assets`
│   🗀 materials   │└─────────────────────────────────────────────┘
└─────────────────┘ Shared/materials/red.mat.json         ──●── size
```

| Part | Now |
| --- | --- |
| roots | `roots()`: `libraryDir(game)` labelled with the game's label, then `SHARED` labelled *Shared*; each drawn even with no file. A folder gone (deleted, moved, another game's now) falls back to the nearest one still there, else `SHARED` |
| tree | `buildTree(db, folders, root)` per root, `flattenTree(tree, collapsed)`; `.row`s, `4 + depth × 14` px; a `chevron` twist only over children; a `folder` icon on each; no counts; the folder you are in `.sel`. A click goes there (and ends a search); going anywhere opens its ancestors |
| tiles | `.ex-grid`, `--tile` px square: the folder's subfolders (`subfoldersOf`), then its files (`filterEntries({ libraries: [root], folder })`). `.pt` = `.pt-pic` (a kind icon, `ASSET_ICON` in `icons.ts`; the preview `img.thumb` over it once the observer has it) + `.pt-name`. Drawn again only when what they come from changes (`drawnFrom`: the library, its folders, the game, the folder, the search, the kind, the sort) — else lit, greyed and faced in place, so a double-click and the keyboard's focus survive a redraw. A double-click on a folder goes in, on a prefab opens it (`onOpenPrefab`); a prefab or model drag says what it carries (`onDragAsset(id)` when it is the one selected, `null` on `dragend`; `effectAllowed` `copyMove`) — *Placing* below. Greyed with why (`unplaceableWhy`, `paintPlaceable`), still selectable. A right-click is `host.onContext` |
| selection | `picked`, paths in the order picked (ADR 0166): a click only it, Ctrl+click adds or takes away, Shift+click from `anchor` to it in drawn order (`modeFor`, `selection.ts`); the last picked, a file, goes to the Inspector (`onSelectAsset`). An asset selected elsewhere (`host.selectedAsset()` changed — *Used by*, an undo) becomes it; none, and only folders stay; one gone drops out. Going to a folder empties it |
| keys | on the container, not from an input (ADR 0166): arrows (left/right along the order, up/down to the nearest tile in the next row by `offsetTop`), Enter (`open`: a folder in, a prefab opened), Backspace (`up`: the parent, the folder left selected and focused), Delete (`onDelete(picked)`), F2 (`onRename`, one), Ctrl+A (all drawn) — each `preventDefault` + `stopPropagation`, so none reaches the editor's shortcuts. The grid is `tabIndex -1` and takes the focus when a redraw removes the tile that had it |
| sort | `.ex-sort` (`host.menu`: Name, Kind, Date changed, ✓ on the current), per viewer (`localStorage` `mp.project.sort`); `sortEntries(entries, by, modified)` (`assetTree.ts`): name; kind then name; newest first by `host.fileOf(path).modified`, the undated last. Folders first, by name |
| list | the slider at `SIZE.list` (its minimum): `.ex-grid.list`, a line each, an 18 px picture |
| faces | `.pt-people .pp` per `host.openers(id)` (ADR 0159), repainted in place by `openersChanged()` (`openAssetsChanged` in main) |
| + | `host.menu`: *New folder…* (`askName` → `onMkdir(folder, name)`), *New material* (`onCreateAsset('material', folder)`), *New data* (ADR 0181: `host.dataTypes(folder)` — the declaring game's types, none in Shared — as nested submenus by `dataMenuPath`, Unity's `CreateAssetMenu`; greyed with why where none may be made; a leaf → `onCreateData(type, folder)` → `assets.createData(name, newDataAsset(def), folder)`, named after the type, `-1`, `-2` while taken), *Upload files…* (a hidden `input[type=file]`, accept = the server's `UPLOAD_EXTENSIONS`, → `onUpload`) |
| path | `.ex-crumb` per part, root label first; a click goes there. While searching: *Every folder* |
| search | `.ex-search`: text (Escape clears it), `×` (clears text and kind), the kind button (`host.menu`: All kinds, then `ASSET_KINDS`, ✓ on the current). Text or a kind → `filterEntries({ libraries: every root, folder: null, kind, search })`, files only, names only |
| bottom | `.ex-foot`: one picked, `named(path)` (`<root label>/<path inside>`); several, *N items selected*; the slider `SIZE` 40–144 step 4, start 64, per viewer (`localStorage` `mp.project.tileSize`, try/caught) |
| drops | onto a tree row, a folder tile, or the grid (the folder on screen; not while searching): files from the desktop upload — **only a drag from outside the page** (`dragFromPage`, set by any `dragstart` in the document, cleared on `dragend` and after any drop): a picture dragged within the page comes as a file too, a data URL as `download.png`; thumbnails are `draggable = false`, the tile is what is dragged. Tiles move — a tile of the selection carries all of it (`application/x-mp-assets`, paths by line), another carries itself, the selection left alone (ADR 0176) — `onMove(froms, to)`, less any there already or the folder itself; main refuses a folder into itself, then `AssetLibrary.move` or `moveMany` (all or none, ADR 0166); between libraries the server may refuse with why (ADR 0161) |

Any drag of tiles reports the asset ids it carries, `onDragAssets(ids)` (`[]` on `dragend`) → main's `draggedAssets`:
what a reference field reads before the drop, since a browser drag cannot say until then (ADR 0176).

`folder()` is where *Save as prefab…* writes when it may (ADR 0091, ADR 0218). An asset's URL is `/content/<path>` (`assetUrl`), as on disk.
`Filter` (`assetTree.ts`) is `{ libraries, folder: string | null, kind, search }`: one folder's own files, or — `null`
— every folder of the libraries.

## Placing: a drag into the viewport (ADR 0164, `src/dragPlace.ts`)

`createDragPlace(canvas, host)` → `{ dragging(id | null) }`, fed by the Project window's `onDragAsset`: what a
drag carries cannot be read before the drop.

| | |
| --- | --- |
| the copy | at `dragging(id)`: `host.subject(id)` — a model `runtime.model(id)` (a clone), a prefab `prefabObject({ ...root, transform: { position: 0 } }, runtime)` (`previews.ts`, the tiles' builder; a placement keeps only its own position) — every material swapped for a clone at opacity 0.45, no depth write, no shadows; in `stage.scene`, never in `instanceRoot`, so no raycast meets it. Not buildable yet (a model not loaded): `host.load(id)` (`runtime.load`), then built if the drag is still on |
| `dragover` on the canvas | `refusal(id)` (playing, nothing open, `unplaceableWhy`) → hidden, `showReadout(why)` beside the pointer, the drop not taken; else `pick.surfaceUnder(x, y)` (the surface or the ground, snapped as a placement) → the copy there, `dropEffect` `copy`; off the world, hidden |
| `dragleave` | hidden, readout off |
| `drop` | `fileOps.whenPlaceable(id, kind => pick.placeAsset(kind, id, at))`: refused with why, shared components adopted, a prefab fetched fresh, then `placePrefab` / `placeModel` at `at`, one `place` edit, selected |
| the end | `dragging(null)` on the tile's `dragend` — dropped, Escape (the browser cancels the drag), anywhere: the copy removed and its clones freed |

Only this tab sees the copy.


## The games window (ADR 0162, `src/gamesWindow.ts`)

`createGamesWindow(host)` → `{ open, close, isOpen, render, settingsChanged(game) }`, opened by the top bar's game
button (`tb-game`, `game › level ▾`; inside a prefab `game ▾ › level › prefab`, the level the way back). A window
over the editor (`.gw-scrim`, z 40, under menus and dialogs): games on the left — the one you are in dotted, the
picked one lit — and the picked game's page with **Levels**, **Settings** and **Components**. Picking a game only
browses.

| Part | Now |
| --- | --- |
| Levels | `gameRows(games, levels)` (`assetTree.ts`, default first): a **New level** tile (`createLevel(null, game)`) and a tile per level, the open one lit, faces of who is in it (`room.peopleIn`, colours `peerCss`). Double-click opens (`openFile`, which is how the editor moves between games); right-click is `levelMenu` |
| Moving | a tile dragged onto another game on the left: held over it, the game lights or greys with why (`moveRefusal` → `levelMoveRefusal` in `main.ts`: a level of that name there, someone in it, a component of another game's own it cannot have, from `FileEntry.components`); dropped, `fileOps.moveLevelToGame` asks (`askDestructive`, *Move*) and relocates it as a rename does (`relocateLevel`: leave if open, move, reopen); the server refuses while it uses its old game's own assets |
| Settings | *Game settings* below: any game's, not only the one you are in |
| Components | `registryFor(MODES[game]).all()` as its own (not engine, not shared), Shared (`isSharedComponent`), Built in (`ENGINE_COMPONENTS` + `PLAYER_COMPONENTS`). A Shared row has a remove button (`.gw-component-x`) → `onRemoveShared` → `removeShared` (*Removal* below); the others are code |
| keys | the level behind gets none: a key pressed outside the window is stopped at `window` (capture), one pressed in it (or in a graph opened large, which goes inside `.gw-scrim`) reaches its field first and stops at `.gw-scrim` on the way out. Escape and a press outside close it; Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z are `host.undo` / `redo`, the one history — not while typing in a field. Left alone while a menu or a dialog (`[data-dialog]`, `confirm.ts`) is up |
| live | `rooms` (who is in which document) and `levels` (the list changed) from the server (`collab.ts` → `liveSession` → `roomsChanged` → `render`, `levelsChanged` → `refreshFileList`) |

## Right-clicking a level (ADR 0110)

`levelMenu(at, qualified)` in `main.ts`, from a tile in the games window. Open, Duplicate…, Rename…, Copy name,
Delete…

| Item | Notes |
| --- | --- |
| Open | disabled for the one already open, and inside a prefab |
| Duplicate… | `createLevel(from)`; copies the server's current copy, so a level open live duplicates as it is now |
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
- `package.json` lists no game; every game enters via the glob's relative path. `tsconfig.json` includes `content/<game>/levels/*.level.json`, `content/*/game.json`.

## Messages and the editor's state (ADR 0155, `src/notices.ts`)

The status bar is gone. `createNotices(toasts, banner, onChange)` → `Notices`; every host speaks through `notify: Notify`
(`ok` / `warn` / `error`), the kind chosen where the message is written.

| | |
| --- | --- |
| toasts | `#toasts`, the viewport's bottom right, newest at the bottom, at most `MAX_TOASTS` 4 (the oldest non-error goes first). `TOAST_MS`: `ok` 2.5 s, `warn` 5 s, `error` until closed (×). A click dismisses one. The same message again, while it is up, counts (`×2`) and keeps it up |
| the log | `toggleLog(bell)`: a popover of every message, newest first, with its time and its count (`logNotice`, pure; `LOG_SIZE` 200); Clear. Opening it zeroes `unseen` — errors said since, the bell's red count |
| the banner | `setProblem(slot, text)`, `''` to clear: `main` (`main.ts`'s `setProblem`: assets, identity, the server's copy) and `push` (`not on GitHub yet: …`). `#banner` sits **above** `#stage` rather than over it, so it never covers the gizmo drawn in the canvas's corner; a `ResizeObserver` on the canvas runs `relayout` as it comes and goes |
| the hint | `#vhint`, top centre, the first that applies: a play session's (`PlayHost.hint`), following's (`Following X · move the camera to stop`) |
| the readout | `#readout`, beside the pointer during a gesture |
| `renderStatus` | redraws the top bar (undo / redo from `edits.labels()` + `depth()`, the bell), the people, the follow frame, the hint, and the Hierarchy's count (`#hier-count`) |

Where the status bar's items went: the level's name was already the top bar's; the selection is the Inspector's and the
Hierarchy's; the undo depth is the buttons' tooltips (`Undo move (2 more)`); the room and your own name are the people's
icons; the clipboard count is not shown.

## Who is in the room, Focus and Follow (ADR 0155, ADR 0184, `src/people.ts`, `src/follow.ts`)

`createPeople(toolbar.people, state, { focus, follow })` fills `.tb-people`, the top bar's last slot.

| | |
| --- | --- |
| icons | `.pp` per connection in the room, in the order they came (two tabs are two icons: two holders, two colours), filled with `peerCss(connId)`, `initials(name)` (two letters at most). Yours last, `.pp.me`, not a button: the colour the others see you in, and `.pp-dot` for `room.connection()` — green live, amber connecting, red lost. Rebuilt only when the people, the connection or the follow changed |
| card | click an icon: a popover (`.pop-person`) with the name, `selectedText(heldLabels(connId))` (`Selected: A, B and 2 more`, asked only on opening), **Focus** (disabled when nothing is held) and **Follow** / **Stop following**. It closes when its person leaves |
| Focus | `focusPeer`: their holds → `indexOfRef` → `nodes.frame(indices)` (the F key's framing, any nodes) → `hierarchy.reveal` each, the first scrolled into view |
| Follow | `follow.start(connId)` → presence `{ kind: 'follow', leader }`, and their holds are to be taken; stop → `leader: null`. While following: `#stage.following` draws a 2 px frame in their colour (`--follow`), the hint names them, their icon rings (`.pp.on`) |
| following | each frame, before `controls.update()`: `view.setPose(approach(view.pose(), goal, 1 − e^(−dt·FOLLOW_RATE 12)))` — 5 Hz arriving as a glide. `setPose` takes their projection quietly, their target, their position (orthographic: `zoom` 1, the frustum cut to their half-height). **Selection** (ADR 0184): when the follow starts and whenever the room's holds change (`LiveHost.holdsChanged`), the next frame not `busy` (a gizmo, point or field drag) runs `selectLike(leader)` — `room.holdsOf(leader)` (the room's list as sent, so in the order they took them: their primary is yours) → `indexOfRef` → `applySelection`, or `deselect` for none, clearing an asset, the sun or the level shown; nothing when it already is. **Motion**: a `motion` from the leader → `setMotion(ms)` — stopped (`null`) stops the preview, else runs it and `setTime(ms)`; passed on to this tab's own followers |
| what ends it | **any move of your own**, Kodjo's call: an orbit or pan dragged past 4 px (`controls` `start`, pointer from a captured `pointerdown`; a click to select is not one), the wheel, the view gizmo, the Persp / Iso button, framing (F, the menus, Focus: `NodeActionsHost.cameraMoved`); **a selection of your own** (ADR 0184) — `select`, `selectWith`, `selectAsset`, `deselectOwn` (a click on nothing, Escape, the sun's or the level's row), Select all: the inputs, never a restore after a rebuild (`applySelection` / `deselect`) nor `selectLike`; your own **Motion** press (`setPreviewing`); play starting, the leader leaving the room (`prune`), leaving the room (`reset`) |
| leading | a `follow` naming this tab adds its sender to `followers` and sends the camera at once; while any follow, every `FOLLOW_SEND_MS` 200 the pose is rounded to the millimetre and sent when it moved (`posesDiffer`), and not while playing. A follower leaving the room, or unfollowing, is dropped; none left, the timer stops. The Motion preview (ADR 0184): `{ kind: 'motion', ms }` — the clock running, `null` stopped — on every own press (`motionChanged`) and to a new follower; not while playing |
| reconnect | a new `connId` (`presenceChanged`) re-sends the follow (`announce`): the leader drops the old one when it leaves |

```ts
interface CameraPresence { kind: 'camera'; position: Vec3; target: Vec3; ortho: number | null }   // ortho: half-height shown
interface FollowPresence { kind: 'follow'; leader: string | null }
interface MotionPresence { kind: 'motion'; ms: number | null }   // ADR 0184: the clock while it runs, null stopped
parseCameraPresence(data: unknown): CameraPresence | null   // collab.ts, peers' data, validated
parseFollowPresence(data: unknown): FollowPresence | null
parseMotionPresence(data: unknown): MotionPresence | null   // ms finite and ≥ 0, or null
```

The server relays all three as it does a drag's poses (`live.presence`: everyone but the sender, kept nowhere); nothing
server-side changed. Nobody following, nothing is sent.


| Symbol | Role |
| --- | --- |
| `activeMode` | the opened level's **folder** — its name is qualified `<game>/<name>` (ADR 0108), so the game is known before the file is read (fallback `soleMode()`) |
| `gameData` | per game, `content/<game>/game.json` (`parseGameData`), read by `loadGame` in `reloadAssets` with where the copy stands (`gameOrigins`), then kept live by `gameSync` (*Live assets* below) |
| `registryFor(mode)` | `mode.registry`'s own and built-in types + the shared types `gameData[mode.name].components` lists now: a shared type the code has but the list dropped is left out, one the list added is appended (`sharedComponents`). `mode.registry` untouched until the data arrives |
| `registry()` | `registryFor(activeMode)`, or `DEFAULT_REGISTRY` with no game |
| `adoptable()` | `SHARED_COMPONENT_TYPES` the game lacks (`Boss`, `Bumper`, `Hazard`, `Sequence`) |
| `adopt(types)` | shared ∧ new → `gameSync.edit(gameDocId(game), [set components])` → `gameShown` → `reopenWithRegistry()` |
| `gameShown(game, before)` | after any change to a game's copy — this tab's, anyone's, an undo: the list changed → `reopenWithRegistry()` (the game you are in) and the games window redrawn; the settings → `meshes.buildAll()` for a `surfaceGrid` game (the key pitch, ADR 0120) and `gamesWindow.settingsChanged(game)` |

Adoption points (ADR 0077):
1. **Open** (`openFile`): `componentTypesInRaw(raw)` unknown-but-shared → adopted before `validateLevel`; any other unknown type is a load error.
2. **Place** (`whenPlaceable`, on a drop): `missingIn(assetId)` splits a prefab's unknown types into `shared`/`foreign`; shared adopted before placing — not while a prefab is open on top (a prefab belongs to no game).
3. **Add Component** (Inspector button, Hierarchy submenu): `adoptable()` listed beside addable types; pick → `adopt` → `doc.addComponent`.

Removal (ADR 0175): `removeShared(game, type)`, from the games window. `refreshFileList()` first (the server's `FileEntry.components` counts live rooms), then `componentUse(type, game, levelEntries, prefabs)` (`componentUse.ts`): the game's levels using it (with their placed prefabs), its own prefabs using it (`libraryOf(path) === game`, from `assets.prefabOf`), and its levels the server could not read. `removalRefusal` → `notify.warn` with where (three names, then "and N more"); nothing → `gameSync.edit(set components, list − type)` → `gameShown`. No undo entry, as adoption has none: adding one again adopts it.

There is no unassigned level: a `.level.json` outside a game's `levels/` is not listed at all (ADR 0108).

## Other people's asset changes (ADR 0156, `src/assetWatch.ts`)

The editor follows the server's change feed (`GET /api/changes`, the mirror's) from the `seq` its asset list was
read at, so another person's upload, rename, move, delete or material edit reaches this tab within a poll.

| | |
| --- | --- |
| the watch | `watchAssets({ seq, changed, lost })`, started after boot: `since=seq&timeout=25000`; `assetPathsOf` keeps paths in any library, from `content/` (a sidecar as its asset) and `changed` is awaited before the next poll. **410** → `lost`: wait out a drag or play, `reloadAssets`, redraw. Errors back off 2 s → 30 s |
| gathering | `assetsChanged` adds to `waitingPaths` and drains them one batch at a time through `inAssetQueue` — the one queue `reloadAssets` runs in too, so two runtimes are never installed over each other |
| applying | `loadAssetLibrary({ reuse, refetch })`: the list, plus only the named material and prefab files — the rest kept from the library held. `libraryChanges(before, after, named)` (pure) → `{ list, ids }`; nothing → nothing. Waits while `busyEditing()` (a gizmo, point or field drag, or play). Then `refreshCompiled(ids)` (ADR 0157, below), and `meshes.buildAll()` only when it says so; a list-only change only swaps `assets`. Then previews, the asset Inspector when its asset changed or went, `refreshUi` |
| the runtime | built over `libraryView`, an `AssetDatabase` whose `entries` / `byId` read the installed library at each lookup — so an asset added, renamed or moved loads with no new runtime |

Levels on the feed are not the watch's: one open here is live already, and one that is not is read fresh.

## What an asset change recompiles (ADR 0157)

`refreshCompiled(ids)` in `main.ts` — the one path for a local material edit, `reloadAssets` and the watch:

| Kind | What |
| --- | --- |
| texture | `runtime.refreshTexture(id)`: fetched again (`?v=`, past the browser's and Cloudflare's caches), then every loaded material using it recompiled in place — each holds its own clone |
| material | `runtime.refreshMaterial(id)`: recompiled into the object meshes hold. `false` = the shader changed class → rebuild |
| model | `runtime.refreshModel(id)` → rebuild: its placed clones are the old one |
| fade copies | `meshes.followMaterial(m)` for every material recompiled: a fadeable node's copies record their original (`from`) and take its values, keeping the preview's opacity |

`reloadAssets({ named?, fresh? })` reads the list, then `libraryChanges(before, after, named)` says what to refresh;
`named` is an upload's paths (same id, new bytes), `fresh` starts the runtime over (boot, the feed's 410). The
runtime is built over `libraryView`, so a new, renamed or moved asset needs none of this.

## The asset Inspector (ADR 0165, `src/assetInspector.ts`)

`show(id)` draws, top to bottom:

| Part | |
| --- | --- |
| `.a-pic` | a texture: its file (`load` → the *Size* fact); a sound: `<audio controls autoplay>` (`loadedmetadata` → *Length*); a font: a sample (`FontFace`); else `ASSET_ICON` under `host.picture(kind, id)` = `previews.request(kind, id, done, 'big')`, 256 px, one cache with the tiles' (`PictureSize`), drawn again by `pictureChanged(id)` after `thumbnailsSoon` |
| `.a-head` | name, `.a-openers`, meta `kind · named(path) · id` |
| `.a-facts` | `fieldRow`s, wrapping: *Size* / *Length* (from the picture, placed first), prefab *Parts* and *Components* (`prefabFacts(root)`: every node, each type with its count, most first; `componentLabel` = the registry's label), model *Triangles* and *Meshes* (`modelFacts`: `runtime.load` if not loaded, then the clone's geometry), then *File* (`shownBytes`) and *Changed* (`AssetLibrary.fileOf(path)`, the server's `files`) |
| material | the fields below |
| data | `showData` (ADR 0181): `host.dataTypeOf(path, type)` — the declaring game's type — and a `fieldRow` per declared field, at its value or default, by `dataField(spec)`: number `scrubFieldOf`, bool `checkField`, string `textField`, colour `colorFieldOf`, enum `selectField`, vec3 three scrubs, list `listField`, asset a `refField` over that kind (a data field: that type) the library may use; scene-only kinds named *not used in a data asset*. Each edit is the whole asset → `onDataChanged` → `diffAssetOps` on its live document and one undo entry per drag, as a material's. `refresh` sets each field in place; a type the game does not declare is said so. The meta line names the type; no picture, its kind's icon |
| `.a-users` | *Used by*: `fetchUsers(id)` (`GET /api/assets/users`) each time it is shown — `…`, then a `.a-use` per level (`level` icon, `levelLabel` `Game › name`, a click `openFile`) and per asset (`ASSET_ICON`, name, a click `selectAsset` + `project.reveal(path)`); *Nothing uses it.*; *The server could not say.* |

**The asset Inspector's fields** are the object Inspector's (`controls.ts`, on `fieldRow` lines, `--lw` on
`#asset-inspector`): shader `selectField`, texture a reference field (`refField`, ADR 0176; a texture tile dropped on
it, refused by `assetRefusal(db, 'texture', id, user)`) with an `.a-thumb` beside it, colour
`colorFieldOf`, number `scrubFieldOf` (`numberScrub(param)`), vec2 two of them (`X` / `Y`, step 0.1), boolean
`checkField`. Each field's `update` shows someone else's value through the handle's `set`, which skips a field being
dragged, picked or typed in. A drag is `dragged(change, settle)`: each `move` is an `ongoing` edit, the commit the
value it let go on, and `live.end` → `settle` = `onMaterialChanged(id, now(), label, false)` — no ops, it only ends
the undo entry, so letting go where it started puts back nothing someone else has changed since.

**Editing a material** (`onMaterialChanged(id, material, label, ongoing)`): `assetSync.edit(id, diffAssetOps(shown,
edited))` (*Live assets* below) and `edits.recordAsset` (*Undo* above); `show` puts the result in the library,
`refreshCompiled([id])` shows it on the next frame, the asset Inspector is redrawn only for a new shader (its fields
read `materialOf` at each edit; a vec2 keeps its own latest), a texture pick updates its thumbnail itself, and
`thumbnailsSoon()` refreshes the Project panel's pictures 400 ms after the edits stop.

## Live assets (ADR 0159, `src/assetSync.ts`)

A JSON asset of a live kind (`LIVE_ASSET_KINDS`, `content.md`: `material`) is a document on the server, edited by
path ops, with no lock; so is a game's data file (ADR 0162), by id `gameDocId(game)` = `game:<game>`. Two
`createAssetSync(host)`: `assetSync` over the library's materials, `gameSync` over `gameData` (fetch `loadGame`,
post `/api/live/game/<game>/ops`); an `asset` event goes to the one its id belongs to (`gameOfDocId`). Each keeps,
per document it has seen an edit to:

| | |
| --- | --- |
| `base` at `origin` | what the server has confirmed: its `epoch` (the server process) and `seq` (edits in it; 0 = the file). The library's copy says where it came from (`AssetLibrary.originOf`, off the GET's `x-asset-epoch` / `x-asset-seq`) |
| `inflight` | this tab's one batch on its way (`POST /api/live/asset/<id>/ops` with `room.connId()`); batch ids carry a per-tab prefix, so its echo is known on any connection |
| `pending` | edits made meanwhile, merged by path (`mergeAssetOps`, newest value; a path replaced drops the narrower ones under it) — the next batch when the echo comes |

What shows is `base` + `inflight` + `pending` (`host.show`, into the library, the renderer, and `assetInspector.refresh`
for someone else's). An `asset` event (every room's stream, `collab.ts` → `liveSession` → `onEvent`, checked by
`parseAssetEvent`): `seq` ≤ `origin.seq` — in the copy; the next one — onto `base` (mine: `inflight` confirmed, the
next goes); another epoch or a gap — `fetchLive` and start from the live copy. A refused batch comes off the screen
with an error toast. `reloaded()` after any library load: a newer copy becomes `base`, and this tab's unconfirmed
edits go back on top.

`assetInspector.refresh(id)`: every field's `update` shows the new value, skipping the control in use (`busy`); a new
shader redraws the panel.

**Who has it open** (ADR 0159), any asset kind: `room.syncHolds()` also sends `host.openAssetIds()` (`selectedAsset`,
or nothing) through `collab.setOpenAssets` — `POST …/assets`, queued one behind another like holds, skipped when
unchanged (`lastOpenKey`, reset on every connection going `live`, which re-sends it). The `open-assets` event carries
everyone's, in every document; `[]` on each snapshot and on leaving. `room.openersOf(id)`: the others, one per
connection, never this tab's (`mineEver`). The asset Inspector's header draws them as `.a-openers .pp` icons
(initials, `--pc` = `peerCss`, title `<name> has this open`); `assetInspector.openersChanged()` redraws only them.
The sites that set `selectedAsset` without `deselect` call `room.syncHolds()` themselves.

**Who is in which field** (ADR 0160, `src/fieldPresence.ts`), both Inspectors:

```ts
spotOf(target, within): Spot | null   // the line: nearest [data-field] (fieldRow's label), its nearest [data-card]
createFieldPresence(container, { report(spot | null), rings(): Ring[] }): { repaint }
```

In a line: focus in it, or a pointer pressed on it; `report` at once going in, 150 ms late going out. `repaint`
rings each `Ring`'s line (`.irow.peer-in`, `--peer`, title *X is in this field*) and runs on its own after any
rebuild (a `MutationObserver`), dropping a focus the rebuild took away. Cards: `addSection(key, { card })` sets
`data-card` — `<type>#<ordinal>` for a component, the key otherwise (`@transform`, `@net-bounds`, `@env-…`);
`#asset-inspector` is `asset`. main: `objectFields` over `#inspector` (targets: `@level` / `@env` or the selection's
refs, each `room.docTarget(suffix)` = `<kind>:<doc>|<suffix>`; rings for the primary) and `assetFields` over
`#asset-inspector` (`asset:<id>`); one spot for the tab, the asset one first (`tellField`). `room.setField(spot)` →
`collab.setField` (`POST …/field`, in order, re-sent on each new connection); `fields` event → `room.fieldsOn(target)`
(the others, never this tab's) → `fieldsChanged` repaints both. `collab.ts`'s ordered messages share `inOrder()`.

## Refusing another game's private components (ADR 0076)

- `unknownComponentTypes(root, registry)` (`src/editorDoc.ts`), pure.
- `unplaceableWhy(assetId)` non-null for `foreign` types, **or an asset the document may not use** (ADR 0161: `mayUse(editingFor(), path)` — `editingFor` is the open prefab's library, `null` for Shared's, else the level's game) → Project tile greyed, reason in tooltip (`unplaceableWhy` host option, `src/projectPanel.ts`); dragged over the viewport, the reason beside the pointer and no drop (`dragPlace.ts`).
- `Doc.placePrefab` returns `-1` on any remaining unknown type — second gate.

## Game settings (ADR 0087, ADR 0162)

The games window's **Settings** tab, for the picked game: a `fieldRow` with a `scrubFieldOf` per number setting
(`numberScrub(decl)`, `.gw-settings`, its own `--lw`), and a graph per curve setting (`src/curveEditor.ts`, ADR 0088,
600 × 220: drag, click to add, double-click/Delete to remove, fields for the selected point, `default`; wheel zooms
around the cursor (X over the bottom axis, Y over the left, both over the plot), right-/Shift-drag pans, `fit`/F
reframes, `⤢` opens it large over the window — `overlayParent: .gw-scrim`, Escape shuts only it; log axis when
`logY`; readout of the value under the pointer and the last segment's ratio). The graph keeps **no history of its
own**: each change is one `onChange`, and Ctrl+Z in it goes on to the one history. Hints are `.gw-note` lines.

`host.settings(game)` → `{ decls, values }`, values = `readSettings(decls, gameData[game].settings)`. A change →
`host.onSettingChanged(game, key, number | CurvePoint[], ongoing)` → `changeGameSetting`: `diffAssetOps(old, new,
['settings', key])` → `gameSync.edit` (shown at once, `gameShown`) and `edits.recordAsset` (label `<Game> <setting>`).
A number drags live: each step `ongoing`, `live.end` the value it let go on, not ongoing — no ops, the entry ends.
Anyone's change, and an undo, reach the fields through `settingsChanged(game)` → each field's `set` (skips one
being dragged or typed in) or the graph's `set`.

## Shapes are built-in meshes (ADR 0090)

A Mesh Renderer (`Renderer`, ADR 0153) whose `model` names a `builtin:` id draws a unit shape sized by the node's **scale** (`content.md`), and that node's
colliders are held at the matching unit shape — so scale is the one size a person reads and edits.

| Piece | Behaviour |
| --- | --- |
| picker | `assetOptions('model')` lists `BUILTIN_LABELS` first, then the uploaded models: a built-in is picked like a file. Every `assetOptions(of)` lists only what `mayUse(editingFor(), path)` allows (ADR 0161), and a material's texture slot only what its own library may use |
| locked collider | `Doc.setParams` of a built-in `model` on a `Renderer` rewrites every `Collider` on the node to `unitColliderFor(model)` **in the same batch** (one undo); `addComponent(Collider)` on such a node is born unit; `Doc.builtinOf(i)` says which built-in, or `null` |
| Inspector | with `builtinOf` non-null the `collider` field is one row — `unit box · size is the object's scale` — instead of the kind picker and the dimensions |
| Create | `createMenu` (blank space, Hierarchy *Create child*, viewport *Create here*) offers Box, Rounded box, Platform, Wall, Sphere, Capsule (`PRIMITIVE_ORDER`) then `Empty`; each is `Doc.placePrimitive(kind, position, parent)` = unit collider + an unsurfaced `Renderer` whose `model` is the built-in + the preset scale. In a prefab's room the same menu applies (`placeNamed` is the by-name variant its palette used) |
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
depth-first list puts a parent before its children. `nodes()` is called once instead of `4n` times; any other
pass that asks about many objects runs in `Doc.reading`, which holds the walk for the pass (ADR 0167). `poseOf(i, t, opts)` is `posesAt(t, opts)[i]`, so there is one
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

## Play — `src/play.ts` (ADR 0086, ADR 0172)

`createPlay(host)` → `Play { active, start, stop }`. It owns the frame and a `starting` flag; `PlayHost`, all getters,
brings the rest.

**A level plays in the real game, and only there.** `start` → `host.gamePageUrl()` (`me.games[activeMode.name]`,
from `/api/me`): live level → `host.flush()`; then an
`<iframe id="game-frame">` over `#centre` at `${url}?level=${host.levelName()}` (bare, ADR 0108), orbit off, the
hint. Stop (toolbar, or Esc in the editor) removes the frame; Esc inside the frame is the game's pause. Hosted: `url`
is the proxied `/play/<game>/`; dev: `http://localhost:<port>/` with `pnpm dev:<game>` running. No page — a prefab, a
level whose game is not in the editor, a game the server has no page for — is refused with `host.noPageReason()`
as an error toast.

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
shared geometry and material. A readout beside the pointer (`host.readout`, `#readout`) carries the grabbed box's size plus `+N`; it goes when the pull ends.
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
| the control | the eye at the **right end** of a Hierarchy row, before the count (ADR 0150; it was an 18 px gutter on the left that pushed every row right). Drawn on hover, always once hidden — the condition ADR 0102 set for a control living here — and its place kept either way, so the count never moves. A hidden row does **not** dim: dimming already means switched off |
| alt-click | that node alone; a plain click takes the subtree |
| **Reveal** | the viewport's eye toggle, top right (ADR 0149), showing everything without forgetting it; hidden while nothing is hidden. Local and momentary, never sent |
| shared and durable | `POST .../hidden` → the server's `stateDir/hidden.json`, relayed live as the `hidden` event and carried on the `snapshot` (`editor-server.md`). The whole set every time, never a delta |

## Snapping (ADR 0114)

One increment **per tool**, in `edit.steps`; the viewport's snap field (a `scrubField`, beside the magnet) shows
the active tool's with its unit and its own bounds, so it stays one field.

| Tool | Default | Range | Unit | Snapped by |
| --- | --- | --- | --- | --- |
| Move | 0.5 | 0.05–10 | m | **us** — `snapTranslation`, the **centre**, axes dragged only (ADR 0179) |
| Rotate | 15 | 1–90 | ° | **us** — `snapRotation` on `objectChange` |
| Scale | 0.1 | 0.05–5 | × | `TransformControls.setScaleSnap` (absolute) |
| Face | 0.5 | 0.05–10 | m | **us** — `snappedPull`, on the face's plane (ADR 0119) |

**Translation snaps as Unity's does** (ADR 0179), `snapMove(now, start, step, rotation?)` (`src/snap.ts`) on the
primary's world position against where the drag started (`DragStart.world`, `.turn`). World handles — Unity's grid
snap: each axis the drag moved puts the **position** (the centre) on the grid, and an axis it did not move stays
exactly where it was, on the grid or not (under `1e-9` of change is not a move). Local handles — Unity's increment
snap: whole steps along each handle axis from the start, since a world grid cannot be followed along a tilted axis.
Converted back through the parent; the others get the primary's delta (`mirrorDragToSelection`). Placing a new
object snaps the click point, so its centre lands on the grid too. A sequence point's copy snaps the same way.
The grid is the **world's**, as Unity's: an object inside a group that sits off the grid lands on the world's lines,
and the Inspector, relative to the parent, then shows the group's offset (ADR 0180).

**Align to Grid** (`alignToGrid`, `gizmoTool.ts`, ADR 0180) — Unity's, Ctrl+\ (`'mod+\\'`) and *Align to grid* in
the object's right-click menu: every selected object's world position onto the move step's grid, all three axes,
snapping on or off; parents first (ascending index), each converted back through its parent and written with
`writeBackItem`; one history entry (`beginDrag` … `endDrag('align to grid')`); nothing off the grid says *already on
the 0.5 m grid*. A group off the grid, aligned once, puts its children's grid back on round numbers.

Rotation is ours because three snaps `rotationAngle`, the distance dragged, so a round amount is added to
wherever you already were and round angles are unreachable. `snapAnglesDeg` (`src/snap.ts`, pure and tested)
rounds each Euler axis onto an absolute grid instead. Applied to the **primary only**, before the write-back
and before `mirrorDragToSelection`, so the others get the snapped delta and a group keeps its relative angles
— the same shape as translation. The placement grid uses the same `snapToGrid`.

**A written rotation is rounded in degrees**, not radians: `roundAngle` (`src/snap.ts`) keeps four places of
a degree and stores the radians unrounded, so a typed 90 reads back 90 (ADR 0136). Positions and scales keep
`r4`.

## Inspector — the panel (ADR 0152, `src/inspector.ts`)

Every field is ours (`src/controls.ts`), the asset Inspector's too; nothing of Tweakpane's is left in the editor.
A line is `fieldRow(label, ...controls)` (`controls.ts`), which a card's `field` appends.

| | |
| --- | --- |
| head | active tick (ADR 0102) and the name; the **prefab bar** on a placement or a piece — icon, the prefab's name (`host.prefabName(id)`) or `part of <prefab>`, `×N` (`Doc.refCount`), **Open** (a ref only), **Overrides ▾** with the count: on a placement `Revert all` / `Apply all` / `Unlink from prefab` over everything inside it (`placementOverrides` + `placementAdded` + `placementRemoved`), on a piece `Revert all` / `Apply` over its own (`overridesOf`); greyed with `matches the prefab` when there is nothing. A plain object has no bar. `N selected · editing what they share` under it |
| cards | `.isec`, one per component, Transform first: twist, enable, `componentIcon(type)` (a game's own components share `component`), name, badge (`added` or the override count), a sequence's tools, ⋯. A click on the header's empty part opens or shuts it; shut state per component id survives rebuilds. A component with no visible parameter is `.isec-bare`: its header alone. The Transform is `.isec-fixed`: always open, no twist, never moved. **Reorder** (`cardDrag.ts`): a `.movable` card — an own component, one object selected, where Move up / Move down are offered — is dragged by its header; after 4 px a copy follows the pointer, a placeholder opens at `slotFor(y, middles)` (pure: before the first other card whose middle is below), the cards slide, the panel scrolls at its edge, Escape cancels; the drop is `Doc.moveComponent(i, id, to − from)`, one op. **Link** (ADR 0177): any component's card, one object selected — a prefab's too — dragged by its header onto a reference field (`outside` → `refFieldAt`) is a dragged Unity component header: while over the field the card goes back to its place, a `.hier-ghost` chip (its icon, `<object> (<type>)`) follows instead of the copy, the field lights or greys, and the drop is `take({ kind: 'component', index, component })`, nothing moved. `cardJustDragged()` keeps the drop from toggling the card. Then **Add Component** (`.iadd`). No footer |
| the card's menu | ⋯, or a **right-click on the header** where the pointer is (Unity's, ADR 0191): Reset to defaults or Revert to prefab, Move up / down, Remove, then **Copy Component**, **Paste Component As New**, **Paste Component Values** (`componentClipboard.ts`). The copy — `{ type, label, params (defaults filled in), enabled }`, or the Transform's three lines — is the Inspector's own `clip`, in this tab only (Kodjo's call): it survives rebuilds, selections, levels and prefabs, and a copy rebuilds the panel so every menu offers it. Values: the same type only (`valuesRefusal`), onto each selected one's matching component, one edit; a Sequence's stages by `setSequenceStages`. As New: onto each selected object that `canAdd` it, its on/off kept; greyed with why for a type this game has not got or a singleton already there. Either refused, with the field named, when a copied asset is one this document may not use (`assetsRefusal` → `host.assetRefusal`, the dropped asset's rule). Object references go as they are. The Transform card: Copy, Paste As New, Paste Values → `host.pasteTransform` (every selected object, one edit) |
| lines | `.irow`: a label in `--lw` = `clamp(72px, 40% - 24px, 280px)` of the line, then the controls; `.over` bars an overridden one, `.mixed` italicises one the selection disagrees about; `.inote` for a line of explanation |
| fields | `scrubFieldOf` (numbers; `numberScrub(decl)` says how they drag), `checkField`, `selectField`, `textField` — or `textArea` for a `multiline` string (ADR 0189: Enter a new line, leaving it or Escape commits) —, `colorField` (the browser's picker and the `#rrggbb`), `refField` for what points at something (*Inspector — reference fields*), `listField` (`listField.ts`, ADR 0182) for a `list`: a header naming the row's fields, a row each — grip (drag to reorder, `slotFor`), its fields side by side (number, bool, string, colour — an optional one with an *auto* box — and enum; else `—`), ✕ — and *Add* (a row at the item's defaults); every edit writes the whole list, `set` redraws unless a field in it is focused or a row dragged. On a component a row's drag writes when it lets go; on a data asset each step is an `ongoing` edit. `null` is mixed: blank, and a number is then typed only. Environment and network bounds use the same fields, as do the games window's settings |
| a drag | `Live` on the field: `liveWrite` opens `host.beginDrag()` when the press becomes a drag, writes on every move, and `host.endDrag(label)` when it lets go — one history entry, one message to the room, the viewport following the pointer. `main.ts` counts it in `gizmoDragging`, so a remote repaint waits, and drains it at the end. Written as they settle instead: the network bound, and a multi-selection's transform (`writeAxis` is its own entry). A rebuild mid-drag closes the entry |
| sync | the gizmo moved the selection: `sync` sets the transform's nine fields (`ScrubHandle.set`), skipping one being dragged or typed in; nothing is rebuilt |
| refresh | an edit from elsewhere to the object shown (ADR 0168): `shapeNow()` — JSON of the object, its selection, kind, prefab, built-in, overrides, and per card id, type, switch, added, inherited, overridden, the lines shown, the values of lines not followed (enum, collider kind, stages), a sequence's params and override, several selected's params — against `drawnShape` (set in `build`; `null` for none, the level's and the environment's panels). Equal: `renderHead`, `sync`, then each `followers` entry (pushed by `addParam`, one object only) shows the value now — `ScrubHandle.set` / `ColorHandle.set` (they skip a field in use), a text only when not focused, a tick always; a vector's and a collider's own copies follow too. Else `rebuildKeepingScroll` |

## Inspector — reference fields (ADR 0176, ADR 0177, `src/refField.ts`)

An `asset` parameter, a `nodeRef`, a `componentRef` and a material's texture slot are one control, `refField(o)` →
`{ root, set(shown) }`: Unity's object field, no dropdown.

| | |
| --- | --- |
| name | `.rf-name`: the icon and name it points at (`RefShown`) — an object's label, an asset's name, a component's `<object> (<type>)` with its ordinal where the object has several (`zone (Collider 2)`); `None (<Kind>)`; `—` for a selection that differs; `missing …` (`.rf-missing`) for a reference that resolves to nothing. A press **pings**: `host.pingNode(j)` (the Hierarchy's `ping`) or `host.revealAsset(id)` (`project.reveal(path)`), the selection untouched. A double-click **opens**: `host.selectNode(j)` (`select`) or `host.openAsset(id)` / the asset Inspector's `onSelectAsset` (`selectAsset` + reveal). Neither for a built-in shape |
| clear | Delete or Backspace on the focused field: `pick(null)` — `''` for an asset, `null` for a reference. `preventDefault` + `stopPropagation`, so the editor's Delete (delete the selection) never hears it. No ✕ |
| picker | `.rf-pick` → `openPopover(…, 'pop-ref')` with a `treePicker` (ADR 0178): *None*, then `choices()` as a tree, `current()` lit with the folders above it open. An object field: the Hierarchy's tree (`hierarchyTree(doc, offer)`, by index — a branch with nothing pickable in it left out), what `refTo` reaches pickable. A component field: the same tree, an object in reach with one of the type the row itself (`zone (Collider)`), one with several listing them under it. An asset field: `host.assetFolders(of)` through `folderTree` — the folders as the Project window names them (`Keyboard › materials`), the built-in shapes in *Built-in* (ADR 0090), the game's own and Shared's (ADR 0161); a texture slot the same from `host.named` |
| drop, a tile | the browser's drag: `dragover` reads `draggedAssets()` (the Project window's `onDragAssets`) and takes the **first** of several; `refuse`, then `preventDefault` only when it fits (`dropEffect` `move` for a `move`-only tile, else `copy`); `drop` → `take` |
| drop, a row or a card | the Hierarchy's drag and a card's header drag are pointer events: they ask `refFieldAt(x, y)` (`elementFromPoint` → `.rf` → the field's `RefTarget`) — `offer(drag)`, `leave()`, `take(drag)`. `RefDrag` = `{ kind: 'node', index }` \| `{ kind: 'component', index, component }` \| `{ kind: 'asset', id }` |
| what each takes | asset field: a tile (`assetRefusal(db, of, id, user)`, `assetRefusal.ts` — *not in the project*, *this takes a material, not a texture*, *X belongs to another game*, *X is a game's own, and this is Shared*). Object field: a row, or a card — its object, as Unity's does. Component field: a card of its type, itself (*this takes a Collider, not a Boss*), or a row — its **first** component of the type (*bare has no Collider*), as Unity's `GetComponent`. Out of reach (`Doc.refTo(at, index)` `null`): *a piece inside another prefab cannot be linked from here*. The wrong kind: *this takes an object, not an asset* and the like. Refusals show in place of the name (`.rf-no`); what fits lights `.rf-ok` |
| in place | `follow` → `set(shownFor(now()))` (`asset`, `nodeRef` and `componentRef` are in `shapeNow`'s followed kinds) — for an edit from elsewhere. This tab's own: an asset's write rebuilds the panel (`rebuildKeepingScroll`); a reference's `store(v)` writes, then `set(shownFor(now()))` — nothing else redraws it, so a pick or a drop showed *None* until a reload. Several selected: an asset shows `—` and writes all, a reference differing is the *differs* row |

A component field reads its value's old shape too — a bare node id, the node's first of the type — until the box's
content is migrated (`migrate-component-refs.sh`, `content.md`). `Doc.refTo(i, j)` and `Doc.refTarget(i, id)` share
`nodeChoices`' reach (`reaches(n, o)`: anything names the level's own nodes; a piece is named only from inside its
placement — its other pieces and the placement itself, whose root the loader resolves inside the placement first;
`scopeOf(n)`), by index — two placements of one prefab carry the same piece ids. `refTarget` looks in `scopeOf(n)`
first (a placement answers to its prefab root's id there too), then the level, as `LoadedLevel.findNode` does. `refKeys` (the re-id on duplicate and
paste) and `fileActions`' `nodeRefKeysOf` (unlink) follow both reference kinds (`retargetRef`).

## Numbers in the Inspector (ADR 0113)

A field's `step` is the **drag's**: a pixel is one step, landing on its multiples (`numberScrub`; a bounded
number with no step crosses its range in 200 px). What is typed is clamped to `min`–`max` and **never snapped**
(`scrubField`'s `typed`), so every value in range is reachable — Tweakpane's step snapped typing too, anchored to
the value the field was built with, which made 33 unreachable from 32.98 in steps of 0.05. Covered in
`inspectorPanel.test.ts`.

## Inspector — what the fields are built from (ADR 0101)

`boundState(defaults, params)` = `structuredClone({ ...defaults, ...params })`. Exported and pure so the
invariant has a test.

On an **inherited** component the params are the **prefab's own** objects (`bakeOverrides` returns them
untouched where no override changed them, ADR 0033). Tweakpane wrote *into* a bound object, so a shallow copy
let a drag on one placement edit the prefab in memory. The fields now write new values, and the panel updates
the copy as they do — a vec3's second axis dragged after its first starts from the first's new number — so it
still must not be the document's.

A `stages` parameter shows as one summary row, `N stages · M steps`, where it is not a `Sequence`'s.

## Inspector — a sequence (ADR 0143, ADR 0147)

A `Sequence`'s section is drawn by `sequenceEditor.ts` from its stages, in our own DOM and one look; every edit is a pure function in `sequenceEdit.ts` and one `Doc.setSequenceStages` (or
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

**Controls** (`controls.ts`): `numberScrub({ step?, min?, max? })` → the `ScrubSpec` a declaration implies.
`colorFieldOf` → `{ root, set }`; the swatch lets go of the focus when its picker closes, so Ctrl+Z reaches the
editor. `scrubField` — drag sideways to change (`scrubbed`: `perPixel`, landing on `grain`,
Shift ten times finer), click to type (Enter / blur commits, Escape reverts), **one commit when the drag or the
typing ends**; its `key` (`<component>:<step>:<field>`) lets the field clicked next take the focus back after the
first one's edit rebuilt the panel. `segmented`. One popover at a time (`openPopover` / `closePopover`), gone on a
press elsewhere, Escape, a resize or a scroll outside it; `onDismiss` only for the person's dismissal.
Icons: `icons.ts` (the editor's, shared with the viewport's overlays), SVG paths on a 24-unit grid, stroked in `currentColor`; curves: `easeCurve.ts`, drawn from
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
| a drag | `beginDrag` … `endDrag('move point')`; each `objectChange` snaps the copy as an object moves (`snapMove` from where the drag began, ADR 0179) and writes `to`, rounded to 4 places, when it changed, then rebuilds the Inspector. A remote repaint waits (`gizmoDragging` covers it), `afterDrag` = `rebuildLoaded` + `drainDeferred` |
| the route | one selected object: `Doc.routesAt(i)` — its own sequences' steps aimed at itself, then its parent's aimed at it, switched-off ones left out; a `Line` from its place through the points, a numbered `Sprite` per point, `DOT` of the viewport's height in either projection |
| where | `pointToWorld(to, axes, frame)` (`sequencePoints.ts`); `frame.rest` = the parent group's world matrix × the target's local pose — the group's own when Motion is stopped, `transformOf` while it runs |
| picking | the overlay group `sequence-points` sits outside `instanceRoot`, which is all a click raycasts |

`Doc.stepTargetOf(i, target)` is the node a step aims at: `i` for `SELF`, a direct child by id, else `null`.

## Inspector — several objects at once (ADR 0112)

With more than one selected the panel edits **what they have in common**.

| Piece | Behaviour |
| --- | --- |
| which components | the intersection, paired by **type and ordinal** (`peersOf`, pure and tested): the nth `Collider` with the nth `Collider`. Ids cannot pair them (minted per component) and type alone cannot (a node may carry two). A component only some of them have is **hidden** |
| a value they agree about | the field, showing it |
| a value they differ about | the same field **blank** (`value: null`), `—` placeholder, the line `.mixed`: a pre-filled one would be a claim about values it has not got. Untouched writes nothing; a mixed number is typed only. Per **axis** for vec3 and the transform — a vec3 axis is written over **each node's own** other axes (`setParamsAcross` with a patch per target), since a patch replaces the whole value. A collider shape, a node reference and stages say `differs across the selection` |
| a compound value | a collider shape is reported as differing, not offered blank |
| writing | `Doc.setParamsAcross(targets, patch)` — each node's ops concatenated into **one** commit, so one undo entry and one message to the room |
| redrawing | `onPropsChanged` → `meshes.rebuildSelected()` (every index in `ItemMeshHost.selection()`) — `meshes.buildAll()` when a selected node carries a component whose type `doc.drives` (ADR 0210) — and again for the same indices once newly named references load. It redrew the primary alone, so the rest kept their old look until a reload |
| transform | `host.selectionTransforms()` + `host.writeAxis(field, axis, value)`; three inputs per row, each writing its axis to every selected node. Also what fixed typing moving only the primary while a drag moved all |
| Reset / Remove / enable | every selected node; the menu labels carry the count |
| Add Component | anything **any** of them can take, added to each that can |

## Inspector — Add Component (`src/inspector.ts`)

`addComponentSection` per component. `Add Component` opens a `treePicker` in a popover (`pop-add`, ADR 0178) — Unity's Add Component: every folder open, a search listing matches flat with their folder in grey, Enter the first. It holds `doc.registry` types not on the node, by their label (`Mesh Renderer` for `Renderer`), plus `host.adoptable()` (definition from `sharedComponents`, hinted *adds to game*), grouped by `byMenuFolder(…, menuFolderOf(def, host.gameLabel()))` (`componentMenu.ts`): a component's declared `menu`, else its game's label; the built-in folders first in `MENU_FOLDERS` order (Physics, Rendering, Gameplay, Animation), then the rest by name. The Hierarchy's *Add component* submenu (`menus.ts`) groups the same way, a submenu per folder. Disabled when both are empty. With several selected it lists what **any** of them can take and adds it to each that can (ADR 0112). Adopted types go through `host.adopt(type)` then are added to the rebuilt document. Params default from `registry.defaults(type)`. Prefab placements: "push into shared prefab" → `Doc.applyOverrides` (host `applyToPrefab`).

## Level validation test (`src/levels.test.ts`)

Every `content/<game>/levels/*.level.json`: `validateLevel(raw, MODES[<folder>]?.registry ?? DEFAULT_REGISTRY)` must not throw — the folder is the game (ADR 0108), which a tag inside the file could contradict. Tripwires: some levels found, `MODES` non-empty. Lives here because only the editor can import every game's registry without inverting dependencies.
