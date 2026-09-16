# ADR 0119 — A face is a handle

Status: accepted. A fourth transform tool beside ADR 0031's three; uses ADR 0090's rule that a built-in's
scale is its size, and ADR 0117's grid.

## Context

Kodjo builds rooms out of boxes — floor, walls, ceiling, tunnels, floating platforms — and wants SketchUp's
push/pull, or ProBuilder's: grab a face, drag it, and have the box grow that way.

The scale tool cannot do it. It grows a box about its **centre**, so both faces move and a wall butted against
a floor edge comes away from it. Getting one face to move meant editing the scale and then the position by
half of it, by hand, in the Inspector.

## Decision

**A fourth tool, `Face`.** With it active, hovering the selected box lights the face under the pointer and
dragging moves that face along its own normal. The opposite face does not move.

The face **is** the handle — SketchUp's model. ProBuilder makes you click a face to select it first; that step
is skipped, because a face is a big target and there is nothing else to aim at. There is no keyboard shortcut,
Kodjo's call: the letters worth having are taken.

Not a `TransformControls` mode — three knows only the three it draws — so the gizmo detaches while `Face` is
active and the canvas runs its own drag: press claims the pointer and suspends orbit, move applies, release
records.

**A pull changes size *and* position.** A box is a centre plus a size, so growing one side by `d` grows the
size by `d` and moves the centre by `d / 2`. The Inspector's numbers therefore both change when you touched
one side, which is correct and was checked with Kodjo before building.

| Piece | Where |
|---|---|
| which face a hit normal names | `faceFromNormal` — largest component wins, so a **rounded** box's fillets resolve to the face they belong to |
| how far the pointer dragged | `distanceAlongAxis` — nearest point on the face's normal line to the pointer ray, as a single-axis gizmo handle does. `null` looking straight down the axis, where the caller holds its last value rather than jumping |
| where the face lands | `snappedPull` — snaps the face's **plane offset along its own normal**, not the distance dragged. For an axis-aligned box that is its world x, y or z; rotated, it is a grid of parallel planes |
| the resulting transform | `pulled` — clamped so a box never inverts, and the clamp applies to the *size* so the far face stays put even when a pull is refused partway |

All four are pure and tested (`facePull.ts`), because they are the parts worth being sure about.

**Built-in box and rounded box only.** For those, scale is the whole size — the collider sits at the unit
shape and scale bakes in (ADR 0090) — so a pull is a transform edit and nothing else. An authored collider
would need its half-extents edited too, and a sphere has no faces.

**Snapping the plane, not the movement**, for the third time now: ADR 0113, ADR 0114 and ADR 0117 were each a
grid anchored to where something already was. A face can be brought *onto* the grid from off it.

One history entry per drag, coalesced like a gizmo drag, so undo is one press and the room gets one message.

## Rejected

- **Six small handles on the face centres.** Something to aim at, for no gain over the face itself, and they
  would need hiding on the faces pointing away from the camera.
- **Hover any box, not just the selected one.** A stray drag could then reshape something you were not working
  on, and the highlight would follow the pointer around the level.
- **Edge and corner pulls.** Two axes at once, and a different question about what stays anchored.
- **A modifier on the Move tool** instead of a fourth tool. Cheaper in UI, but it hides the mode and makes the
  per-tool snap increment (ADR 0114) ambiguous — a pull wants metres, and Move already has metres, so the two
  would share one number for two jobs.
