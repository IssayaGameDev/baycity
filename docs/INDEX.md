# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **client-authoritative rooms on Colyseus (ADR 0011 + 0013), with a data-driven
content pipeline (ADR 0014).** Each client simulates its own entity and reports state; the
server (a Colyseus `Room`) relays peers, interpolated on a clock-synced timeline — no
`@colyseus/schema`. Product framing: an "extremely simplified Roblox" — a platform hosting a few
**modes** that share one stack. **Parkour** is the first mode (`modes/parkour`, `ParkourRoom`).

Content is **data** (`@mp/content`): prefabs/levels of authored collider primitives + a swappable
greybox visual layer, a loader (colliders + markers + physics-backed triggers + clock-driven
behaviors + a renderer-agnostic visual list). Geometry is **authored data only** — the code kit and its generators are deleted (ADR 0027). Rendered
by a polished shared pipeline (`@mp/render-three`: IBL, ACES, soft shadows, GTAO/SMAA/bloom).
Gameplay **triggers are a piece's own collider**, detected by real engine contact. Inspect it locally
with the **viewer** (`tools/viewer`, `pnpm dev:viewer`); author it in the **editor** (`tools/editor`,
`pnpm dev:editor`, ADR 0023), which is the content path. The parkour mode **loads a level by name** —
`?level=<file>` from `content/levels/`, no param → **`default.json`**, a placeholder level so the game
always boots, editable in the editor like any other file (ADR 0027). The name also filters matchmaking,
so a room only holds clients on one level. Server stays content-free.

