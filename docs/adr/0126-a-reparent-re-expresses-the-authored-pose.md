# ADR 0126 — A reparent re-expresses the authored pose

Status: accepted. Closes a hole in ADR 0050's rule that a write-back subtracts the motion offset.

## Context

Objects with a `Mover` or `Spinner` sometimes came out of the preview **actually moved** — not drawn in the
wrong place, moved: the new position survived a reload, because it had been written to the file.

Every write path that turns a scene group back into a stored transform subtracts what the motion contributed
(`writeBackItem` → `motionOffsetAt`, ADR 0050). One did not. `onReparent` re-expresses the dragged node's world
pose in its new parent's frame, and it reads that pose off the **scene graph**:

```ts
const local = localInside(meshes.groupAt(from), meshes.groupAt(parent))
```

`localInside` composes `parent⁻¹ · child` from `matrixWorld`, which is the right place to read a world pose
from and the wrong pose to read. The groups hold the authored transform **plus** the motion offset — while the
preview clock runs, and also at rest for any mover with a phase `offset`, which is drawn partway along its
travel because that is where the game starts it (measured: `offset: 0.5` on a 10 m travel is drawn 10 m away
at t = 0).

So a reparent stored the animation's current position as the node's authored transform. Silent, permanent, and
invisible in the Inspector — which reads the group too, so it showed the same wrong number and agreed with
itself.

It could not be fixed the way the others are. `motionOffsetAt` gives the offset in the **old** parent's frame,
and the value being computed is in the **new** one; subtracting it afterwards is a different composition, not a
subtraction.

## Decision

**Read the authored poses for that one read.** `motion.withAuthoredPoses(read)` poses every group from
`Doc.transformOf` — no motion, whatever the clock says — runs `read`, and restores the preview poses in a
`finally`, so a throw cannot leave the viewport frozen.

`onReparent` wraps its `localInside` call in it. Nothing else changes: the scene graph is still where the
composed matrices come from, and the reparent still preserves the world pose, as dragging in Unity's hierarchy
does.

**Authored is not "time zero".** A phase-offset mover at t = 0 is partway along its travel, and that is
correct for the preview — the editor draws where the game starts it. Authored is where the document says the
object *is*, which is the only thing a reparent should re-express.

Only one write path reads a world matrix, so only one call site needed this. `snapTranslation` also decomposes
`matrixWorld`, but it feeds the gizmo's own position and reaches the document through `writeBackItem`, which
compensates.

## Rejected

- **Stop the preview when a reparent starts**, as `startPlay` does. Correct and heavy-handed: the clock stops
  because you dragged something, and it would not help the phase-offset case, where the groups are off the
  authored pose with the clock at rest.
- **Subtract the offset from the result.** It is in the wrong frame, as above. Composing it into the new frame
  is re-deriving what posing authored already gives for free.
- **Compose the authored world matrix from the document** instead of borrowing the scene graph. No temporary
  re-pose, and a second implementation of the transform chain — which is the fault ADR 0113, 0114, 0117, 0119,
  0120 and 0125 were each an instance of.
