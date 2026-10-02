# Editor actions (ADR 0194)

What a person does in the editor, named and taking its input as data — `tools/editor/src/actions/` — so an agent can
be handed the same ones as tools. Through the editor's own `Doc` calls, history and room. The assistant's Confirm and
Auto modes run them (ADR 0195, `assistant.md`); an MCP endpoint is not built (Kodjo's call: later).

| File | |
| --- | --- |
| `actions.ts` | `defineAction(def): Action`, `createEditorActions(host, actions): { list, run(name, input, turn?) → ActionOutcome }`, `ActionHost`, `ActionCtx`, `ActionError`, `parseRef` |
| `schema.ts` | `str num bool oneOf vec3 list nullable anyValue record object` → `Schema<T> { json, parse }`; `InputError` |
| `readActions.ts` | `READ_ACTIONS`, `VIEW_ACTIONS` |
| `editActions.ts` | `EDIT_ACTIONS` |
| `views.ts` | `objectView`, `viewOf(ctx, id)`, `assetView`, `describeSpec`, `builtInModels`, `assetIdHint`: one shape for a read and an edit's answer |
| `hints.ts` | `closest`, `didYouMean`, `componentTypeHint`: what a refusal says to put right |
| `sequenceActions.ts` | `SEQUENCE_ACTIONS`: a Sequence's stages (ADR 0198) |
| `index.ts` | `EDITOR_ACTIONS` (reads, views, edits) |
| `installed.ts` | `installEditorActions`, `editorActions()`: the tab's set, built at the end of `main.ts` over its own host |
| `../undoSteps.ts` | `levelSteps`, `squashTransforms`, `assetSteps`, `planUndo`, `planRedo`: every undo's, not only a turn's |

```ts
interface ActionDef<I> { name: string; summary: string; effect: 'read' | 'view' | 'edit'; input: Schema<I>; inputFor?: (host: ActionHost) => JsonSchema; run: (ctx: ActionCtx, input: I) => unknown }
type ActionOutcome = { ok: true; result: unknown } | { ok: false; error: string }
```

**Input** is checked strictly before `run`: a field not taken is refused by name first, then a missing one. **Ids** are
`refKey`s — `n:<id>`, a prefab's piece `t:<prefab>:<id>`, a placement's piece `i:<placement>:<piece>` — stable while
others edit; a gone one says to read the scene again. A reference field takes and reads back an **object id**, a
component reference `{ object, component }`; stored as the node's id (`Doc.refTo` / `refTarget`).

## `ctx.edit(label, change)` — every rule, once

| Rule | How |
| --- | --- |
| one batch an action | `history.holding(batches, change)`: the doc's batches held, not sent nor recorded; then `commitHeld`: one `submit`, applied by the server all or nothing |
| all or nothing | `change` throws, or is refused: `discardHeldBatches` (inverses onto the root level), repaint, nothing sent |
| one undo a turn | `run(…, turn)`: steps of `turn` (`history.startTurn(label)` … `endTurn`) — one `turn` entry. No turn (a person's): an entry per action |
| stays off held objects (Kodjo's call) | in a turn: every op's `touchedRefs`, walked over a copy of the level from before, against `room.heldByOthers` (other connections, never this tab's) — refused `‹name› has “‹object›” selected, so it was left alone`. Assets: `room.openersOf`. A person's action is never refused (ADR 0158) |
| reads cannot edit | `ctx.edit` from an action not declared `edit` throws |

Redraw: `room.repaint(ops)`, as an undo's. Edit actions leave the selection alone (Kodjo's call: it stays the
person's); `select_objects` sets it.

**Every edit answers with what it changed** (ADR 0196), as a read shows it: `{ object }` — `objectView`, components and
their ids — `{ componentId, object }` for an add, `{ objects }` for up to 5 copies (else `{ ids }`), `{ deleted }`,
`{ asset }` — so the next call needs no read. **A refusal names what would have worked**: a component's type for its
label (`'Mesh Renderer'` → `'Renderer'`), the nearest field, parameter or action names, an asset's id for its name or
for the start of its id. **Built-in shapes** (`builtin:box`…) are models no file holds: `list_assets` lists them with
the models, a model field takes one, `place_asset` sends it to `create_object`. The tools stay low-level, one thing
each (Kodjo's call).

**The picture** (`main.ts` `shrinkToJpeg` over `cameraView.captureFrame`): the frame drawn now, read before the
navigation gizmo goes on, then finished as the loop does — synchronous, because a canvas without
`preserveDrawingBuffer` is readable only in the task that drew it, and a hidden tab draws no frames to wait for.

## Undo leaves what someone changed since (`undoSteps.ts`)

**Every** history entry — a person's level edit, an asset edit, an agent's turn — keeps its steps: an op it made and
its inverse, in order (a drag's transforms squashed to one per object, `squashTransforms`; an asset gesture's steps
rebuilt as it merges, each inverse with the op at its path, `assetSteps`). **Undo**, last first: a step is taken back
only while what it wrote is still there — a value check when undoing, not a record of who touched what, so undoing out
of order cannot fool it. A patch (`setParams`, `setOverrideParams`) per key; a node made goes only if equal to what was
inserted; a move only while under the parent it chose. Otherwise the step is given up — someone else's now — and
counted: `undid: ‹label› — kept N changes made since by someone else` (Kodjo's call: theirs stays, for everyone's
Ctrl+Z). Nothing left to take back: `cannot undo ‹label›: everything it changed has been changed since by someone
else`, and the entry is dropped. **Redo**: only steps the undo took back, only while what that undo wrote is still
there. A level entry puts back what was selected; a turn leaves the selection alone; only an asset entry shows its asset
(`applyAsset(…, show)`). A batch the server refuses drops its level entry, and takes its steps out of open and
finished turns (`dropWhere`).

## The actions

| Action | Effect | Does |
| --- | --- | --- |
| `get_editor` | read | game, level, prefab open, selected ids |
| `get_scene { under? }` | read | objects in Hierarchy order: id, name, parent, components, `inherited`, `prefab`, `enabled: false`, `heldBy`; ≤ 400 |
| `get_object { id }` | read | transform (rotation in degrees), children, each component's id, type, enabled, overrides, every field with defaults; a step's `target` as the child's object id; a Sequence's `problems` — what the Inspector marks ⚠, from `compileSequence`, by stage and step (`sequenceProblems`) |
| `list_component_types { type? }` | read | the game's types and labels; with `type`, its fields: `kind`, default, range, options |
| `list_assets { kind?, search? }` | read | the built-in shapes, then assets the document may use (`mayUse`, ADR 0161); ≤ 300 |
| `get_asset { asset }` | read | a material's shader, values, parameters; a data asset's type, fields, declarations |
| `get_problems` | read | the tab's last 20 warnings and errors |
| `screenshot_view` | read | the viewport as the tab shows it: `{ image: { mediaType: 'image/jpeg', data }, width, height }`, ≤ 512 px on its longer side, quality 0.7 (Kodjo's call: small and light); refused while Play runs |
| `select_objects { ids }` | view | the tab's selection; `[]` none |
| `focus_objects { ids }` | view | `nodes.frame` |
| `create_object { kind, parent?, position?, name? }` | edit | `placeEmpty` / `placePrimitive` |
| `place_asset { asset, position, name? }` | edit | prefab (fetched now) or model, the Project window's refusals; refused when it needs a shared component the game lacks |
| `delete_objects` / `duplicate_objects { ids }` | edit | on roots, deepest first, as `nodeActions.ts` |
| `rename_object { id, name }` | edit | `setName` |
| `reparent_object { id, parent, index? }` | edit | `canReparent`, then `reframedLocal` (the Hierarchy drag's: world pose kept) |
| `set_transform { id, position?, rotation?, scale? }` | edit | local, degrees in, rounded and cleaned as the gizmo writes |
| `add_component { id, type }` / `remove_component` | edit | `canAdd`; a shared type not adopted is refused, named. Its tool input offers `type` as the game's own types only (`inputFor`, `EditorActions.schemaOf`, ADR 0198) |
| `set_component_fields { id, componentId, values }` | edit | each key declared; references and assets resolved and refused as the Inspector does; a built-in's collider locked; stages sent to `set_sequence_stages`; whole component `checkParams`'d |
| `set_component_enabled` / `set_object_enabled` / `move_component` | edit | the Inspector's ticks and Move up / down; an inherited component's order refused |
| `set_material_values { asset, values }` | edit | by shader parameter, tagged by its kind; textures refused as the Inspector does (`editMaterial`) |
| `set_data_fields { asset, values }` | edit | by declared field, whole asset `readParams`'d (`editData`) |
| `set_sequence_stages { id, componentId, stages }` | edit | a Sequence's stages whole, by `Doc.setSequenceStages` — an override on a placement's copy; ids minted where none is given; a step's `target` a direct child's object id, stored as its id; checked by `stagesProblem`. Its tool input spells every step kind, timing and ease, and that a stage's steps start together from where the stage began (ADR 0198); its answer's object carries the `problems` |

Not actions: what undo cannot take back — files (an asset, folder or level made, renamed, moved, deleted; uploads),
Apply to prefab, Save as prefab, adopting a shared component — stays out until each can be undone as one (Kodjo's
call). Not built yet: a material's shader, environment, network bounds, camera see-through, prefab enter/leave,
Play.

**A new editor feature adds its action**: `defineAction` in `editActions.ts` or `readActions.ts`, through the same calls
as its control, listed in `EDITOR_ACTIONS`, tested in `actions.test.ts`.