Wire is delta + quantized snapshots (v10: position + a state-flags byte — grounded/rising for animation, dead for the ragdoll — plus facing, locomotion-speed and movement-base bytes, none derivable from a position curve; while the base is set the transform is in that platform's frame — ADR 0021); budgets 2 & 3 validated with bots. Colyseus pinned to
**0.16** (matched client/server); default `ws` transport (uWS is a later swap); scale-out infra
(Redis/multi-region) deferred to deploy. History: server-authoritative through M10 (ADR 0011
reversed it); ball demo retired (tag `m10`); world/controller relocated out of `@mp/server/tps`
(ADR 0014). **M9 (2D path)** remains deferred (SEED §7).

## Docs

- [workspace.md](workspace.md) — monorepo layout (packages/modes/tools), dependency laws, conventions, scripts, how to run.
- [netcode.md](netcode.md) — client authority, Colyseus rooms + relay, per-client snapshots, interpolation, clock sync, roster/names. Records the game-feel values.
- [physics.md](physics.md) — Rapier3d wrapper API (bodies, rotation, kinematic character controller + collisions), timestep, determinism stance.
- [obstacles.md](obstacles.md) — measured movement envelope (max gap vs rise, beam margin, slope/curve limits), the rules those numbers impose, and the obstacle vocabulary built so far.
- [protocol.md](protocol.md) — binary wire format v10 (snapshot / welcome / state / ping / pong / roster) over a Colyseus channel.
- [budgets.md](budgets.md) — the five budgets (SEED §5), how they're measured, latest load numbers.
- Content schema/loader are self-documenting via `@mp/content` types + ADR 0014/0026 (no prose doc).
- ADRs (`adr/`, append-only):
  - [0001](adr/0001-monorepo-tooling.md) tooling · [0002](adr/0002-transport-and-client-clock.md) transports · [0003](adr/0003-physics-and-renderer.md) physics+renderer
  - [0004](adr/0004-prediction-and-netsim.md) prediction+netsim · [0005](adr/0005-predicting-props.md) predicting props · [0006](adr/0006-clock-sync-and-lag-compensation.md) clock sync + lag comp
  - [0007](adr/0007-delta-and-quantization.md) delta + quantization · [0008](adr/0008-hud-and-input.md) HUD + input · [0009](adr/0009-load-validation.md) load validation
  - [0010](adr/0010-tps-character-controller.md) TPS controller + pluggable game · [0011](adr/0011-client-authoritative.md) **client-authoritative (reverses SEED §4)** · [0012](adr/0012-roblox-like-character-controller.md) Roblox-like kinematic controller
  - [0013](adr/0013-colyseus-rooms.md) **Colyseus rooms foundation** · [0014](adr/0014-content-pipeline.md) **data-driven content pipeline + modes layering**
  - [0015](adr/0015-ui-rendering.md) **PixiJS for all game UI** · [0016](adr/0016-localization.md) **localization (`@mp/i18n`)**
  - [0017](adr/0017-convex-colliders.md) **convex colliders for authored swept surfaces** (widens ADR 0014's primitive-only rule) · [0018](adr/0018-procedural-character-animation.md) **procedural animation on a rigid 11-part rig** (torso split at the waist; + protocol v8 state flags, v9 facing + speed)
  - [0019](adr/0019-death-ragdoll.md) **death is a local ragdoll; spawning assembles the body** (both kill paths; visual-only, nothing on the wire)
  - [0020](adr/0020-camera.md) **third-person camera**: wheel zoom, pitch to straight overhead, sphere-cast occlusion pulling the boom in
  - [0021](adr/0021-relative-to-base-replication.md) **a rider replicates in its platform's frame** (protocol v10; stops peers sliding on movers)
  - [0022](adr/0022-touch-controls.md) **touch controls**: stick bottom-left, jump bottom-right, look everywhere else; pointer ownership by zone
  - [0029](adr/0029-keyframe-tracks.md) **motion is a keyframe track, edited on a timeline** (`move`/`rotate` deleted to presets; `phaseMs` ends the lockstep; path handles in the viewport; no graph editor, deliberately)
  - [0028](adr/0028-materials-replace-styles.md) **`style` is deleted; a material asset is the one visual answer** (the greybox palette ships as 7 material assets; the override moved to `PrefabInstance.material`; a reference-integrity test)
  - [0027](adr/0027-content-is-data-only.md) **geometry is authored data**: the code kit + generators deleted, the gym with them, a `default.json` level file in their place
  - [0026](adr/0026-asset-pipeline.md) **assets referenced by id in a `.meta` sidecar; a material is a shader instance** (textures/models/materials/shaders/sounds/fonts; preload pass; generic material inspector)
  - [0025](adr/0025-nested-placement.md) **instances nest to any depth**; the loader composes a frame tree (compound motion; no wire change)
  - [0024](adr/0024-editor-ui-shell.md) **the editor's UI is a fixed-panel DOM shell** (CSS-grid layout, hand-rolled splitters, hierarchy panel; Tweakpane confined to the Inspector)
  - [0023](adr/0023-authoring-content.md) **content is authored in the in-browser editor** (prefab references + instance overrides; Unity retired to assets, its conversion facts preserved)

## Built

- `core` — math (incl. quaternion helpers), entity model, fixed-timestep loop, `createSimClock` (fixed-step content time, slewed to a reference clock), transport interface.
- `net` — binary codecs (v10): snapshot (delta + quantized), welcome, state, ping/pong, roster; quantization utils (position, facing, speed). `NET_CHANNEL` is the Colyseus channel they ride.
- `physics` — Rapier3d wrapper: dynamic/fixed/kinematic bodies (position + rotation, linear + angular velocity), **kinematic character controller** (contact reporting + a downward `probeGround`), a general **sphere cast** (`castSphere`, with self-exclusion and on-demand query-index refresh), **collision layers** (`CollisionLayers`, applied to the controller's own queries too), headless + browser.
- `character` — the stack-level kinematic character controller (`stepCharacter`, `CharacterTuning`; ADR 0012), mode-agnostic. Relocated out of `@mp/server/tps`. **Platform carry** (movement base): rides a moving piece by keeping its position in that surface's frame (`PlatformPoseLookup`), and a jump off a mover inherits its velocity. Paired with the loader's frozen posing — see `docs/physics.md`. Also the **blocky 11-part rig** (torso split at the waist) (`RIG`, proportions derived from the capsule) and its **procedural animator** (`createAnimator`): distance-driven stride, two-bone analytic IK, half-life smoothing. No skinning, no clips, no art; headless and unit-tested (ADR 0018).
- `content` — data-driven content: schema (prefab/level/collider/marker/behavior/visual; instances **nest** via `children` — ADR 0025), recursive validation, **prefab-reference resolution + the depth-first tree walk** (`resolvePrefab`/`instancesOf`/`freeTableId`/`walkInstances` — headless, shared by the loader and the editor; ADR 0023/0025), the **keyframe track evaluator** (`track.ts`, ADR 0029: `poseAt`/`trackTime`/`easeAt`/`trackDuration`, plus the `moveTrack`/`spinTrack` presets — pure, headless, 33 tests including a proof that the presets reproduce the deleted `move` behaviour term for term); the **loader** (`instantiateLevel`; `update(now, riddenCollider?)` poses the ridden piece without velocity and exposes `basePose` so riders can track it), `baseIndex`/`basePoseOf` expose clock-driven pieces as replicable movement bases (ADR 0021); and the **asset layer** (`assets.ts`, ADR 0026): kinds, `.meta` identity, `kindForPath`/`nameForPath`, the material schema (a shader name + tagged parameter values), and the visual-layer readers. A visual names a
  **material asset id** and nothing else — the `style` palette is gone (ADR 0028), and an unsurfaced primitive
  greyboxes. Headless, no rendering. ADR 0014.
- `server` — **Colyseus** `Server` (`startServer()`) hosting `ParkourRoom`: client-authoritative relay (per-client delta snapshots, no simulation, no schema), auto-join, roster/names, clock-sync ping/pong. Content-free.
- `client` — `colyseus.js` transport (`joinOrCreate`), interpolation, local authoritative controller (`localController`), clock sync, input abstraction (`.` headless + `./dom` adapters), and **touch controls** (`createTouchControls`: zone ownership by `pointerId`, re-centring stick, look/pinch/tap channels — headless and unit-tested; ADR 0022).
- `render-three` — WebGL2 stage (+ an explicit `resize()`, for a canvas sized by a panel layout rather than the window) + the polished greybox pipeline (IBL, ACES, soft shadows, GTAO/SMAA/bloom, level-view). `materials.ts` is down to `MARKER_COLORS`/`colorForMarker` (gizmo chrome) and `createGreyboxMaterial()` (the no-material surface) since ADR 0028; realizes `@mp/character`'s rig as nodes (`createCharacterRig`) and applies a `Pose`, or as loose unparented meshes for a ragdoll (`createLooseParts`); re-exports THREE + OrbitControls. **Shaders, assets + thumbnails** (ADR 0026): `shaders.ts` is a registry of shader definitions that each declare their own parameters and build a Three material (`standard` → `MeshStandardMaterial`, `unlit` → `MeshBasicMaterial`, `registerShader` for custom ones) plus `compileMaterial`; `assetRuntime.ts` is the **preload pass** (textures, glTF models, compiled materials, cached by id and cloned per use) that keeps `addLevel` synchronous; `thumbnails.ts` renders an asset preview offscreen (`fitDistance` is pure and tested).
- `render-pixi` — PixiJS 2D UI layer (ADR 0015): a transparent canvas stacked over Three, an overlay with pointer-lock-aware input, reusable widgets (panel/button/slider/list), and the **touch-control view** (`createTouchHud`, non-interactive by design — ADR 0022). Wired into the parkour pause screen.
- `i18n` — tiny dependency-free localization (ADR 0016): typed `t()`, 9 languages, browser-locale detect + runtime switch. Headless.
- `tools/netsim` — latency/jitter/loss transport wrapper. (Not wired into the current client — ADR 0013.)
- `tools/bots` — headless `colyseus.js` load clients + `load` harness; measures budgets 2 & 3 and doubles as the live integration check.
- `tools/viewer` — localhost content inspector (`pnpm dev:viewer`): picker, orbit, collider/marker/trigger overlays, jump-reachability gizmo, play-in-place. ADR 0014. Lists **level files** only — its per-piece catalogue went with the kit (ADR 0027).
- `tools/editor` — localhost level/prefab editor (`pnpm dev:editor`; ADR 0023 for what it authors, ADR 0024 for its UI). **Fixed-panel shell**: toolbar / Hierarchy | viewport | Inspector / Prefabs / status, one CSS grid with hand-rolled splitters (`splitter.ts`, ~40 lines, `clampSize` tested). `hierarchy.ts` is a real tree — rename in place (double-click), **drag to reorder or re-parent** (Unity's three-zone drop; cycles refused; world pose preserved), child instances shown by default and prefab pieces opened on demand (double-click a piece → open the shared definition with it selected); `rowsOf`/`zoneFor`/`dropTarget` are pure and tested. Gizmo has a **Local/Global** toggle; `projectPanel.ts` is the **Project browser** (tabs per asset kind with counts; **thumbnails for prefabs, models and materials** rendered once offscreen and cached via `previews.ts` + `render-three`'s `thumbnails.ts`, textures shown as themselves, sound audition, font sample; prefabs and models arm for placement, anything else opens in the Inspector), `assetInspector.ts` edits a material **generically from its shader's parameter list**, `assetImporter.ts` + the dev server's `/api/assets` and `/assets/<path>` routes assign ids and serve bytes (ADR 0026); `inspector.ts` keeps Tweakpane, mounted with `PaneConfig.container`; `toolbar.ts` builds once and patches values. TransformControls gizmo with grid snap, mover end-position ghost, live re-instantiation as a validity check, and **play-in-place on the real `createLocalController` + `stepCharacter`**. Placing writes a **reference** into `Level.prefabs`; "Edit prefab" steps into the shared definition and every instance follows; "Extract to prefab" promotes an inline one-off. **Animation** is the Animation tab in the bottom row (ADR 0029): `trackEdit.ts` is every timeline mutation as a pure function (33 tests — put/move/delete a key, segment easing, snapping, key rows, path points), `timeline.ts` draws the strip (ruler, diamonds, per-segment easing labels, a playhead that scrubs the whole level without entering Play), and the viewport draws the **path** with a draggable handle per key. The gizmo writes the authored transform when there is no track, the selected key when there is one, and offsets every key when a track is selected as a whole. Instance **overrides**: transform, behavior (a track), **material** (ADR 0028 — offered at both levels, "material" on a piece and "material override" on an instance; the `style` dropdown is gone). Save syncs the file name to the document id. Reads/writes `content/` via a dev-server file API.
- `modes/parkour` — the parkour mode on Colyseus rooms: Roblox-like controller (live-tunable), auto-join, nametags, data-driven levels, checkpoints/hazard/fall via physics triggers + persistence adapter, a **death ragdoll** + **spawn assembly** (one dynamic body per rig part, seeded from the animated pose; left click respawns and the body drops back in a pair at a time — ADR 0019; peers ragdoll and re-assemble too, each viewer running its own from one `STATE_DEAD` flag), a **Pixi pause screen** (settings + roster + restart, localized via `@mp/i18n`), and the **third-person camera** (wheel zoom, pitch to straight overhead, sphere-cast occlusion — ADR 0020). **Level selection** in `levels.ts`: `?level=<name>` loads `content/levels/<name>.json` (bundled via `import.meta.glob`), no param loads **`default.json`** (a placeholder so the game always boots; a file, so the editor can edit it — ADR 0027); an unknown name logs and falls back to it. The name is passed to `joinOrCreate` as a matchmaking filter. `assets.ts` builds the asset database from bundled `.meta` sidecars and preloads what a level references before the level view is built (ADR 0026). `references.test.ts` is the **reference-integrity guard** (ADR 0028): every material/model id reachable from every shipped level resolves in `ASSET_DB`, every texture a material names resolves, and the seven greybox materials exist by name — a dangling id greyboxes silently, where an unknown `style` used to fall back harmlessly. Composition root; view pieces in `nametag.ts`/`characterView.ts`/`pauseMenu.ts`/`ragdoll.ts`/`assemble.ts`, collision layers in `layers.ts`.
- `content/levels` — level JSON, loadable by name (`?level=<file>`): **`default.json`** (what loads with no
  param), `level1.json` (the ported original world), plus editor/Unity scratch files.

## Deferred (not built)

- **Mobile is playable but unmeasured and unvalidated on a device.** Touch controls exist and are wired
  (ADR 0022): stick bottom-left, jump bottom-right, look everywhere else, pinch to zoom, tap to respawn
  while dead. What has *not* happened is anyone playing it on a phone — so the layout numbers are first
  guesses (all exposed in the pane's **Touch** folder), and budgets 1 (frame time) and 5 (memory) are still
  unmeasured, which needs the same device session. The pause screen is the only UI laid out for a small
  screen; nothing else has been sized for one.
- **Nothing verifies a level is clearable.** `gym.test.ts` asserted every authored jump against the
  measured envelope; it and its subject are deleted (ADR 0027). The envelope is still measured
  (`packages/character/src/envelope*.test.ts`), so the numbers in `obstacles.md` hold — what is missing is a
  check over an authored level, which belongs in the editor as a reachability gizmo.
- **Parametric generators in the schema.** A prefab file stores baked pieces, so it cannot hold
  `padChain({ gap: 2.5 })` — only the boxes it produced. Considered and rejected when the generators were
  deleted (ADR 0027): shapes like a pad chain or an arc now have to be built piece by piece, since scaling
  cannot change a pad count or an arc radius.
- **Goal/win rule, other modes** (obby-tower variant, keyboard-run grind + progression), **glTF art layer**, **account-backed persistence** — accounted for by seams (ADR 0014), not built. The `goal` **trigger kind** exists in the schema and `default.json` has a goal pad, but the mode has no goal rule — nothing ends a run.
- **M9 — 2D path** (Rapier2d + Pixi-only). Deferred when scope narrowed to 3D.
- **Deploy** (Dockerfile + single-VPS) — re-scoped with Kodjo when a target exists. `infra/` empty.

## Where "SEED §n" points

`SEED.md` was Kodjo's requirements handoff — locked decisions, the five budgets, the structural laws, the
build order. It was **input to the project, not documentation of it**, and by its own lifecycle note it was
deleted once every part of it had been implemented and documented or explicitly superseded. Git has it.

The `(SEED §n)` citations left in these docs and in code comments mark a constraint as *Kodjo's*, not an
agent's invention, which is worth keeping. Where each section's content lives now:

| SEED | Now |
|---|---|
| §1 scope, "simplified Roblox" + modes | ADR 0014, the top of this file |
| §2 locked technical decisions | ADRs 0001–0003, 0013 (transport → Colyseus), 0015; `workspace.md`, `protocol.md` |
| §3 players per room, mobile targets, input abstraction, per-client snapshots | `netcode.md`, ADR 0008, the mobile entry above. Its rewind requirement was retired by ADR 0011 |
| §4 netcode model | **Reversed** by ADR 0011; `netcode.md` is current |
| §5 the five budgets + mitigation menu | `budgets.md`, verbatim |
| §6 structural laws + package layout | `workspace.md`; `games/` → `modes/` in ADR 0014 |
| §7 build order M1–M8 | tags `m1`–`m8`; M9/M10 in the deferred list above |
| §8 human-owned tasks | `budgets.md` (which budgets are human-measured), CLAUDE.md's prime directive |
