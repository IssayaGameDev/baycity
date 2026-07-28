# PLAN — Visual level editor (`tools/editor`)

In-browser visual editor for `@mp/content` levels (Kodjo authors levels without writing code).
Mode-agnostic: it edits shared content. Dev-time tool (own vite app + port, like the viewer).

## Decisions

- **Base**: new `@mp/editor` app under `tools/`, reusing the render-three pipeline (stage,
  environment, post-FX, `addLevel`, `geometryForCollider`, `colorForStyle`) exactly as `tools/viewer` does.
  Kept separate so the viewer stays a lean read-only inspector.
- **Format**: the existing JSON level format (`content/levels/*.json`, validated by `validateLevel`).
  A level is already pure serializable data — no new schema.
- **Persistence**: a Vite dev-server plugin exposes a file API over `content/levels/`:
  `GET /api/levels` (list), `GET /api/levels/:name` (read), `PUT /api/levels/:name` (write, pretty JSON).
  No File System Access API (smoother, no per-save gesture).
- **Gizmos**: Three `TransformControls` (examples/jsm, same source as OrbitControls — no new dep),
  re-exported from render-three. Raycaster for select/place. Grid snapping.
- **Editor UI**: tweakpane (dev-tool, already a viewer dep) for palette / inspector / file controls.
- **Editing model**: mutate an in-memory `Level`; re-instantiate visuals on change. Physics world is
  used only to derive visuals/markers/triggers from the data (same as the viewer), not for editing.

## Phases (each ends runnable + typecheck/tests green; one commit per phase after validation)

1. App + file round-trip: list/load/render/save levels; New blank level. No editing. ← current
2. Select (raycast) + move/rotate gizmo + grid snap; write back to data; Save persists.
3. Palette of kit prefabs → place; delete/duplicate selected.
4. Inspector: edit selected piece size, trigger kind, behavior, transform numerics.
5. Play-in-place (port viewer's real character test), spawn/marker editing, validation surfacing.

## Scale (Unity-like)

`Transform.scale?: Vec3` (default 1). The loader bakes it into collider dimensions + child
offsets at instantiate (Rapier colliders have no scale in their pose — same as Unity baking
lossy scale into a PhysX shape). Non-uniform scale on ball/capsule is approximated; boxes exact.
The editor persists scale on the instance group (`Object3D.scale`) → written to data; the mesh
(base geometry × group scale) visually matches the loader's baked dims.

## Prefab mode + composition (architecture locked with Kodjo)

Flat, non-recursive: Level → Prefab (instances) → Pieces (primitives). **No prefab-in-prefab at
runtime** (behaviors are pure functions of the synced clock; nesting = composing moving frames =
engine territory). Reuse via **author-time flatten**: placing a user prefab into a level inlines a
copy. `Piece.behavior?` added (precedence piece → instance → prefab → static), so each object can
move/rotate independently.

Editor is one tool, two modes (`editorDoc.ts` hides the level-vs-prefab difference behind an item
interface): Level edits instances, Prefab edits pieces (place primitive, per-piece style / trigger /
behavior). Files: `content/{levels,prefabs}/*.json` via the dev-server file API. User prefabs appear
in the level Add palette.

## Status

- Phase 1 (file round-trip), Phase 2 (select + move/rotate/scale gizmo + numeric XYZ inspector),
  Phase 3 (palette place + delete/duplicate): done.
- Prefab mode + per-piece behavior + per-piece style/trigger inspector: done.
- Remaining: play-in-place test (port viewer's), spawn/marker placement, validation surfacing.
