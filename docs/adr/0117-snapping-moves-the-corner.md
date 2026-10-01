# ADR 0117 — Snapping moves the corner, not the centre

Status: accepted. **Superseded by ADR 0179** (a move snaps the centre, on the axes dragged). Continues
[ADR 0114](0114-one-snap-increment-per-tool.md)'s snapping; the third appearance
of the same fault, after [ADR 0113](0113-a-reparent-is-one-edit.md) and ADR 0114.

## Context

Kodjo builds rooms: a floor, walls, a ceiling, tunnels between rooms, and floating platforms. The floor is
always a keyboard. He needs to place two platforms next to each other and have the keys line up.

Three attempts inside the keycap code failed, each fixing the previous one's symptom
([ADR 0115](0115-the-keys-are-the-games-not-the-platforms.md),
[ADR 0116](0116-a-cell-belongs-to-the-board-its-centre-is-on.md)), because the problem was never in the
keycaps. It is that **a box's edges do not land on the grid**.

A box is stored as a centre plus a size, and the editor snapped the centre. So:

| Size | Centre on a grid line | Edges |
|---|---|---|
| even number of cells | yes | on grid lines |
| odd number of cells | yes | **halfway between** |

Half of all sizes put the edges off the grid, which is exactly where a keycap hung over a platform's edge.
No rule about sizes fixes it, because the parity of the size decides where the edges go.

## Decision

**Snap the minimum corner of the world axis-aligned box.** `setTranslationSnap(null)` hands the job over from
`TransformControls`, and `snapTranslation` does it on `objectChange`, before the write-back and the mirror.

Then a box of any size fills whole cells: the low edge is on a line by construction, and the size is whatever
it is, so the high edge follows. The edge is what meets the next platform; the centre is a number nobody looks
at.

**World axis-aligned**, via `worldHalfExtents` (`|R| · h`, the rotation with every entry made positive), so a
wall rotated onto its edge snaps by the face being butted against something rather than by its own local x.
At 90° that swaps two axes, which is the case the rooms are built from.

Snapped in world space and converted back through the parent, so a child of a moved or rotated group lands
where the grid is rather than where its parent's frame happens to put it. Only the primary;
`mirrorDragToSelection` gives the others its delta, as translation always has.

## The same fault three times

- ADR 0113: Tweakpane's `step` anchored its grid to the value the field was built with, so a round number was
  unreachable.
- ADR 0114: `TransformControls` snapped a rotation's *delta*, so a round angle was unreachable.
- Here: the editor snapped a box's *centre*, so an edge on the grid was unreachable for half of all sizes.

Each time, something was quantised relative to where it already was, or relative to the wrong part of the
object. The pure arithmetic now lives in `tools/editor/src/snap.ts` with tests that say why, which is the
cheapest defence against a fourth.

## Not done

- **Placing a new object still snaps the click point, so its centre lands on the grid.** Place-then-drag
  therefore shifts it once. Corner-snapping a placement needs the object's size before it exists, which is
  more surface than the fix warranted.
- **The snap increment is still not the key pitch.** With snap 0.5 and a pitch of 0.9, a seven-key floor is
  6.3 m, which no number of 0.5 steps reaches — so sizing a keyboard floor still needs arithmetic. Making the
  increment the pitch is the other half of Kodjo's problem and he chose to take this half first.
