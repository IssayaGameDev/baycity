# ADR 0024 — The editor's UI is a fixed-panel DOM shell; Tweakpane is one panel, not the editor

Status: accepted. Applies to `tools/editor` only. Does not touch ADR 0015 (PixiJS for all *game* UI),
which already excludes dev tools.

## Context

The editor's entire UI was one floating Tweakpane pane. Tweakpane is a parameter panel — bind a
property, get a labelled slider — and it is very good at that. Used as a whole editor it failed in
specific, diagnosable ways:

- **The file picker was a `<select>` of filenames**, because Tweakpane's only list-shaped control is a
  dropdown. There was nowhere to put an asset browser.
- **No tree, so there was no hierarchy panel at all.** The only way to select anything was to click it
  in the viewport — hopeless for a piece behind another piece, and the largest single usability hole.
- **The inspector destroyed and rebuilt every control on every change.** Conditional fields ("show
  `travel` only when the behavior is `move`" — a form ADR 0029 deleted) cannot be expressed any other way,
  so `buildInspector`
  disposed all its blades and re-added them. Because the pane *was* the UI, that took the file picker,
  the palette and the play toggle with it: everything flickered, and focus was lost mid-edit.
- **One pane means no layout.** Unity's arrangement — hierarchy, viewport, inspector, assets — is most
  of what makes an editor legible, and Tweakpane has no concept of a panel.

## Choice

**A fixed-panel shell in plain DOM + CSS, with no UI framework and no new dependency.**

Kodjo's requirement was Unity's *layout* (fixed regions with draggable dividers), not Unity's *docking*
(tear-off windows, tab reordering, saved layouts). That distinction is the whole cost difference: the
layout is one CSS grid, docking is an engine you do not hand-write.

- **One CSS grid** (`index.html`): toolbar / hierarchy | viewport | inspector / palette / status. The
  three panel sizes are custom properties (`--left`, `--right`, `--bottom`), so a splitter drag writes
  one style value and the browser re-lays out. Nothing measures or positions in JS.
- **Splitters are ~40 lines** (`splitter.ts`), not a library. Pointer capture on the handle, because a
  5 px divider is left immediately once the drag starts. `clampSize` is pure and tested, including the
  case that matters — a window too narrow to honour both the panel's minimum and the viewport's, where
  the minimum has to win or the grid track goes negative.
- **Tweakpane stays, mounted in the Inspector panel** via `PaneConfig.container`. Its one weakness is
  unchanged: conditional fields still mean disposing and re-adding. But confined to one panel, that
  rebuild is invisible — and a property grid of labelled, drag-editable numbers is exactly what it is
  best at. Replacing it would have meant hand-writing that, for nothing.
- **Toolbar and hierarchy build their DOM once and only update values.** That is the fix for the flicker,
  not a side effect of it: `setOptions` even leaves an unchanged `<select>` alone, since rebuilding its
  options closes an open popup, and the name field is skipped while focused.
- **A hierarchy panel** (`hierarchy.ts`) — instances, expandable to the pieces of the prefab they
  reference. Piece rows are a way *in*: double-clicking one opens the shared definition with that piece
  selected, because a piece belongs to the prefab, not to the instance it was clicked under. Its row model
  (`rowsOf`) is a pure function and carries the tests. (One level deep as built here, matching the flat
  content model of the time; a real tree since ADR 0025.)
- **Rename in place** (double-click an instance row) and **drag to reorder**, with the insertion point
  drawn as an inset line so nothing shifts mid-drag. Reordering is not cosmetic: checkpoint progression
  follows instance order and so does the movement-base index a rider replicates (ADR 0021), so a move
  rebuilds the item meshes and the physics world rather than patching them — item indices *are* the
  identity for meshes, selection and the gizmo's target. The insertion point is expressed against the list
  as it was, which is what a drop between two rows gives; the shift when moving downward is where the
  off-by-one would live, so it is tested.
- **True parenting arrived in ADR 0025**: dropping a row onto another re-parents it, the scene graph nests,
  and the gizmo gained Unity's Local/Global toggle. Prefabs are still flat — nesting is a property of
  placement.
- **Every panel reads state through a getter**, so `refreshUi()` is the single "redraw the chrome" call
  and no panel can hold a stale copy.
- **Grid and marker toggles moved to the toolbar**, where they are visible, instead of a collapsed pane
  folder.
- **The Inspector's header is ours, above the Tweakpane grid** — Unity's arrangement: a full-width
  editable **name**, then a **prefab-link row** (`prefab: pad-chain · 3 instances` + *Open*, or
  "not linked to a prefab" + *Extract*). A Tweakpane binding would have put the name in the 92px label
  column like any other property, and the link buttons previously sat at the *bottom* of the property
  list. Renaming redraws only the header and the hierarchy row — it does not tear down the property grid
  or rebuild any mesh. Prefab-linked rows are tinted, as Unity tints prefab instances.

No virtualization: a level is tens of rows. `react-arborist`'s main advantage starts around a thousand.

## Consequences

- **`ThreeStage` gained `resize()`.** The canvas is no longer window-sized, so a splitter drag changes it
  without a `window.resize` to notice — and the stage's resize handler was private. A canvas embedded in
  a resizable layout is a legitimate stack gap (dependency law 3), so the fix belongs in
  `@mp/render-three` rather than being faked in the tool. `relayout()` coalesces to one call per frame:
  `pointermove` fires far faster than the effect composer wants to reallocate render targets.
- **`main.ts` did not shrink** (868 lines, was 872) — the old pane section left and an equivalent volume
  of explicit wiring arrived. What improved is separation: the widgets are five modules with tests, and
  main.ts is viewport, gizmo, play and composition. Play-in-place (~160 lines) is the next extraction.
- **Selection is guarded on `playing`.** The Hierarchy panel can select, and during play the item meshes
  are hidden — attaching a gizmo would leave a handle floating over a level being walked. The guard sits
  on `select()` rather than on the viewport's click handler, since there are now two ways in.
- The editor is the only DOM UI in the project. That is the point of ADR 0015's carve-out for tools, and
  Pixi would be a poor fit here: no native text input, no accessibility, every widget hand-rolled.
- **Styling our own controls with element selectors reached inside Tweakpane.** `button`/`select`/`input`
  rules leaked into the mounted pane, and one of them did real damage: Tweakpane renders numeric fields
  as `type="text"`, so `input[type='text'] { width: 120px }` (0,1,1) beat its own
  `.tp-pndtxtv_a { width: 100% }` (0,1,0) and pinned every axis field to 120px — three to a position row,
  in a 288px panel, hence a sideways scroll. Our controls now carry `.ctl`; Tweakpane styles its own.
- **Tweakpane's row layout had to be inverted for a narrow panel.** It pairs a *growing* label
  (`.tp-lblv_l {flex:1}`) with a *fixed, unshrinkable* value column
  (`.tp-lblv_v {width: var(--bld-vw, 160px); flex-shrink:0}`), sized for the 256px pane it builds when no
  `container` is passed. In a 300px panel that is ~100px of dead space before the values. Overridden to
  the Unity arrangement — fixed 92px label column, values take the rest — with `min-width: 0` at every
  level, since an `<input>`'s min-content width is about 20 characters and a flex item will not go below
  that by itself.
- **The view layer stayed cheap to replace.** All editor logic is in `editorDoc.ts` — pure, tested, no
  DOM — so this pass touched no tested behaviour, and a later move to a framework would not either.

## Rejected

**React + `dockview` + `react-arborist`.** The honest alternative, and the right answer *if* real docking
were needed or the editor grows a lot: the ecosystem for editor-grade trees and property grids is
React's. With fixed panels the only thing it buys is the tree, which does not justify a first framework
in a repo that has none.

**`lit`.** ~5 kB, declarative templates, would remove the hand-written DOM updates. Genuinely close. Not
taken because the update surface turned out small — a toolbar that patches values and two panels that
rebuild a few dozen rows — and because Tweakpane already covers the one place with real conditional
structure.

**`split.js` for the splitters.** Approved by Kodjo and not used: 40 lines of pointer capture against a
CSS variable is less code than wiring a library that positions elements itself.

**Keeping Tweakpane as the whole UI and only restyling it.** No tree and no layout at any amount of CSS.

**Forking three.js's own editor** (`editor/` in the three repo, MIT — genuinely a Unity-ish DOM editor).
Its source of truth is a `THREE.Scene`; ours is content JSON, and prefab references have no scene-graph
equivalent. Adopting its object model means fighting it at every edit.
