# ADR 0090 — A shape is a built-in mesh, sized by the object's scale

Status: accepted, amended: a built-in is now a `Renderer`'s `model`, the `Mesh` having folded into it ([ADR 0153](0153-one-mesh-renderer.md)).

## Context

A platform was a `Collider` with half extents plus a `Renderer`; the drawn shape came from the collider, and
`Mesh` existed only for uploaded `.glb` files. Two consequences, both reported from use:

- **A shape could not be authored as a mesh.** With no `.glb` uploaded, the `Mesh` picker was empty, and the
  rounded box every platform is drawn as was unreachable: it lived in `geometryForCollider`, not in content.
  Two different mental models — colliders for greybox pieces, meshes for art — for the same question, "what
  does this draw".
- **Size lived in two places that multiply.** `Transform.scale` and `Collider.shape.halfExtents` are both real
  and only their product is; the loader bakes the scale into the collider. A board reading `scale 3.3, 0.3, 1`
  in the Inspector was in fact 24.75 m long, because its half extents were 3.75 × 0.25 × 3. Rotating it looked
  like a bug and was not.

## Decision

**`Mesh.model` takes a built-in shape id.** `packages/content/src/primitives.ts` declares four:
`builtin:box`, `builtin:rounded-box`, `builtin:sphere`, `builtin:capsule`. They sit in the same slot as an
uploaded model's asset id, so the picker lists them beside the files and every reader tells them apart by the
`builtin:` prefix (`isBuiltinModel`).

**Scale is the size.** A built-in draws its unit shape (`unitColliderFor`) multiplied by the node's world
scale (`builtinShape`), and the editor holds the node's colliders at that same unit shape: picking a built-in
rewrites them, a collider added later is born unit, and the Inspector replaces the shape fields with a line
saying the size is the object's scale. One number to read and to edit; collision follows, because the loader
already bakes scale into colliders.

**Everything is drawn at final size.** `geometryForBuiltin(id, worldScale)` builds from the scaled dimensions,
and the editor viewport and the Project previews now do the same for ordinary colliders: the mesh holder
counter-scales, and each shape is built with `scaleCollider(shape, worldScale)`. So a bevel is computed on the
real size, in the game and in the editor alike — before this the editor stretched it with the scale.

**Creation is one click.** The Create menu (viewport, Hierarchy, blank space) offers Box, Rounded box,
Platform, Wall, Sphere, Capsule; each is a unit collider, the `Mesh`, an unsurfaced `Renderer`, and a preset
scale (`PRIMITIVE_PRESETS`). The prefab palette offers the same six. `Create empty` is still there, under
`Empty`.

**Existing content is migrated once.** `migratePrimitives.ts` (library) and
`deploy/editor/migrate-primitives.sh` (on the box, editor stopped, one commit on `content`) move each drawn
box or ball's size into its scale and add the matching built-in. Left alone, and named in the report: a node
with children (its scale is its children's too), a capsule (no unit capsule expresses every height-to-radius
ratio), a node with several colliders, and a prefab node some placement overrides (the override is written
against the old numbers). Verified over the real content: 119 nodes moved, 131 colliders checked, every baked
collider, drawn shape and scaled centre identical.

## Rejected

- **A `shape` source on `Mesh` ("from collider")** — a label on the old behaviour. Unified the UX and left the
  two-sizes trap open, so the reported bug would have survived it.
- **Built-ins scaled by the collider, not the transform** — that is what already existed.
- **A collider free to differ from the built-in** (Unity's arrangement). Kodjo chose locked: the trap this ADR
  exists to close is exactly two sizes that multiply.
- **A `builtin:cylinder`** — the physics side does not take a cylinder (`toShape` throws), so it could not
  collide as what it draws.
- **Migrating a node with children by re-scaling and counter-scaling the children** — a rotated child under a
  non-uniform scale is a shear no transform can express.

## Consequences

- `VisualItem` carries `scale` (the node's world scale), since a built-in needs it to be drawn.
- `scaleCollider` moved out of the loader into `primitives.ts`, shared by the loader and both renderers, so
  what is drawn and what is collided with are one computation.
- A node whose `Mesh` names a built-in ignores how many colliders it has for drawing: one shape per node.
- `board-start` in `keyboard.json` and one other node both draw and parent, so the migration leaves them with
  two sizes. Restructuring them (the shape in a child) is authoring, not migration.
- Capsule pieces keep their half-height and radius on the collider; only new capsules are unit.
