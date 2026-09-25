# ADR 0130 — A child added to a placement can be applied

Status: accepted. Extends [ADR 0122](0122-revert-and-apply-have-two-scopes.md)'s placement-scope Revert and
Apply to a fourth kind of difference. Nothing about overrides on existing pieces changes. Its storage is
superseded by ADR 0151: an added child is kept in the record of the prefab's root, and the placement's own
`children` are read until the migration moves them.

## Context

A placement's children are the prefab's, resolved (ADR 0091). Dropping a node onto a placement in the
Hierarchy was already allowed, and the node became the **level's** own child sitting beside the borrowed
ones. Nothing was wrong with that on its own — the Hierarchy already styles inherited rows differently, so
which children are yours is visible.

The dead end was that there was no way out of it. The override record holds a changed transform, a changed
name, changed component parameters, a disabled component, a removed component and an *added component*. It
has no shape for an added child node. So Apply could not carry one, the Inspector strip read "matches the
prefab" beside a child you had just dropped on, and the only route into the prefab was to delete the work and
redo it inside the prefab's own room.

Kodjo asked for the obvious thing: put a node inside a placed prefab, then apply it, and the prefab has it.
That is Unity's *Added GameObject* — a first-class override kind alongside modified properties, added
components and removed components.

## Decision

**An added child is a difference from the prefab, carried by the same Revert and Apply as the overrides.**

`Doc.placementAdded(i)` answers which children the level added under a placement. It is asked separately from
`placementOverrides` rather than folded into it, because an added child has no override record to report
fields from and the two would have to be told apart again at every call site.

| | |
|---|---|
| **Apply** | `insertNode` on the prefab's root, appended after the pieces it already has, in the same submission as the overrides — so a partial failure cannot half-apply |
| **Revert** | deletes it. Reverting means looking like the prefab, and the prefab has no such child. Unity does the same, and one Ctrl+Z puts it back |
| ids | re-minted. A prefab's node ids are scoped to itself, and the level keeps its copy until the revert that follows a successful submit |
| transform | unconverted. A child of the placement and a child of the prefab's root are in the same frame |
| after applying | the local copy is removed and the prefab's echo brings it back inherited, so it never shows twice |

**Direct children only.** A child of an added child travels inside it as part of one `insertNode`.

## Limits

**A placement dropped onto a placement is not offered.** Applying it would put a prefab reference inside a
prefab, whose definition would then have to resolve in the prefab's own room — and ADR 0124's rule that a
resolved definition never reaches disk has not been worked through for that case. `placementAdded` skips it,
so Apply neither carries it nor claims to. The node stays where it is, level-owned, as before.

**And the count does not see it either**, which is the sharp edge: with a nested placement as the only
difference, the Inspector strip reads *"matches the prefab"* beside an object visibly sitting inside it. A
plain child counts, a prefab child does not, and nothing on screen says which one you have. Before this ADR
that was at least consistent — nothing counted — so this is a wart introduced here and left knowingly rather
than fixed by refusing the drop, which would take away a placement people already make.

**Unity has neither limit.** It treats a prefab dropped on a prefab as an ordinary added GameObject, and
applying it produces a real nested prefab — the outer asset *references* the inner one, so edits to the inner
still propagate. Closing that gap is nested-prefab support, a feature of its own and not this one.

**Nothing marks an added child as pending** beyond the Inspector strip's count and the menu hint. Unity puts
a `+` badge on the row. Here the Hierarchy already styles inherited rows differently, so an added child looks
like what it is — a normal child — and the badge was not added for a distinction that is already drawn.

## Rejected

- **Refusing the drop instead.** The cheaper answer, and it throws away the gesture everyone reaches for.
- **Leaving it alone on Revert.** Then Revert does not revert, and the count in the strip has to explain why
  one of the things it counted is still there.
- **A new override record kind for added children.** The node is already stored — as a plain child of the
  placement. A second copy inside an override record would be two sources for one thing.
- **Applying on the drop, with no explicit Apply.** Editing one placement would silently change every other
  one, which is the surprise the whole Revert/Apply pair exists to prevent.
