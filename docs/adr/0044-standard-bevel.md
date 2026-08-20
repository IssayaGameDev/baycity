# ADR 0044 — Code-generated boxes are rounded cuboids at one standard radius

## Context

Every solid in a level is a primitive: `geometryForCollider` turned a `box` collider into a `THREE.BoxGeometry`
and that was the whole visual answer for anything without a model. Hard 90-degree edges everywhere. The
character rig had already gone the other way — `RoundedBoxGeometry` at a 0.03 m corner radius since it was
written — so the player was made of softer stuff than the world it stood on.

Rounding the world's boxes closes that gap. Two shapes were on the table:

- a **rounded cuboid**: flat faces, circular-arc edges;
- a **squircle** (superellipse): continuous curvature, no flat face anywhere.

## Decision

**Rounded cuboid**, at **one constant radius in world units**, applied wherever the renderer generates box
geometry — level solids, editor previews, asset thumbnails, and the character rig.

`BEVEL_RADIUS = 0.03` in `packages/render-three/src/materials.ts`, alongside `BEVEL_SEGMENTS`. The character
rig's `cornerRadius` option now defaults to it, so the number is standardized in the literal sense: one
constant, one place, world and player together.

**Constant, not proportional.** A radius that scaled with the object would round a 40 m floor and a 0.3 m step
by wildly different amounts, and the eye reads a constant highlight width as one material. The cost is that the
bevel is proportionally invisible on very large solids. Accepted; that is what "the same material at any size"
looks like.

**`MAX_BEVEL_FRACTION = 0.25` caps the radius at a quarter of the shortest side.** Three clamps a rounded box's
radius at *half* the shortest side, and half is exactly where the flat face disappears and a thin plate becomes
a pill. A quarter leaves half of every face flat, so a 0.06 m plate still reads as a plate. This is what makes
`BEVEL_RADIUS` safe to raise without silently turning thin walls into tubes. `bevelFor(sx, sy, sz, wanted?)` is
the single rule; the rig uses it too.

**Colliders are unchanged.** Rapier still gets exact cuboids. The bevel is cut inward, so the drawn mesh has
the same bounding box as the collider and solids still meet flush — but a character can stand on a sliver of
apparent air at a corner. Imperceptible at 0.03 m; a reason not to raise the constant past roughly 0.2 m.

**Outlines are built from the sharp shape.** `outlineGeometryForCollider` returns the unbeveled primitive.
`EdgesGeometry` keeps every seam whose faces differ by more than a degree, and a rounded box's subdivisions all
qualify, so the viewer's collider x-ray would have come out as hatching instead of twelve lines. It also
happens to be the honest picture: the collider *is* a hard box.

## Rejected

**Squircle / superellipse.** A continuously curved surface has no flat face, so a platform you stand on is
subtly domed and two solids placed edge to edge never meet flush. It also needs a hand-written generator with
its own UV and normal derivation, where `RoundedBoxGeometry` already ships with the pinned Three and was
already in use by the rig. Wrong shape for a parkour game made of platforms.

**Radius as a `Renderer` parameter.** Would make the bevel authorable per node, which is a second styling
system next to material assets — the exact mistake `STYLE_PALETTE` was (ADR 0028). The bevel is not a choice a
level author makes; it is what the game is made of.

**Clamping at Three's own half-the-shortest-side limit.** Free, and quietly destroys thin geometry as soon as
the constant moves. A guard that only holds at one value of the number it guards is not a guard.

## Consequences

- A beveled box is non-indexed and about 900 vertices, against 24 indexed. Level geometry is not cached or
  instanced (one `BufferGeometry` per visual, `levelView.ts`), so a 200-solid level goes from ~5k to ~180k
  vertices. Fine for WebGL2 at this scale; the draw-call count, which is the actual cost, is unchanged. If it
  ever matters, cache geometry by size — the fix is a map, not a redesign.
- Convex hull colliders (ADR 0017) stay sharp. They are a point cloud, not a box, and nothing rounds them.
- Models loaded from `content/assets/models/` are unaffected; they bring their own geometry.
