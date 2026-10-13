# ADR 0219 — A reference can point into a placement

Status: accepted. Kodjo's call: a level node points inside a prefab placement, as Unity allows — logged open by
ADR 0211, where the Obstacle had to sit on the InterLevel prefab's root to reach its pad, trigger and texts.

## Context

A placement's pieces carry its prefab's ids, the same in every placement of that prefab, and each placement resolves
them in a scope of its own (stage C4). A plain id from the level could not say which placement's piece it meant, so the
editor never offered one and the loader would not find it.

## Decision

- **`<placement id>/<node id>`** in a `nodeRef`, and in a `componentRef`'s `node` (`refPath.ts`): the placement found as a
  plain id is, then the node by its prefab id in the scope that placement opens; the prefab's root id names the
  placement. A plain id means what it did; the editor's ids hold no `/`. From the level or from another placement.
- **The editor stores the plain id wherever it reaches** and the path only for a piece of another placement; the field
  and the picker name it `Placement › Piece`.
- **Every edit that re-ids keeps it naming the same object**, in the same batch (Kodjo's call, option A): unlinking a
  placement (one, or every placement of a deleted prefab, open or closed) points it at the unlinked object; Save as
  prefab turns a reference from outside to an object now inside into a path; a duplicate or paste of a placement with
  what points into it points the copy into the copy.

## Rejected

- **A structured `{ placement, node }` value**: a second shape for every reader of a reference; a path is a string
  where a string was.
- **Rewriting on Unlink and Save as prefab later**: unlinking an InterLevel would quietly cut an Obstacle off from its pad.

## Not covered

- Dragging a piece out of its placement (ADR 0133) lands a copy with fresh ids and records the piece removed: a
  reference into it then names a removed piece and shows missing.
