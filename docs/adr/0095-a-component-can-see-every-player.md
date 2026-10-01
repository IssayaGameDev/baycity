# ADR 0095 — A component can see every player, and the Boss is what wanted it

Status: accepted. Opens a hole in ADR 0036's determinism rule, deliberately and narrowly. **The Boss's `zone` as
a node reference superseded by ADR 0177**: a Collider field.

## Context

Kodjo asked for a **boss**: a chaser that wakes when a player enters its zone, runs at whoever is furthest
through that zone, and parks itself when the zone empties. The reference is the vehicle that patrols a lane in
the Roblox obby it is modelled on.

The rule needs to rank *every* player in the zone. A component could not see any player but its own:
`Ctx` handed out `character`, which is the local body, and nothing in `@mp/components` mentioned a peer.

That was not an oversight. ADR 0036 makes a hook a pure function of its state, the synced tick and its
arguments — so every client accumulates the same state from the same inputs, and no per-object networking is
needed for anything a component does. `ctx.random` is seeded from the tick rather than being `Math.random`
precisely to keep that true.

Peers break it. They arrive relayed and interpolated about 100 ms behind (`INTERPOLATION_DELAY_MS`), so two
clients asked the same question at the same tick get slightly different answers.

## Decision

**`ctx.players()`**, returning the local body first and then peers. Supplied by the host as `io.peers`, which
the game fills from `net.sample()` through `worldFromBase` and the editor omits entirely.

The determinism rule stands everywhere else and this one hole is documented on the method: legitimate for
chasing, aiming, ranking and looking at; never for anything that must be agreed on.

**It is safe here for the same reason a `Hazard` is.** Under client authority (ADR 0011) each client decides
its own death. A boss three centimetres apart on two screens still kills exactly the player whose own client
says it touched them — nobody is killed by someone else's opinion of where the boss was. Divergence costs
appearance, never outcome.

**The Boss does not kill.** Put a `Hazard` and a `Collider` with **`trigger` on** on the same node. Dying is
already a component, and a second way to die would be two rules for one thing.

The trigger is load-bearing, and it was found the hard way — the first prefab used a solid collider and the
boss shoved players around and often failed to kill them at all. A solid collider is resolved by the character
controller, so it pushes; and it reaches the `Hazard` only through `CharacterBody.collisions()`, which holds
what the **character's own movement** ran into. A boss driving into somebody standing still produces nothing.
A trigger is found by `overlaps()`, an explicit shape query run every tick wherever the capsule is, so it does
not care which of the two moved (ADR 0054).

**`PlayerView.alive`.** A corpse keeps the position it fell at, so without it the boss orbited a dead body
until it respawned. From `STATE_DEAD` for a peer and from the client's own `dead` for the local player; `true`
wherever the host does not say, which is the editor's play-test.

## Kodjo's choices

Asked as four, answered as four:

- **Target everyone**, not just the local player, which is what forced `ctx.players()` — the alternative was a
  boss in a different place on every screen.
- **Drives home and waits** when the zone empties, at the same speed. A parked boss reads as a safe lane.
- **Steers toward the target** rather than running a fixed lane, turn-rate limited so a sharp change costs
  time and dodging past it is a real skill.
- **The zone's forward is the zone node's own `+Z`**, so rotating the volume in the editor aims it. No second
  place for the direction to disagree with the shape.

## Membership is geometric, not a trigger

This is the part that looks wrong and is not. The zone is a box `Collider`, normally a trigger, but the Boss
tests membership by **oriented-box containment** against `ctx.players()`, not by contact.

A sensor cannot do the job: it only ever reports the local player, because peers are relayed positions and
were never in this client's physics world at all. A box test sees everyone the client can see.

For that the loader had to say more about a node. `WorldNode` gained `rotation` (world, at load — pairs with
`position`) and `colliders` (the world-scaled `ColliderDesc` list, in `colliderHandles` order). Collider
handles are opaque above the physics layer, so there was no way to ask how big a thing was; a contact never
needed it and a volume test does. World-scaled, so ADR 0090's unit-collider-times-node-scale is already
applied and no reader repeats it.

## Rejected

- **Keeping components blind and writing the boss into the game mode.** It would work and it would be a rule
  that cannot be placed in a level, which is the thing the component system exists to stop.
- **A `Ctx` handle on other players rather than a position.** There is nothing a component may legitimately do
  to another player's body: that client owns it. A read-only view says so in the type.
- **Deriving the target from something everyone agrees on** — lowest entity id, or a server-chosen leader.
  Deterministic, and wrong: the boss would ignore the player actually in front of it.
- **The trigger collider deciding membership.** Misses every peer. Considered first and it is the obvious
  design; it is simply blind in this architecture.
- **Killing from inside the Boss.** `Hazard` already exists.
- **Letting the boss climb.** It drives in the horizontal plane at its authored height, or it would chase
  someone up their own level.

## Consequences

- `Ctx` gained a non-deterministic method. The header comment in `runtime.ts` and `components/api.md` both say so
  where somebody writing a component will read it.
- `WorldNode` gained two fields, so every construction site had to fill them — including the synthetic player
  node in the runtime, whose values are placeholders for the same reason its `position` already was.
- `io.peers` is optional, so a play-test in the editor and anything offline see a one-entry list. A component
  must read correctly with one player, because most of the time there is one.
- The list is rebuilt once a tick and the array reused, so a hook must not keep it.
- The Boss moves through `self.offset`, which is **parent space** (ADR 0058), so a boss parented under a
  rotated or scaled node chases along skewed axes. Documented rather than prevented: put it at the level root.
