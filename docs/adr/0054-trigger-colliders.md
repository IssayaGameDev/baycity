# ADR 0054 — A collider can be a trigger

Status: accepted. Completes ADR 0053, which needed this and did not have it.

## Context

ADR 0053 made the kill plane a `Hazard` on a wide flat collider under each level. That is the right shape, and
it exposed that `Collider` has only one mode: **solid**. So the kill plane is a floor. You fall onto it, land,
and die standing on a surface that is meant to be empty space with a rule in it.

Kodjo asked for the collider to be trigger-only, with no collision response. Unity's `isTrigger`, Rapier's
sensor.

## Decision

**`Collider.trigger`**, a bool defaulting to `false`, passed through the loader as `BodyOptions.sensor` and on
to `ColliderDesc.setSensor`. Off by default, so every collider authored before this is unchanged.

A trigger is still a collider on the node, still in `WorldNode.colliderHandles`, so a rule beside it fires
exactly as before. Only the physical response goes away.

### Detection is a second pass, and it has to be

A sensor resolves no movement, so it never appears in `CharacterBody.collisions` — that list comes from the
character controller's `computedCollision`, which is the record of what the capsule *pushed against*.

So `CharacterBody.overlaps()`: the sensors the capsule is currently inside. An explicit
`intersectionsWithShape` with `QueryFilterFlags.EXCLUDE_SOLIDS`, not Rapier's narrow-phase intersection pairs,
for two reasons — it needs no `step()` since the capsule last moved, and returning sensors *only* means a
caller cannot accidentally re-handle a solid it already saw in `collisions`. The two lists are disjoint by
construction, and a host that wants every contact concatenates them.

### Three query paths had to learn to ignore sensors, and one of them was a bug

Measured, not assumed. The first version of the walk-through test **failed**: a sensor wall stopped the capsule
at the same distance a solid one did, because Rapier's `computeColliderMovement` resolves against sensors
unless told otherwise. `QueryFilterFlags.EXCLUDE_SENSORS` on that call is what actually makes a trigger a
trigger.

The other two are consequences of the same thing, and both would have been silent:

- **`probeGround`** — a trigger under the feet would read as footing, so you would stand on the kill plane
  even with movement passing through it.
- **`castSphere`** — the camera's occlusion probe would pull the boom in for a volume you can walk through,
  shoving the view for no visible reason.

## Consequences

- Every shipped level's kill plane is now `trigger: true`. You fall through it and die, which is what the old
  `fallY` number did and what a solid box could not.
- Both hosts that drive components now pass `[...collisions(), ...overlaps()]` — parkour's client and the
  editor's play-in-place.
- Five physics tests, one per path that could silently regress: not blocking, reported by `overlaps` and never
  by `collisions`, not reported once left, not footing, not stopping a sphere cast. Plus three at the loader
  level (walked through where a solid blocks, still owns a handle, solid when the flag is absent) and one
  content guard per level that the plane stays a trigger.
- `overlaps()` costs one shape query per call, on demand. Cheaper than the alternative of subscribing to
  Rapier's collision events, and it needs no event bookkeeping between steps.

## Rejected

**A separate `Trigger` component beside `Collider`.** Two components to author one volume, and every consumer
would have to check for both. Kodjo asked for the flag on the collider, and Unity agrees.

**Narrow-phase intersection pairs** (`world.intersectionPairsWith`). Fewer moving parts on paper, but it only
holds pairs the last `step()` computed — so it is wrong for any caller that reads between steps, and it
reports solid pairs too.

**Leaving the kill plane solid and keeping a `fallY` check as well.** That is ADR 0053 undone: two ways to say
one thing, one of them invisible.
