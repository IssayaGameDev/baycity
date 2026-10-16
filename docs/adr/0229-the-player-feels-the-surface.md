# ADR 0229 — The player feels what a surface is made of

Status: accepted. Kodjo's request: surfaces with physical properties, and the player reacting to them as a loose
object would.

## Context

A `Collider` was a shape and nothing else. Rapier has friction and restitution, but the player is a kinematic
character controller: it reads neither, so ice or a trampoline floor could not be built. Loose objects — rigid bodies
— are a later, separate question: the server runs no physics, and a client-side one diverges between screens.

## Decision

- **Two fields on the `Collider`: `friction` (Rapier's, default 0.5) and `bounciness` (restitution, 0–1, default 0)**,
  hidden on a trigger. Built into the body only where they differ from Rapier's own, so a surface nobody set is built
  exactly as before. The same two numbers will serve loose objects.
- **The ground probe says what the floor is made of** (`GroundContact.friction`, `.restitution`), and the controller
  reads it — no lookup from handle to node.
- **Grip** (Kodjo's call: both ways): `friction ÷ 0.5`, capped at 1, scales the ground's speeding up and braking alike —
  on ice you are slow to get going and slow to stop. A grippier floor than the default is today's floor.
- **A slippery slope pulls downhill** (Kodjo's call): below full grip, gravity's part along the slope, `g·n_y·(n_x, n_z)`,
  is added before the grip's approach, so grip holds against it and a slide comes where it cannot.
- **A bouncy floor throws a landing back up, as a ball** (Kodjo's call): to `bounciness²` of the height fallen, worked
  on the tuning's own gravity curve — it falls heavier than it rises, so the bounce's share of the speed alone rose
  higher than it fell. Spent next step as a launch is, and **added** to a jump taken then (Kodjo's call), where a
  launch outranks one. Under 1 m/s it is no bounce, so the player settles.
- **Nothing changes at the defaults**, which is what lets 598 movement tests pass unchanged: grip 1 skips the slope
  pull, bounciness 0 skips the bounce.

## Rejected

- **Physical traction (`μ·g`) for the player**: on Keyboard's grip a floor would need a friction no one would type to
  feel different; a share of today's grip reads as what it is.
- **Bouncing off walls**: not asked for yet; the wall's normal is in the controller's collisions when it is.
- **The bounce's share of the fall speed**: with a fall heavier than the rise it bounced higher than it dropped.
