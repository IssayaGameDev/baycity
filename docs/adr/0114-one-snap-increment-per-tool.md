# ADR 0114 — One snap increment per tool, and rotation snaps absolutely

Status: accepted. Completes the snapping of [ADR 0023](0023-authoring-content.md)'s editor; the second half is
the same fault [ADR 0113](0113-a-reparent-is-one-edit.md) found in Tweakpane, in a different library.

## Context

Kodjo asked for snapping on scale and rotation, saying it worked for translation only. Measured: **all three
were already on.**

```js
gizmo.setTranslationSnap(edit.snap ? edit.step : null)   // the toolbar's number
gizmo.setRotationSnap(edit.snap ? degToRad(15) : null)   // hardcoded
gizmo.setScaleSnap(edit.snap ? 0.1 : null)               // hardcoded
```

Two reasons it did not feel like it:

- **The toolbar's number drove translation only.** Rotation and scale were fixed at 15° and 0.1, written
  nowhere and adjustable nowhere, so the one visible control appeared to do nothing for them.
- **Rotation snapped the turn, not the angle.** `TransformControls` rounds `rotationAngle` — how far the drag
  has travelled — so a round *amount* is added to whatever angle the object already had. An object at 22° with
  a 15° increment goes to 37°, never to 15° or 30°. A grid anchored to where you started, which means snapping
  can never straighten anything. The same fault as Tweakpane's `step` (ADR 0113), in a different library, found
  a day apart.

## Decision

**Three increments, one per tool**, with sensible bounds and units:

| Tool | Default | Range | Unit |
|---|---|---|---|
| Move | 0.5 | 0.05–10 | m |
| Rotate | 15 | 1–90 | ° |
| Scale | 0.1 | 0.05–5 | × |

One number cannot serve three: 0.5 is a good grid in metres, useless in degrees, coarse for scale. Unity and
Blender both keep three.

**The toolbar still shows one field** — the active tool's, with its unit beside it and its own min/max/grain.
Switching tool switches which of the three the field edits. Three fields side by side would widen a toolbar
that already carries the tool buttons, the space toggle, Motion, Play, grid and markers, to show two numbers
that are not in use.

**Rotation snaps absolutely**, in `snapRotation` on `objectChange`, before the write-back and before
`mirrorDragToSelection` — so the document and the other selected items see the snapped angle rather than the
raw one. `setRotationSnap(null)` hands the job over.

Per Euler axis, because a gizmo drag turns about one ring and rounding the other two changes nothing. About
the free-rotate ring, a camera-facing axis, it is an approximation — predictable, and the price of landing on
round angles at all.

**Only the primary is snapped.** `mirrorDragToSelection` gives the others its *delta*, which keeps a group's
relative angles and is exactly what translation already does, where three snaps the primary and the rest
follow.

The arithmetic lives in `tools/editor/src/snap.ts`, pure and tested, rather than inline in the composition
root: "which values can this land on" is the part worth being sure about, and it is the question both of this
week's bugs turned on. The placement grid uses the same `snapToGrid`.

## Rejected

- **Three fields in the toolbar at once.** Two of them always irrelevant, in the most crowded row of the UI.
- **Keeping three's incremental rotation snap.** It cannot reach a round angle from an off-grid one, which is
  most of what snapping is for.
- **Snapping every selected object's rotation to its own grid.** Flattens the relative angles of a group, and
  disagrees with how translation behaves.
- **Snapping the orientation as a whole** rather than per Euler axis. Better about an arbitrary axis, worse
  about the rings people actually drag, and considerably more to reason about.
