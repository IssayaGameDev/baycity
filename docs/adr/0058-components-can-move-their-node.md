# ADR 0058 — A component can move the node it sits on

Status: accepted. `self.offset` is live for a component that declares `moves`.

## Context

The component system had grown five gameplay components and looked healthy, and an audit for "what is
hardcoded that should be authorable" (ADR 0057) said the editor was nearly clean. What the audit actually
turned up was worse than a hardcoded value: **nothing a component could reach was writable.**

`WorldNode` is `readonly` throughout. `Ctx` handed a hook the tick, `dt`, level time, a seeded `random`,
`character.launch(speed)` and `effects.kill`/`progress`. The only thing in the system that moved anything was
`Track`, and that is not a hook at all — the loader evaluates it as `pose = f(t)` while building the frame
tree.

So a door that opens when touched, a platform that starts when you step on it, a bridge that falls: none of
them were expressible in any game. Not missing a component — missing a **verb**. Kodjo's reading of the
component system as "extremely inflexible" was half right, and this was the half.

## Decision

**`self.offset` is a live, mutable, local-space offset from the node's authored transform.** Write into it and
the frame tree carries the node's colliders, its visual, its light and its whole subtree on the same tick.

### An offset, not a pose

The same choice ADR 0050 made for keyframes, and for the same reasons: zero means "as authored", a driven node
survives being duplicated or reparented, and — the one that decides it — a component can nudge a node a
`Track` is already moving, because the two offsets simply add. A pose would have forced a choice between them,
with the answer depending on evaluation order.

Local space, so it composes with the parent chain. World space would have a component fighting every
ancestor's rotation and scale.

Mutated in place rather than set through a method: there is nothing to allocate per tick and no setter to
forget to call, and it is the same shape as `skyParams` and `sunAngles`, which a debug pane binds to directly.

`rotation` is Euler **radians**, matching `Transform.rotation` — which the editor shows in degrees and stores
in radians. This was written as degrees first and the test caught it.

### `moves` is declared, not inferred

A component that moves its node must say `moves: true`, and the loader asks the registry before it builds
anything (`TypeInfo` gained `moves` beside `singleton`).

It has to be answered at load: a node nothing moves gets a **fixed** physics body and sits outside the
per-tick pose pass, and neither can be changed afterwards. Inferring it — say, from a node having any hook at
all — would make every node with a `Checkpoint` on it kinematic and posed every frame, which is a cost nothing
asked for.

A component that writes `self.offset` without declaring `moves` finds it `undefined`. That is deliberately the
honest failure: the alternative is a silent no-op, and a hook quietly doing nothing is the worst of the three
outcomes. `driven` is inherited by children, so moving a parent carries its subtree.

### Components now run *before* the frame tree

The tick order was `loaded.update(nowMs)` then `components.fixedUpdate(...)`, in both the game client and the
editor's play-test. That was harmless while nothing writable existed, and wrong the moment it did: the frame
tree would pose everything from last tick's offsets, landing every driven node one tick late.

So both hosts now run components first. Nothing in a hook depended on the old order — `Track` is loader-side,
and the only thing a hook read of the world was its node's load-time position.

## Consequences

- A door that opens when touched is buildable. So is everything in that category, in any game.
- Six tests on the verb itself: the offset being live only for a declaring component, the node moving, the
  visual following, a subtree being carried, rotation in radians, addition with a track, and a driven node
  getting a body that can actually be posed.
- The cost is opt-in and per node: a kinematic body plus a frame evaluated every tick, on that node and
  everything under it.
- `TypeInfo` — the capability seam that keeps `@mp/content` from depending on `@mp/components` — grew by one
  optional field, which is the smallest thing that could carry this.

## Rejected

**A `setPose`/`moveTo` method on `Self`.** A method implies the loader can be told about a pose at any time,
which is false: the frame tree reads once per tick, in order. A field that is read at a known point says that,
where a setter invites `moveTo` being called from a render callback.

**World-space writes.** Convenient for exactly one case (an unparented node) and wrong for every other.

**Making every hooked node driveable.** The declaration exists precisely to avoid this; see above.

**Letting a component write `WorldNode.position`.** It is load-time data that half the system treats as
constant — `spawnFrom` reads it, the mode's checkpoint list indexes by it. Making it mutable would have made
every reader of it wrong.
