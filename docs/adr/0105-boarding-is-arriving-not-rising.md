# ADR 0105 — Boarding is decided by where a surface is met, and a rider is seated on it

Status: accepted. Fixes two defects in the carry system left by [ADR 0042](0042-fast-vertical-platforms.md)
and [ADR 0104](0104-a-deck-may-not-outrun-its-rider.md). Every number here is measured.

## Context

Kodjo, on a platform doing 26.5 m/s with `smooth` off — 0.88 m a tick, **inside** ADR 0104's sliced regime, so
neither the slicing nor the overtake probe was involved:

1. Jump on while it rises and you ride it up *hovering a gap above it*, not standing on it.
2. At the apex it reverses out from under you; you hang, then fall and catch up.
3. Land on it cleanly and it is perfect — feet on the deck, no gap.
4. From a clean landing, the next reversal is followed exactly.

3 and 4 are the system working. 1 and 2 are one defect, and there is a third, rarer one Kodjo also hit: the
platform sometimes passes straight through a player jumping onto it.

### Arriving was read as leaving

Footing was `under !== undefined && !leaving && vy <= 0`. The `vy <= 0` is ADR 0042's, and it is right for
what it was written for: rising away from a surface is not standing on it, which is what stops a jump off a
riser being re-captured a tick later.

But it also refuses footing to a deck that arrives *underneath a jump*. And nothing else will catch it: a
character controller resolves only the motion the **character** asks for, so a kinematic body moving into a
capsule pushes it nowhere. Measured, boarding a 26.5 m/s riser mid-jump — the deck's top face against the
soles:

```
+0.055 m   +0.638 m   +1.522 m      the rider never moves
```

That is the platform passing through the player.

### The ride carried the gap it boarded with

`riding` drives the pose from an anchor — a point stored in the deck's frame — so it reproduces the deck's
motion exactly, **including any separation present when the base was taken**. It also clamps `vy` to zero, so
neither gravity nor snap-to-ground can close that separation afterwards.

Boarding caught the capsule 0.21 m clear of the deck, and it stayed 0.21 m clear for the whole ascent. At the
apex the deck reversed away from a rider that was never really on it, the base was lost, and it fell. Symptoms
1 and 2, and they explain 3 and 4 as well: a clean landing goes through ordinary collision and snap-to-ground,
so the anchor has no gap in it.

## Decision

### Footing is decided by *where* the surface was met

```
const arrived = under !== undefined && under.point.y > feetY + CONTACT_SLACK
const standing = under !== undefined && !leaving && (vy <= 0 || arrived)
```

A surface met **above** the soles has arrived — the capsule is inside it. One met below is being left behind.
Geometry, not a sign test on velocity, so the two cases cannot be confused. ADR 0042's rule is otherwise
untouched: a jump off a riser still meets its deck below the soles and is still not re-captured.

The base gate follows footing for the same reason, so a deck is boarded on the tick it touches — while the
overlap is shallow enough for `move` to resolve, and before anything has to be recovered from. An arrival also
cancels the remaining climb, since the deck has caught you.

### The vertical ride seats the soles on the surface

```
seatY = under.point.y + SEAT_OFFSET - feetY      // instead of ride.y
```

The probe runs *after* the platforms have moved, so `under.point` is where the surface will be at the end of
this tick, and the travel that lands the soles on it is simply the difference. Riding a 26.5 m/s riser the
anchor asks for 0.883 m and the contact for 0.691 m; the **0.192 m between them is the hover**. Descending,
the two agree to the contact offset, which is why only risers showed it.

Horizontal still comes from the anchor. That is what carries a rider across a platform which is also turning,
and a downward contact says nothing about it.

## Consequences

- **A rider boards a riser mid-jump and is seated on it within one tick**, at every speed one slice carries
  (up to ~1.2 m of deck travel per step, ADR 0104; faster than that the client slices the tick).
- **The seat holds across a reversal**, which is what symptoms 1 and 2 were really about.
- On the boarding tick the deck is briefly inside the capsule — 0.17 m at 20 m/s. One tick to resolve a
  surface arriving at speed is the tick rate's floor, not a defect, and it is gone the next tick.
- `SEAT_OFFSET` is the controller's own resting contact offset (0.020 m), measured. Seating to the arrival
  margin instead would hold every rider a visible 5 cm clear of the ground.
- Two regression tests, each verified to fail with its fix reverted.

## Known, not fixed here

ADR 0042's deeper probe accepts a hit only if it is the base's own collider, and a ray returns the **closest**
hit. So a surface between the rider and its platform — a floor under the shaft — takes the hit and the ride is
dropped. Found while building the harness for this, where a platform descending past a static floor lost its
rider every cycle. It needs its own change (an exclusion, or a cast that reports more than the first hit) and
is not part of this one.

## Rejected

**A depenetration query** — ask the physics for solids overlapping the capsule and push out of them. It would
work, but it needs a new query on `CharacterBody` and a second one to find the surface to push *to*, and the
probe already reports exactly that contact. Two queries to recover what one already returned.

**Comparing the deck's velocity to the character's** to tell an arrival from a departure. It needs the
platform's velocity, which is not available at boarding — there is no base yet, so no `liftVel` — and it would
have been a threshold where geometry gives an exact answer.
