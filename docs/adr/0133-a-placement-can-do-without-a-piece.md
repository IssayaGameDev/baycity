# ADR 0133 — A placement can do without a piece

Status: accepted. The fourth and last of Unity's override kinds, after changed values, added components
([ADR 0098](0098-a-placement-can-override-its-prefab-roots-components.md)) and an added child
([ADR 0130](0130-a-child-added-to-a-placement-can-be-applied.md)). Closes the limit named in
[ADR 0131](0131-a-prefabs-piece-can-be-copied.md).

## Context

A piece of a prefab could not be deleted from one placement. Cut only copied, delete was greyed, and dragging
a piece out of a placement was impossible — every one of them needs to say "this copy does not have that
piece", and the override record had no shape for it.

Kodjo's framing, and he is right: that is a limitation dressed up as a rule. A prefab in a level should
behave like any other object, with every difference recorded so it can be applied or reverted. Three of the
four kinds were here. This is the missing one.

`nodeEnabled: false` (ADR 0099) is nearly it and is not it: switching a piece off keeps it, dims its row and
says "there is a thing here you turned off". Removing takes it away.

## Decision

**`NodeOverride.removedNodes`** — the prefab node ids this placement does without, kept on the removed
node's own record and keyed by its own id, so every other override on that piece is cleared with it and
putting the piece back is one `setNodeOverride null`. One op, `setOverrideNodeRemoved`, with its inverse.

**The subtree goes with it**, the way removing any node takes its children.

**Dropped in the tree walk, not only in `bakeOverrides`.** The editor builds its tree from the prefab's own
child objects, so that a write can reach the definition — so a child dropped while baking is still walked,
addressed and drawn. A removed piece has to be absent from the walk or it is not removed at all. Both places
do it now.

**Reported on the placement** (`placementRemoved`), read off the override records rather than the tree: a
removed piece has no index, so `placementOverrides` cannot see it and every count would read zero.

| | |
|---|---|
| Revert | puts the piece back — the prefab has it, and reverting means looking like the prefab |
| Apply | **deletes it from the prefab**, so every placement in every level loses it. Kodjo's call: Apply means "make the prefab match this copy", and Ctrl+Z is the way back. Emitted before the added children's inserts, so their indices are the ones left after the deletions |
| Delete, Cut | no longer greyed on a piece |
| Reorder, reparent, Create-child | still refused: where a piece *sits* is the prefab's, and there is still nowhere in this level to put a child of one |

## Not in this one

**Dragging a piece out of a placement** is the other half Kodjo asked for: resolve the piece at the
destination (which `copy` already does, ADR 0131) *and* record the removal here (which this adds). Both
halves now exist; joining them is its own change, and multi-select drag sits on top of that.

## Rejected

- **`nodeEnabled: false` instead.** It leaves a dimmed row that says the piece is still there, which is true
  and is not what deleting means.
- **Apply skipping removals.** Then Apply stops meaning "make the prefab match", and the strip would count a
  change it declines to push without saying which.
- **Keying the removal on the placement's own record** rather than the piece's. One list to invalidate
  whenever a piece's other overrides are cleared, instead of the record dying with the piece.
