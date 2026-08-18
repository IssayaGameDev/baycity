# ADR 0025 — Instances nest to arbitrary depth; the loader composes a frame tree

Status: accepted. Rewrites the core of `instantiateLevel` (ADR 0014's loader). Closes the open item ADR
0023 recorded. Does not change the wire (ADR 0021).

## Context

Content was flat: `Level.instances` a list, `Prefab.pieces` a list, and a piece's world pose composed from
exactly two transforms. Two things pushed against that.

**Compound motion was inexpressible.** A `move` behaviour translates a piece; a `rotate` behaviour spins
it. A bar spinning on a deck that is itself travelling is neither, and no third behaviour fixes it — the
two motions belong to different objects.

**The hierarchy panel (ADR 0024) made the gap visible.** Rows could be reordered but not nested, so the
panel showed a list where a person expects a tree, and dropping one object onto another did nothing.

Kodjo asked for the full job, arbitrary depth, plus a Local/Global gizmo toggle.

## Choice

**`PrefabInstance.children?: PrefabInstance[]`, recursive.** A child's transform is relative to its
parent's — and at runtime to the parent's *animated* pose, which is what makes motion compose.

**Prefabs stay flat.** A prefab holds pieces, never prefabs. Nesting is a property of *placement*, so the
composition stays a tree of transforms instead of becoming a dependency graph between assets, and a
prefab remains a thing that can be edited once and reflected everywhere (ADR 0023) without cycles being
possible between definitions.

**One `Frame` type for instances and pieces.** Both carry an optional behaviour and both compose onto a
parent, so a piece is just a leaf. That is why arbitrary depth costs one flat loop rather than a case per
level, and why a piece's own `move` still works exactly as it did.

**A behaviour applies in its own local frame, then composes.** A child's `move` axis and spin axis are
read in the *parent's* frame, so a bar rotating about +y on a deck that has itself turned rotates about
the deck's +y. For a top-level instance the parent is the world, which is why every existing level and all
13 gym physics tests behave identically — the rewrite was verified behaviour-preserving before any nesting
was added.

**A static piece under a moving ancestor becomes kinematic.** It is not moving under its own steam but it
*is* moving in the world, and a fixed body would leave it behind while its parent travelled. Kinematic if
the frame or any ancestor animates.

**The two handle types collapsed into one `Dynamic` holding a full pose.** `MoveHandle` stored a base
position and only ever wrote position; `RotateHandle` stored a base orientation and only ever wrote
rotation. A child of a rotating parent translates *and* spins, so the split could not represent it.

**Evaluation is one forward pass over a depth-first list.** `frames` is in creation order, which is
depth-first, so a parent's world pose is always resolved before its children are reached — no recursion
and no sorting at runtime. Static subtrees are skipped entirely; they are resolved once at load, so a
level with no movers costs what it always did.

**Depth-first order is the movement-base numbering**, and `walkInstances` in `@mp/content` is the single
definition of that order — used by the loader, where it fixes the index every client must agree on, and by
the editor, where it is the hierarchy's row order. Two definitions of "the order" is the bug this avoids.

**The wire does not change.** The base byte indexes the dynamic-piece list, every animated piece still
gets an index, and `basePoseOf` / `baseCarry` now return *composed* poses. So a rider on a crate parented
to a moving platform is replicated correctly and gets the platform's carry, with no new bytes — the
property that made this worth doing rather than merely tidy.

**Editor:**

- **Items are addressed by depth-first index**, the same order. The flatten is recomputed per call rather
  than cached: a cache has to be invalidated by every mutation *including one made through the level
  object rather than through the doc*, and the day it misses, an index silently addresses the wrong node.
  Tens of instances, so the walk costs nothing worth that risk. (A test that mutated the level directly
  caught exactly this, which is what decided it.)
- **The scene graph nests too**, one `THREE.Group` per item parented to its parent's. Three composes the
  chain, so a gizmo on a child reads and writes that child's *local* pose — which is what the document
  stores. Each group holds a dedicated mesh holder, because rebuilding one item's meshes must not take its
  child items with it and `disposeMeshes` cannot tell a mesh it added from a child group it did not.
- **Three-zone drop**, as Unity: outer quarters insert among the row's siblings, the middle half re-parents
  onto the row. An illegal drop shows no marker and refuses the drop effect, so it looks impossible rather
  than merely failing.
- **Cycles are refused.** In a depth-first walk a subtree is the contiguous run of deeper nodes right after
  its root, so "is the target inside my own subtree" is a scan, not a recursion.
- **Reparenting preserves the world pose**, as dragging in Unity's hierarchy does: the stored numbers are
  re-expressed in the new parent's frame (`parent⁻¹ · child`, decomposed) so the object does not jump.
- **Local/Global gizmo toggle** — `TransformControls.space`. Three already forces `local` for scale and
  `world` for the free-rotate ring, exactly as Unity does, so the button only ever claims what it delivers.

## Consequences

- **A piece's own behaviour now composes with its instance's instead of overriding it.** Precedence was
  `piece → instance → prefab`; a piece behaviour won and the instance's was ignored for that piece. Now the
  instance (or its prefab's default) animates the node and the piece's own animates the piece on top. No
  existing content combined the two — every behaviour in the repo is prefab- or instance-level — so nothing
  changed underfoot, and the new reading is the one that makes compound motion work.
- **Deleting an instance deletes its subtree.** Children are placed relative to it and have nowhere to be
  without it.
- **Marker and trigger positions are still authored positions**, composed at load with behaviours at rest.
  A moving checkpoint reports its home, exactly as before.
- **The 254-base ceiling now counts nested pieces too**, so a deep tree of movers reaches it sooner. Past
  it, riders fall back to world coordinates — degraded, not aliased onto another piece's frame.
- **Scale accumulates down the chain** and is baked into collider dimensions, so a child of a scaled parent
  is scaled. Decomposition cannot represent shear, so a rotated child inside a non-uniformly scaled parent
  is an approximation — the same limitation Unity has.
- `validateLevel` recurses, and its error messages carry the path (`level.instances[2].children[0]`),
  which is what makes a failure findable in a file that is now a tree.

## Rejected

**One level of nesting.** Kodjo's answer, and the right one: the loader work is identical — the moment a
child's base can move, the tree has to be evaluated in order — so a depth limit buys nothing and caps what
can be built.

**A `parent` id reference on each instance instead of `children` arrays.** That is a graph, not a tree:
sibling order stops being expressible in the file, cycles become possible in data rather than merely in a
drag, and the loader needs a topological sort before it can evaluate anything.

**Keeping the flat loader and adding a "compound" behaviour** that combined a translation and a spin. It
covers the one example and nothing else, and the second request (a bar on a deck on a lift) reopens it.

**Preserving each object's local transform on reparent** (so it jumps into the parent's frame). Simpler,
and wrong: dragging in a hierarchy is an organisational act, and having it teleport geometry punishes the
person tidying up.
