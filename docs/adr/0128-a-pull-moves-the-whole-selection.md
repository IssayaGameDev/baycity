# ADR 0128 — A pull moves the whole selection

Status: accepted. Extends [ADR 0119](0119-a-face-is-a-handle.md)'s Face tool to a multi-selection
([ADR 0031](0031-multi-selection.md)), the way [ADR 0112](0112-the-inspector-edits-the-whole-selection.md) did
for the Inspector. No new UI and no new gesture. Both behaviour choices below are one constant each, because
Kodjo expects to try the other after playing with them.

## Context

Kodjo asked whether several faces could be dragged at once. The question hides two features:

- **one face, many boxes** — select five platforms, drag one's +X face, all five grow;
- **many faces, one box** — shift-click +X and +Z, drag both.

The second is a different tool. ADR 0119's decision is that the face *is* the handle, with no click-to-select
step; face selection reverses that, and two faces on different axes is two axes at once, which is the same
question 0119 parked when it rejected edge and corner pulls. Kodjo wants the first.

The Face tool read `host.selected()` — the primary alone. Ten boxes selected, one box pulled, and the grab
only worked on that one box.

## Decision

**The drag applies to every selected box that is a built-in box or rounded box.** Anything else in the
selection drops out silently, so a mixed selection pulls the boxes in it rather than refusing the gesture.

**Which face each other box moves: the one pointing most nearly the way the drag is going** (`faceTowards`,
pure and tested). The grabbed box names its face from the pointer; the rest are asked about the world
direction. For boxes that share a rotation — the ordinary case — this is identical to using the same lettered
axis, and it is only mixed rotations the question is about. World direction wins there because a box turned
180° would otherwise grow *away* from the drag while its neighbour grew toward it, which reads as broken.

**The distance is the drag's; the snap is each box's own.** One `raw` comes off the pointer on the grabbed
face's line, and every box moves its own face that far along its own normal. Each then snaps where *its* face
lands, not how far it moved — ADR 0119's rule unchanged, and ADR 0113, 0114 and 0117's before it. Boxes that
began off the grid therefore arrive on it and come out flush, which is the reason for selecting them together.

That also means the alternative is free: with snapping off, `snappedPull` returns `raw` untouched and every
box moves by exactly the same amount. Both behaviours fall out of the toggle that already exists, with no
second rule.

The minimum-size clamp stays per box, so one box hitting its floor stops while the others keep going, rather
than the whole drag refusing.

**The gesture starts on any selected box**, nearest under the pointer, not on the primary. Moving all five
while making you hunt for the last-clicked one to begin is an arbitrary restriction; whichever you point at
names the face and the rest follow it.

**One highlight per selected box, on hover as well as during the drag.** ADR 0119 drew one because only one
box could ever move. Now exactly one face on each selected box moves, and on a box rotated away from the
others *which* face that is cannot be predicted — so the preview is the answer to the one question the
world-direction rule raises. A pool of plates, grown on demand, sharing one geometry and one material.

The status line still carries the grabbed box's size plus `+N`, because one line cannot show five sizes and
the Inspector already does (ADR 0112). One history entry per drag, coalesced like a gizmo drag.

## The two switches

| Constant | `pickTool.ts` | Flip it for |
|---|---|---|
| `MATCH_FACE_BY_WORLD_DIRECTION` | `true` | the same lettered axis on every box, so a ring of outward-facing walls expands outward instead of sliding one way |
| snapping toggle | the toolbar's | same-distance-for-all instead of each face landing on the grid |

## Rejected

- **Many faces on one box.** A different tool: it needs a face selection, which reverses ADR 0119's "the face
  is the handle", and it needs an answer to what stays anchored when two axes grow at once. Not asked for.
- **Refusing a selection that contains a sphere or an empty.** Pulling the boxes in it is what the Inspector
  does with a mixed selection, and refusing would make the tool feel broken rather than careful.
- **Projecting each box's motion onto the drag direction** rather than moving each face by `raw` along its own
  normal. Correct-looking for mixed rotations and surprising for the ordinary case, where two platforms a few
  degrees apart would then grow by visibly different amounts.
