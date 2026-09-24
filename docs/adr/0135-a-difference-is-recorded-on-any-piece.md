# ADR 0135 — A difference is recorded on any piece

Status: accepted. Completes the override model begun in
[ADR 0098](0098-a-placement-can-override-its-prefab-roots-components.md) and continued in
[ADR 0130](0130-a-child-added-to-a-placement-can-be-applied.md) and
[ADR 0133](0133-a-placement-can-do-without-a-piece.md). **Generalises ADR 0130**, whose added children only
worked at the placement's root.

## Context

Kodjo, after four increments: he wants a prefab in a level to behave like any other object and still be a
prefab, as Unity's does, and every session was leaving something out. He was right, and it was not a string
of unrelated omissions — it was one structural gap.

Most differences were recordable on any piece: transform, name, parameters, components, disabled, removed
(ADR 0133). Two were not, and both for the same reason. ADR 0130 stored an added child as a **real child of
the placement's own node**, which works at the root and nowhere else, because a piece is not a node of this
level and has nowhere to put one. So a child could not go under a piece, and nothing could say what order a
placement showed a piece's children in.

Answering each question as it arrived, instead of asking what complete looked like, is what made this take
four passes.

## Decision

Two fields on `NodeOverride`, keyed by the piece the record belongs to, which is what makes them work at any
depth:

| | |
|---|---|
| `addedChildren?: Node[]` | nodes this placement hangs under that piece |
| `childOrder?: string[]` | that piece's child order in this placement, inherited and added alike |

**An added child is an ordinary authored node** that happens to live in an override record. The op layer's
`find` walks into `addedChildren`, so every existing op — `setTransform`, `setName`, `removeNode`,
`moveNode`, components, all of it — edits one without knowing where it lives. `idsIn`, `subtreeIds` and
`contains` walk it too, so it takes part in id uniqueness and in what a subtree covers.

**`childrenFor` is the one place children are resolved**, exported from `@mp/content` and used by both
`bakeOverrides` and the editor's tree walk, so the editor and the game agree by construction.

**`childOrder` is a preference, not a contract.** Ids it names that are gone are skipped; children it does
not mention keep their place at the end. A prefab that gains a piece therefore does not invalidate an order
a placement recorded before that piece existed.

**Two ops**: `insertOverrideChild` and `setOverrideChildOrder`. Removing an added child needs none —
`removeNode` finds it.

**ADR 0130's root case is now the root's case of this.** `placementAdded` asks the whole subtree for nodes
this document authored whose parent is a piece or the placement, and Apply inserts each under the piece it
hangs from rather than always the prefab's root.

## The checklist this exists to satisfy

Against a prefab's piece, in the Hierarchy: move, rename, edit components, add and remove components,
disable, delete, copy, duplicate, cut, drag out, **take a child**, **reorder its children**, **be reordered
among its siblings**, and **be dropped into**. All recorded on the placement; all revertable; all appliable.

What a piece still cannot be is a node of another document — it has no identity outside its prefab, and
every operation above says what it does in terms of the placement that shows it.

## Rejected

- **Keeping ADR 0130's storage and adding a second mechanism for depth.** Two ways to say one thing, and the
  root would keep behaving differently from everywhere else for no reason a user could see.
- **Ordering added children by a rule rather than an explicit list.** They interleave with inherited ones;
  no rule that does not name every child can put them in an arbitrary order.
- **Teaching `insertNode` to take a piece as its parent** instead of a new op. `insertNode`'s parent is
  resolved by `find` in the level's scope, and a piece is not in it; the op would have to carry the
  placement as well, which is `insertOverrideChild` with a worse name.
