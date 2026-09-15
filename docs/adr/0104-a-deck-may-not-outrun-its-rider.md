# ADR 0104 — A deck may not outrun its rider: the overtake probe, and slicing the tick

Status: accepted. Completes [ADR 0042](0042-fast-vertical-platforms.md), which fixed the same failure in the
other direction. Keeps the tick contract of [ADR 0081](0081-a-step-is-a-tick-of-held-input.md) and the
locomotion slot of [ADR 0061](0061-locomotion-is-the-games.md) untouched.

## Context

Kodjo, playtesting a fast up-and-down platform: *"the player just glitches through most of the time"*, while
adding that running into walls at speed holds up fine.

Both halves of that are explained by one fact. **When the character moves, its motion is swept** —
`computeColliderMovement` shape-casts it, so a wall is never passed through however fast you run at it. **When
a platform moves, it is teleported** — the loader poses a kinematic deck with `setPosition` plus a matching
kinematic target, deliberately, so Rapier derives zero velocity and the carry system is the only thing moving
the rider. A teleport is not swept. Nothing watches that side at all.

Measured at 30 Hz, a rider standing on a rising deck:

| deck travel per step | outcome |
| --- | --- |
| 1.18 m | carried exactly, feet 0.020 m above the deck — the controller's own contact offset |
| 1.27 m | `move()` applies **0.000** of a 1.267 m ride; the rider ends 2.42 m below the deck and stays there |

The cliff is the distance from the capsule's centre to its soles (0.6 + 0.4 = 1.0 m, with a little slack). A
deck starts at the soles, so a step longer than that ends **above the centre** — above the origin of the
downward probe, where no reach can find it, and inside the capsule, which the character controller will not
sweep free of.

ADR 0042 fixed the mirror case, a deck *dropping away* faster than the probe reaches, by looking further
**down**. Rising was never covered, and cannot be: there is no downward ray that finds a surface above its own
origin.

Why it surfaced now: `Mover.speed` is the average over a leg and `smooth` peaks at π/2 times it (ADR 0103), so
the authored `FastElevator` — 10.2 m at 20.4 m/s — peaks at **32 m/s**, just over the line. The keyframe form
had identical easing, so the hole is not new; the new parameter just made it one field to type.

## Decision

Two changes, one for each half of the failure.

### 1. The overtake probe — `groundController.ts`

When the downward probe misses and a base exists, the anchor's rise is already computed: `-away` is exactly
how far the base moved relative to us this tick, because the anchor is our own centre stored in the deck's
frame and re-read under its new pose. So the rising case is the same expression with the sign flipped:

```
else if (-away > STAND_HEIGHT && -away <= 2 * STAND_HEIGHT && overhead(anchor, position) && vy <= 0)
  under = { colliderHandle: base.colliderHandle, point: anchor, normal: +Y }
```

Every bound is forced rather than tuned:

- **`> STAND_HEIGHT`** — below that, the longer probe ADR 0042 added already copes. Firing here instead
  re-captures an ordinary 2 m/s riser *every tick*, and drags along anyone who has walked off it: two existing
  carry tests caught exactly that while this was being written.
- **`<= 2 × STAND_HEIGHT`** — beyond that the deck cleared the top of the head in one step. It did not pass
  through the rider, it passed them.
- **`overhead`** — the point is still under the capsule, not somewhere we walked away from.
- **`vy <= 0`** — rising under our own power is not standing on anything (ADR 0042), so a jump off a riser is
  never re-captured.

The contact is synthesised rather than cast, which is honest: `under` is read for its collider handle alone,
and the anchor *is* the point on that surface the rider was standing on.

This alone carries a deck to **~36 m/s**, up from ~30.

### 2. Slicing the tick — `LoadedLevel.motionSlices`, and the client's fixed step

Past ~1.2 m of travel per step the base logic is still correct — the rider keeps its base at every speed
tested — but `move()` will not deliver the ride, so the rider is carried along *inside* the deck. No amount of
reacting in the character fixes that. The deck has to move in smaller increments.

`motionSlices(fromMs, toMs, maxStep)` reports how many equal slices a tick needs so nothing travels more than
`maxStep` between two of them. It costs two evaluations per animated frame, because motion is a pure function
of time (ADR 0103) — an intermediate pose is exact, not interpolated. The client slices with
`maxStep = CHAR_HALF_HEIGHT + CHAR_RADIUS`, derived from the capsule so a taller character gets a longer
allowance, and caps at 8 slices.

**The slicing lives inside one `tick()`**, which is what keeps the netcode contract: the local controller
still sees one step per tick, prediction still replays whole ticks, and the count is derived from the level
and the clock so every client computes the same one. `components.fixedUpdate` stays at one call per tick —
`tickCount` and the seeded `ctx.random` are per tick by definition (ADR 0036), and running hooks several times
would fire a rule twice. Only the frame tree, the physics and the movement slot are sliced.

A level with no fast mover reports one slice and runs exactly as it did.

## Consequences

- **A rider stays on the deck at every speed a Mover can author.** Measured with the tick sliced: exact to
  0.02 m at 45, 60, 90 and 150 m/s.
- **Halving the slice doubles the ceiling**, exactly. One slice ≈ 36 m/s, two ≈ 72, four ≈ 145.
- **Fast movers cost more physics steps.** Only on the ticks they are fast, only on levels that have one, and
  the cap bounds the worst case at 8.
- The movement slot can now be called several times in a tick with a smaller `dt`. Gravity and acceleration
  integrate to the same place over the tick; a buffered jump fires on the first slice and `leaving` clears the
  buffer for the rest.
- `motionSlices` measures **position only**. A spin's reach depends on how far a collider extends from its
  axis, and a node large enough for that to matter is not one a rider stands on the top face of.

## Rejected

**Capping `Mover.speed`** so nothing unrideable can be authored. Kodjo's call, and the right one: a guardrail
around a hole is not a fix, and the character's own speed range reaches 283 m/s, so a platform that cannot
keep up with the player is a limit that would be felt.

**Sweeping the platform instead of teleporting it** — `setNextKinematicTranslation` alone, letting Rapier
generate contacts. Measured and rejected: it changes nothing at 45 m/s and barely moves 60 m/s, because the
character controller still will not free a capsule it is already inside. It would also cost the exact carry
that the teleport pairing exists to provide.

**Slicing only the character**, which would have needed no change outside `stepCharacter`. Measured and
rejected: it makes the failure *worse*. By the time the character steps, the deck has already teleported past
it, and more, smaller sweeps out of the same overlap resolve to the same nothing.

**Raising the tick rate.** Fixes this and costs everything else.
