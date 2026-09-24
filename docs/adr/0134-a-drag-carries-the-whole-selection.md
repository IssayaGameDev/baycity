# ADR 0134 — A drag carries the whole selection

Status: accepted, **amended below**. Brings the Hierarchy's drag in line with
[ADR 0112](0112-the-inspector-edits-the-whole-selection.md) and
[ADR 0128](0128-a-pull-moves-the-whole-selection.md); keeps
[ADR 0113](0113-a-reparent-is-one-edit.md)'s one-edit rule. Uses
[ADR 0133](0133-a-placement-can-do-without-a-piece.md) to let a prefab's piece travel.

## Context

Selecting five objects and dragging them into another object moved one: the one under the pointer. The drag
was single-node from the DOM handler down — `dragFrom` held an index and `onReparent` took one.

Everything else here acts on the selection. This did not.

## Decision

**Grabbing a selected row drags the whole selection. Grabbing an unselected one drags it alone**, which is
Unity and the only reading that does not surprise.

**Roots only.** With a parent and its child both selected, the child is already travelling inside the
parent; moving it as well would take it out. `rootsOf` is the filter copy and duplicate already use.

**Every pose is read before anything moves.** A reparent re-expresses the world pose in the new parent's
frame, read off the scene graph — which the first move invalidates for everyone behind it. From the authored
poses, so a mover's current position is not written into the file (ADR 0126).

**Addressed by ref, not index.** Each move renumbers the tree depth-first, so every index after the first is
stale — including the destination's. The loop resolves both ends from refs each time.

**One history entry for the drag**, however many it carried, so it is one Ctrl+Z and one message to the room.

**Order is kept**: the rows travel ascending and each lands one slot after the last.

## The ones that cannot go

Four cases refuse, and after enumerating them the common one decided the rule:

| | |
|---|---|
| onto one of the objects being dragged | ordinary: select A, B, C and drop on A. The others belong in A |
| onto a descendant of one of them | a loop; not a tree any more |
| a piece dropped onto a piece | where a piece sits is the prefab's, for every placement at once |
| a prefab document's own root | it is the file |

**The ones that can, move; the rest are skipped**, and the status line says how many. Refusing the whole drop
was the first recommendation here and it was wrong: it was reasoning about a category that had not been
listed out, and the most likely case in it — dropping onto a member of the selection — is one where doing
the rest is plainly what was meant.

## The amendment: the press collapsed the selection first

Shipped, it still moved one row. The row's `pointerdown` selected it with `replace`, so the selection was down
to the grabbed row before `dragstart` read it. The tests covered the move, not the order of the events.

**A plain press on a row of a multi-selection now leaves the selection alone, and the click collapses it**
(`defersToClick`, `src/selection.ts`, tested). A drag never produces the click, so the selection survives it.
This is Unity's order. Primary button only; Ctrl, Shift and right-click are unchanged.

## Rejected

- **Refusing the whole drop on any illegal member.** See above. Obstructive in the common case.
- **Moving by index with a shift correction**, as `duplicateSelected` does. It works for inserts, where the
  shift is knowable; a reparent moves a subtree from anywhere to anywhere and the arithmetic is a second
  implementation of the tree walk.
- **Keeping the selection's own order rather than the tree's.** A drop should land things the way they read
  in the list, and the list is the tree.
