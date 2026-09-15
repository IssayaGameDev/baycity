# ADR 0106 — A Mover's metre is a metre, and it picks its own frame

Status: accepted. Refines [ADR 0103](0103-motion-is-a-speed-not-a-keyframe.md); nothing else changes.

## Context

Kodjo, on the new `Mover`: *"the fact that the offset is multiplied by the parent scale, we have to think
about this a bit deeper."*

He was right that something was wrong, and wrong about which thing. Two facts, both checked in the code:

**It was never world space.** The frame tree composes
`worldPos = parent.worldPos + rotate(parent.worldRot, parentScale × localPos)`, and a mover's travel was
added straight into `localPos`. So it was already **parent** space — a mover under a rotated parent already
turns with it. It only *looks* like world space because a top-level node's parent is the level.

**But it was not metres.** Going through `parentScale` means a 3 m travel under a parent scaled 2× is 6 m, and
a diagonal under a non-uniform scale comes out at an angle nobody typed — component-wise scaling keeps a
straight line straight but turns it. The field says `move (m)` and it was not metres.

This is exactly what Unity does for an animated `localPosition`, so it is not a mistake so much as an
inherited one.

There is a real argument for keeping it. A platform placed at local `(0,3,0)` under a 2× parent sits 6 m up; a
platform with a 3 m Mover used to top out in the same place. Scaling the offset is what made a mover agree
with a static twin. Kodjo weighed that and chose the other side: the number in the field should be the
distance travelled.

## Decision

### The travel is in real metres

The loader divides the authored travel by the parent's accumulated scale before it enters `localPos`, undoing
the multiplication the frame tree is about to apply. What is typed is what is travelled, at any scale.

A zero-scaled axis divides as 1 rather than to infinity, which would otherwise put the node nowhere.

The cost, accepted: a mover no longer agrees with a static node placed at the same local offset under a scaled
parent. That disagreement is now visible and asked for, where the multiplication was silent.

### `space`: `world` or `local`

```
world   travel along the world axes, whatever any parent is rotated to   (default)
local   travel along the node's own authored orientation
```

Unity's `Space.World` / `Space.Self`. `world` is what a platform going up wants and what every mover authored
before this did — under an unrotated parent the two are identical, and **no authored mover in the content
sits under a rotated or scaled ancestor**, so this changes nothing that exists.

`local` is for a tilted platform that should travel along its own tilt. Without it the only way to say that
was a rotated wrapper object, which puts the rotation on something other than the thing you are looking at.

The frames are reached by pushing the authored vector back through what the frame tree will do to it:
un-rotate by the parent's world rotation for `world`, rotate by the node's own authored rotation for `local`.
The parent's rotation is then re-applied by the frame tree, which is right, because a node's world
orientation *is* its parent's times its own.

**The node's authored rotation, not its live one.** A `Spinner` on the same node would otherwise turn a
straight `Mover` into an orbit. That is a different feature and a surprising way to arrive at it.

### `Spinner` keeps no `space`

Its contribution is euler radians added to the node's own rotation, so it is already the node's own axis, and
a world-axis option is not expressible: a turn about an axis the node is not aligned to is not a straight line
through euler space. Same reason its axis is a cardinal enum (ADR 0103).

## Consequences

- A `Mover` travels its authored metres under any parent scale, uniform or not, and a diagonal keeps its
  angle.
- `space: local` gives a tilted platform travel along its own tilt with no wrapper object.
- The travel is re-framed **per mover**, in the loader, because `motion.ts` is headless and knows nothing
  about a parent chain. A node with no movers pays nothing, which is every node in a still level.
- Four tests, and the unscaling is verified by reverting it.

## Rejected

**Leaving the multiplication and showing the effective distance in the Inspector** — "you typed 3, it travels
6". Honest, and it still leaves a person doing arithmetic every time a parent is rescaled, with the answer
going stale silently when someone else rescales it.

**A third `parent` space**, preserving the old behaviour exactly. Two frames a person can name are enough;
parent space is what `world` collapses to whenever the chain above is unrotated, which is every case in the
content.
