# ADR 0231 — A loose body takes the surface as it is

Status: accepted. Follows ADR 0229: the surfaces' numbers reach the loose bodies too.

## Context

Kodjo set a floor to friction 0 and bounciness, and the death ragdoll did not change. Rapier mixes two touching
colliders' friction and restitution by averaging, unless one asks for another rule: the ragdoll's parts, at Rapier's
0.5 and 0, halved every floor — ice gripped at 0.25, a 0.8 trampoline bounced at 0.4, which on tumbling parts reads as
nothing.

## Decision

- **`BodyOptions.takesSurface`**: the body's friction (1 unless given) **multiplies** and its restitution (0 unless
  given) takes the **larger**, so what it touches counts by its own numbers. Rapier uses the stronger of two rules, so a
  floor left on the default `Average` yields to it.
- **The ragdoll's parts take it.** On a floor nobody set nothing changes (1 × 0.5, the larger of 0 and 0). Two parts
  against each other now grip at 1 rather than 0.5, and still do not bounce.
- A later loose object takes it the same way.

## Rejected

- **A combine rule on the level's colliders** (`Min` friction, `Max` bounce): a grippier floor than the default could
  then never grip a loose object better.
- **Part friction 0.707, multiplying** (keeps two parts at 0.5): every floor would then count at 0.7 of itself.
