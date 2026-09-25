# ADR 0094 — The viewport has a navigation gizmo, and an isometric camera behind it

Status: accepted, amended by ADR 0149: the balls became Unity's cones round a cube, the parts light up under
the pointer and answer past their drawn shapes, and the Persp / Iso label is a button of its own.

## Context

The editor viewport had orbit, pan and zoom and nothing else. No way to get a straight side, top or front
view, and no way to draw without perspective — which is what you want when you are lining pieces up, because
perspective makes two things at different depths look misaligned when they are not.

Kodjo asked for the gizmo every DCC tool has, in the top-right corner, and asked for research on how Blender
and Unity do it before anything was built.

**Blender.** Ball-and-stick: three sticks, six balls, positive axes filled and lettered, negative hollow. Click
a ball to look down that axis. Drag the gizmo to orbit. Orthographic is a **separate button** below. A
preference, *Auto Perspective*, on by default, switches to orthographic when you snap to an axis and back when
you orbit away.

**Unity.** A small cube with six coloured cones. Click a cone to snap. Click the **centre cube** to toggle
perspective and isometric, with a `Persp` / `Iso` label underneath. Shift-click a cone does both at once.

Unity's "Isometric" means orthographic projection, not the 30-degree angle the word means in drawing. Both
tools mean the same thing by different names.

## Decision

Kodjo chose, one from each and one against both:

- **Blender's shape.** Ball-and-stick reads better small, and the letters say which axis without learning
  three colours. Negative axes are clickable directly instead of needing an orbit first.
- **Unity's centre.** Click the middle of the gizmo to toggle isometric, with the label under it. One target
  instead of a button stack, and the label means the projection is never a mystery.
- **No auto-switch.** Snapping to an axis does **not** change the projection. Looking from the side and
  drawing without perspective are two decisions, and *Auto Perspective* is the Blender default people turn off
  first — the projection changing under you when you only wanted to look from the side.

**A second camera, not a changed stage.** `stage.camera` stays the `PerspectiveCamera` and stays the game's:
play-in-place hands it to `createOrbitCamera`, which tunes its `fov`. The editor owns an `OrthographicCamera`
beside it and swaps which one is looked through. So `@mp/render-three` and every game are untouched, and play
forces perspective back on the way in.

## How the swap works

Everything that holds a camera is **re-pointed, not rebuilt**: `OrbitControls.object`, `TransformControls.camera`
(both plain settable properties that are read per call and already branch on `isOrthographicCamera`), and the
post-FX passes through a new `PostFX.setCamera`. Rebuilding the composer instead would throw away the AO and
bloom the open level asked for.

The view is preserved across the swap. Going orthographic, the frustum half-height is
`distance × tan(fov/2)`, so both cameras show the same thing at the orbit target and the toggle reads as the
perspective draining out rather than a jump. Coming back, the distance is recovered from the frustum, since an
orthographic camera has no distance of its own.

`focusSelection` needed an orthographic branch: there is no `fov` to frame with, so the frustum does the
framing and the distance only has to clear the geometry.

## The gizmo takes the pointer first

`document`, capture phase, `stopPropagation`. `OrbitControls`, the selection click and the context menu all
listen on the canvas itself, and listeners on one element fire in the order they were added — so from the
canvas there is no way to get in front of them. Capturing on an ancestor is, and the event then never reaches
the canvas at all.

A press becomes an orbit drag past 4 px, wherever it started, so dragging from a ball orbits (as Blender does)
and a click on a ball still snaps.

## Rejected

- **`three/examples/jsm/helpers/ViewHelper`**, which is the same idea and already in `node_modules`. It draws
  **bottom**-right from a hard-coded viewport, has no drag-to-orbit and has no centre. Both of the two methods
  that matter would have been replaced, so ours borrows its proven parts — the inverted camera quaternion, the
  sprite balls, the scratch orthographic camera — and owns the rest.
- **Faking isometric with a long lens** (tiny fov, large distance). No refactor at all, and wrong: the
  vanishing point only recedes, clipping planes go strange, and the transform gizmo's screen-space sizing
  breaks.
- **Widening `ThreeStage.camera` to a union.** It would have reached every game, for an editor feature.
- **Shift-click a ball for axis-and-isometric together.** Unity has it; not asked for, and the explicit toggle
  covers it in two clicks.
- **A DOM label instead of a sprite.** Crisper, and it would couple the gizmo to the editor's panel layout and
  stylesheet for one word.

## Consequences

- `PostFX` gained `setCamera`. It is the only way a consumer can swap cameras without losing pass state.
- Play-in-place forces perspective on entry. The editor returns to whatever projection it was in afterwards.
- The orthographic frustum is re-cut on canvas resize; `stage.resize` only knows the perspective camera.
- The gizmo is not drawn during play, where the viewport belongs to the game.
- `gizmoPointer` and `orbitAround` are exported pure functions with tests. The rest is WebGL and a DOM canvas,
  which the editor's tests do not have — the codebase tests the arithmetic and leaves the drawing to the eye.
