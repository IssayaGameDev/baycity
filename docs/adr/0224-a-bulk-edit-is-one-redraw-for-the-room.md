# ADR 0224 — A bulk edit is one redraw for the room

Status: accepted. Amends ADR 0134 (a drag's one message to the room, which it was not) and ADR 0167 (when a remote
batch redraws).

## Context

Three people in one level; one drops 50 objects onto another in the Hierarchy. Every other editor froze for a minute
or two, then caught up. `onReparent` moved them one `Doc.reparent` at a time, and each was its own batch to the room:
`recordEdit` folded them into one history entry, never into one send. Each batch a receiver took was a structural op,
so `repaintAfterOps` rebuilt everything: every mesh, the physics world, the Hierarchy and the Inspector. Fifty batches,
fifty full rebuilds, a second or more each on a big level. The sender rebuilt once, at the end, and barely noticed.

## Decision

- **A Hierarchy drop is one batch**: `onReparent` runs its moves between `edits.beginDrag()` and `endDrag(label)`, as a
  gizmo drag does, the `endDrag` in a `finally` so a throw still sends what moved.
- **A receiver redraws once a frame** (`createFrameQueue`, `remoteRepaint.ts`): `onApplied` queues its ops, and the
  next `requestAnimationFrame` repaints them all in one `repaintAfterOps`. The data is applied as each batch lands; only
  the redraw waits. A burst that arrives while a rebuild runs is one more rebuild, not one per batch; a hidden tab
  redraws when it shows. Leaving the room or a snapshot's reinstall drops the queue. Undo, a refusal and a drag's end
  still repaint at once.

## Rejected

- **Sending at `recordEdit` for every edit**: one place for every multi-object action, but any commit not followed by a
  record would never reach the room.
- **A rebuild that patches instead**: the depth-first indices are the identity of meshes and selection, and a reparent
  renumbers them (ADR 0167).
