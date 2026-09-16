# ADR 0113 — A reparent is one edit, and a step is not a constraint

Status: accepted. Two bugs found together, with one cause in common: an edit that reaches the document by two
routes when the user made one gesture. Amends [ADR 0031](0031-multi-selection-with-a-primary.md)'s reparent and
[ADR 0024](0024-editor-ui-shell.md)'s use of Tweakpane.

## Context

Kodjo reparented two objects into a third, moved the parent, and pressed Ctrl+Z. The parent went back. One
child followed it. **The other jumped by the parent's whole transform.** Separately, he could not type a round
number into a scale field: at 32.98, typing 32.99 or 33 gave back 32.98 and typing 33.01 gave 33.03.

His level carried the damage: a wrapper at `scale (0.9825, 1.0185, 1.0116)` that should be 1, a child at
`(32.9825, 0.3185, 33.0116)` whose untouched sibling reads `(33.3, 0.3, 33.3)`, and a rotation of `-0.0004`
that nobody typed.

## Bug 1 — the reparent was two edits

```js
const landed = doc.reparent(from, parent, at)   // commits moveNode
recordEdit('reparent')                           // closes the history entry HERE
doc.setTransform(landed, reframed)               // commits the re-expressed transform
```

Preserving the world pose — what a hierarchy drag does, Unity's behaviour, and what Kodjo wants — means the
stored **local** numbers must change: a child under a parent scaled 0.98 needs a local scale of 33.98 to stay
33.3 in the world. That re-expression was a second commit, made after `recordEdit` had already drained the
pending op list. So it landed in the *next* history entry:

| Gesture | Entry recorded | Left pending |
|---|---|---|
| reparent A | `[moveNode A]` | `setTransform A` |
| reparent B | `[setTransform A, moveNode B]` | `setTransform B` |
| move the parent | `[setTransform B, move parent]` | — |

One Ctrl+Z then undid the parent's move *and* B's re-expression, so B was given its pre-reparent local
transform while still a child — offset by the parent's entire transform. A's re-expression was in an earlier
entry and survived, which is why one child was fine and the other was not.

**Decision: `Doc.reparent` takes the new local transform and commits `moveNode` + `setTransform` as one
batch.** `applyBatch` inverts as it goes and reverses the inverses, so undo restores the transform and then
the parent link. One undo entry, and one message to the room instead of a move followed by a correction.

The bug was the shape: one user action reached the document as two edits and the history believed it. A sweep
found no other site committing after `recordEdit`.

## Bug 2 — `step` is a constraint, not a speed

Tweakpane's `step` does two jobs and they cannot be separated:

```js
// @tweakpane/core, common/number/util.js
return new StepConstraint(params.step, initialValue)
// common/constraint/step.js
const o = this.origin % this.step
return o + Math.round((value - o) / this.step) * this.step
```

The grid is anchored to **whatever the field showed when it was built**. A scale field built at 32.98 with
`step: 0.05` admits only `32.98 ± n × 0.05`, so 33 is unreachable — silently, with nothing in the console.
Once a gizmo drag or bug 1 had left an off-grid value in a field, no round number could be typed back.

**Decision: a transform or a size has a continuous domain, so nothing may be unreachable.** `dragSpeed(n)`
returns `{ pointerScale: n }` — the pointer-drag increment, which is the half of `step` that was actually
wanted — and every numeric field in the object-editing path uses it: position, rotation, scale, vec3
parameters, collider dimensions, and any declared `number` step. There is no trade-off: `pointerScale` is an
independent parameter, so the drag feel is unchanged.

The sliders in the Environment and Network sections still pass `step`. They are bounded by `min`/`max` and
snapping is a defensible choice for a slider, so they are left alone deliberately rather than by omission.

## What was rejected, and what was withdrawn

- **Detecting shear on reparent and refusing the drop.** `Matrix4.decompose` cannot represent a sheared matrix,
  so a non-uniform parent scale with an *off-axis* rotation has no exact answer in position/Euler/scale. Real,
  but it is exact at the 90° rotations the content actually uses, it was never shown to have caused any of
  this, and refusing a drop leaves someone unable to put an object in the group they want. Not built.
- **Removing `r4` rounding from `localInside`.** ±0.00005, invisible, and it cannot explain a 0.3 discrepancy.
  It was suspected because it sat in the code path, which is not a reason.
- **The `-0.0004` rotation** was blamed on a quaternion→Euler round trip. Too large for float error on that
  matrix, and in a clean no-rotation case the quaternion comes back exactly identity and `isZeroRot` omits the
  rotation. It is most likely bug 1's corruption; if stray rotations survive this fix, that is a fresh lead
  rather than something to paper over.
