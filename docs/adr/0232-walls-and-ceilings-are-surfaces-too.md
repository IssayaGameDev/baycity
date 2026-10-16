# ADR 0232 — Walls and ceilings are surfaces too

Status: accepted. Completes ADR 0229, which covered only what the player stands on.

## Context

Kodjo asked for the player to react to every surface as a loose body would. ADR 0229 read the surface through the
ground probe alone: grip, a slope's pull and a landing's bounce, all underfoot. Running into a bouncy wall, or a
grippy one, did nothing — a tenth of the request, narrowed to what the code already reached without saying so.

## Decision

- **A move reports its contacts** (`CharacterBody.contacts()`): each with its normal, out of the surface, `floor`,
  `wall` or `ceiling` by it, and the surface's friction and restitution.
- **Walls and ceilings bounce** (Kodjo's call): the velocity going into one comes back its bounciness times over,
  `v += (1 + e)·into·n`, above `MIN_BOUNCE`. **The player keeps full control after** (Kodjo's call, over taking it
  away as a bumper's throw does): on the ground a held direction takes it back within the grip's time.
- **A grippy wall slows the slide along it** (Kodjo's call, above the default only): the speed along it falls by
  `(friction ÷ 0.5 − 1)` times the speed pressed into it, so scraping slows you and a wall you push into slows your
  fall. A wall at or under the default is as it was.
- **A landing bounces off the floor's angle** (Kodjo's call): reflected about the floor's normal, the part into it
  back `k` times over — `k` what ADR 0229's ball rule makes of the fall on flat ground, so a flat floor is that rule
  exactly; a slope throws you downhill, sideways added after the take-off's horizontal solve.
- **Each surface once a step**, by its first contact. At the defaults none of it runs: 610 movement tests unchanged.

## Not yet

- **Moving bouncy things** (Kodjo's call: later): a bounce relative to the surface's own motion needs a moving piece's
  speed, which the loader poses without on purpose (platform carry), and joins the push (ADR 0186) and the ride.
