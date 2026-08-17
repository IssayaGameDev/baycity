# ADR 0017 — Convex colliders for authored swept surfaces

## Context

ADR 0014 locked gameplay colliders to primitives — box, ball, capsule, cylinder — with the rule
"never a trimesh from the art mesh". The reasoning holds: the kinematic character controller wants
crisp cheap shapes, and keeping collision primitive is what lets the visual layer be swapped for art
without touching gameplay.

Curved walkways broke it. A beam following an arc was first built as a chain of boxes rotated onto
the tangent, and that is not an approximation that improves with subdivision — it is the wrong shape.
A segment swept along a curve has end faces perpendicular to the tangent at each end, so **the two
end faces are not parallel**. A box's ends are parallel by definition. A box chain therefore meets at
an angle at every join and leaves a notch, which has to be papered over by making the boxes overlap
(the first implementation used arc length instead of chord length to force overlap). Subdividing
shrinks the notches without ever removing them, and the overlap fudge means the surface geometry no
longer matches the arc anywhere.

Rapier offers more than primitives: `convexHull`, `convexMesh`, `roundConvexHull`, `trimesh`.

## Choice

`ColliderDesc` gains `{ kind: 'convex'; points }`, wired to Rapier's `convexHull`, and the renderer
builds its mesh from **the same points**.

A swept segment is emitted as a convex prism through its eight exact corners. Neighbouring prisms
share their four end-face corners, so the chain is watertight by construction — no notches, no
overlap fudge. Because collider and mesh come from one description, they cannot drift apart, and
subdivision density is a single knob that sharpens collision and smooths the silhouette together.

Subdivision is bounded by two limits at once: surface deviation from the true arc (4 mm — what you
feel underfoot, and it needs finer steps as radius *grows*) and angle between neighbouring faces (4°
— what you see, and it needs finer steps as radius *shrinks*). Taking the smaller of the two satisfies
both at any radius.

Scale bakes into convex points exactly, unlike the lossy ball/capsule approximation.

## Why this does not reverse ADR 0014

ADR 0014's target was using an *art* mesh as collision — an artist's triangle soup, arbitrary,
dense, non-convex, and coupled to how the thing looks. These hulls are authored geometry: generated
from curve parameters, convex, eight points, and cheap to query. Collision stays crisp and stays
independent of any future art pass. The rule against art-mesh collision is unchanged.

## Rejected

**Box chain (what was there).** Cannot express the shape at any subdivision; needs overlap to hide
its own notches; surface never matches the arc.

**Single trimesh per beam.** Exact and one collider instead of many, but a trimesh has no interior:
a capsule that ends up inside it falls through, and Rapier's own guidance warns against trimesh under
a character controller. Rejected on robustness.

**Smooth mesh over a box collider.** Would have looked right and collided wrong — the surface you
stand on would still not be the surface you see. Rejected because it puts the discrepancy somewhere
harder to notice rather than removing it.

**`roundConvexHull`.** Exact plus rounded edges, at slightly more cost. Nothing currently wants
rounded edges; available if a piece ever does.

## Consequences

- `@mp/physics` `ShapeDesc` gains `convex`; `convexHull` returns null on degenerate input (fewer
  than four points, coplanar, coincident), which the wrapper turns into a thrown error rather than a
  silently missing collider.
- `@mp/render-three` `geometryForCollider` builds convex geometry via `ConvexGeometry`
  (`three/examples/jsm`, the same source already used for OrbitControls and TransformControls).
- A hairpin costs more colliders than a box chain would (45 for 180° at r=4 m, all static fixed
  bodies). Budget 1 is unaffected at this scale, but a level made mostly of tight curves should be
  measured rather than assumed.
- The editor's palette has no convex primitive; curved pieces are placed through generators, and its
  inspector cannot reshape them.
