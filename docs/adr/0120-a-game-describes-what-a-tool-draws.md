# ADR 0120 — A game describes what a tool draws

Status: accepted. Extends ADR 0052's rule that a tool asks the game; uses ADR 0090's rule that a built-in's
scale is its size, and ADR 0118's centred board.

## Context

Keyboard's caps are generated at load and there are hundreds per platform, so they are neither nodes nor
colliders (ADR 0069). Nothing in the editor therefore showed them, and an author placing platforms could not
see where the keys would land.

That is the whole difficulty behind ADR 0115 → ADR 0118. Fitting two platforms together so their keys continue
means knowing how many whole cells each face holds and how much is left over at its edges — and `boardOf`
floors to whole cells and splits the remainder, so the answer is arithmetic nobody should be doing by hand.
Kodjo's words: "I don't want to have to whip out my calculator anytime I make a platform."

## Decision

**The game describes a grid; the tool draws it.**

`ModeDescriptor.surfaceGrid` joins `gizmos` as a seam where a tool renders what only the game can answer. The
progression is the point: `gizmos` is a colour per component type, this is a grid per surface.

```ts
type SurfaceGridOf = (components, size: Vec3, settings) => SurfaceGrid | null
interface SurfaceGrid { cols; rows; pitch; size; startX; startZ }
```

| Choice | Why |
|---|---|
| the **grid**, not the geometry | six numbers whatever the cell count, so a tool can ask on every frame of a drag; and the tool keeps the renderer, so `@mp/mode` stays headless as everything else in it is |
| the game reads the node's `components` | the editor never learns what a `Keyboard` is, so it does not name a game — the property `modes.ts` exists to protect |
| `settings` passed in | the geometry is the game's (ADR 0115) and editable live in the Game row, so a preview must follow the field rather than the last reload. `keyGeometryFrom` now takes values, and serves the game's bundled `game.json` and the editor's live copy alike |
| `boardGrid` extracted from `boardOf` | one copy of the rule. A preview computing its own `cols` can disagree with the runtime, which is the fault ADR 0113, ADR 0114, ADR 0117 and ADR 0119 each fixed in turn. A test asserts the two agree cell for cell |

**Drawn inside the node's mesh holder.** That holder already carries the inverse of the node's world scale
(`buildItemMeshes`), so a child of it sits in plain world metres oriented with the node — the same frame
`capsFor` lays caps out in before rotating them. Two things fall out: a move, a turn or a reparent re-runs
nothing, because three composes the chain; and a **size** change rebuilds the item's meshes, which is where
this rides, so a face pull (ADR 0119) re-lays the cells live as you drag.

**Filled translucent squares at the cell footprint** (`pitch × fill`), not a line grid. A grid draws cell
boundaries with no gaps, and the gap is the thing being judged: the question at a seam is whether it looks like
the gap between two keys. Squares also show the leftover margin for free, as the bare strip between the last
square and the platform edge. They are cheaper too — two triangles per cell in one instanced mesh, against
four line segments.

**Its own `Keys` toggle**, hidden when the game describes no grid. Fitting platforms together is exactly when
spawn discs and rule pillars are clutter, so it does not ride `Markers`.

**Built-in box and rounded box only**, matching ADR 0119: for those the collider is the unit shape and the
scale is the size (ADR 0090), so a node's scale *is* the surface. A sphere has no face, and a `Keyboard` on one
already generates nothing — so the preview is empty, which is the first time that has been visible.

## Rejected

- **Draw the real caps** — run `capsFor`, the instanced meshes and the glyph textures in the editor. Exact, and
  wrong: hundreds of caps rebuilt per drag frame, the caps sitting on top of the thing being clicked and
  gizmoed, and letters that are noise for a question about alignment.
- **A line grid.** More geometry, and it hides the gap that is being compared.
- **Ride the `Markers` toggle.** One fewer button, at the cost of the two being wanted at different times.
- **The editor computing the grid itself** from `pitch` and the box size. It is six lines, and it is a second
  copy of the rule that the four ADRs above were each a consequence of.
- **The game returning a cell list.** Allocates per cell per frame of a drag, for a description that fits in
  six numbers. `gridCells` expands it where it is needed.
- **A flag on the `Keyboard` component.** The geometry is the game's, not the platform's (ADR 0115), and a
  preview is not level content.
