# Obstacles

What the character can physically do, and the obstacle vocabulary built on it. Numbers here are
**measured** against the real controller, not derived — re-run
`packages/character/src/envelope*.test.ts` after any change to `DEFAULT_TUNING` or the KCC settings.

## Movement envelope

Tuning: `moveSpeed 5.5`, `jumpHeight 2.7`, `gravity 55`, `airControl 1`, plus the arc shaping
`fallGravityScale 1.6`, `apexGravityScale 0.5` over an `apexSpeed 4` window, `jumpCutScale 1` (off).
Kodjo's values; `airControl 1` is deliberately the Roblox model — Roblox uses `TurnSpeedFactor` 1 in
*both* its GroundController and its AirController, so it does not restrict air steering at all.

Two things about the numbers below changed with ADR 0041 and neither is a level-design hazard, since both
make the envelope **wider**:

- `jumpHeight` reads 2.7 where it read 3 and **the jump apex did not move** — the old vertical integration
  undershot by 10%, so 3 flew as 2.70. It is exact now and the number was set to the apex that was always
  flying. The one figure that fell out of it is take-off speed, derived from `jumpHeight`: 18.2 → 17.2 m/s.
- **Apex float widened every gap by ~0.5 m** (running gap 3.6 → 4.1 m). Half gravity through the
  `|vy| < 4` band adds ~0.15 s of air near the top, worth ~0.8 m of reach, against ~0.35 m given back by
  the heavier fall. Nothing authored became unreachable; every jump got easier.

**The harnesses hold the jump button while `vy > 0`.** `jumpCutScale` is off today so it makes no
difference, but with a cut live a one-tick press is a deliberate short hop and the harness would measure
the *minimum* jump instead of the maximum.

| | |
|---|---|
| Air time per jump | 0.63 s for a plain parabola; ~0.73 s with the apex float |
| Capsule | 0.8 m wide, 2.0 m tall |
| Full speed reached in | 0.1 s / 0.275 m |
| Stop distance from full speed | ≈0.22 m |
| Step-up without jumping | **0.40 m** (autostep) |
| Step-up jumping | **3.1 m** |
| Walkable slope | ≤44°; ≥48° slides off |
| Jump leaves the ground at | 17.2 m/s (`√(2·gravity·jumpHeight)`) |
| Bumper reach | `power² / (2·gravity)`, so 26 m/s ≈ **6.1 m** (ADR 0032) |

A bumper's `power` is a launch *speed*, and the jump speed above is the number that makes it legible: anything
below 17.2 throws lower than the player's own jump. Measured in `packages/character/src/bumper.test.ts`.

### Max gap, edge to edge

| Landing vs take-off | Max gap |
|---|---|
| −2.0 m | 4.5 m |
| −1.0 m | 4.3 m |
| level | **4.1 m** |
| +0.5 m | 4.0 m |
| +1.0 m | 3.8 m |
| +1.5 m | 3.6 m |
| +2.0 m | 3.5 m |
| +2.5 m | 3.2 m |

≈0.35 m of reach per metre climbed, bought back by dropping.

**Nothing currently asserts that authored content respects this table.** `gym.test.ts` used to, against the
code-built gym; both are deleted (ADR 0027). The numbers above are still measured by
`packages/character/src/envelope*.test.ts` — what is missing is a check over a *level*, which belongs in the
editor as a reachability gizmo rather than a test over a fixture.

### Lateral margin on a beam

**margin = width / 2 + 0.25 m** — the capsule's rounded bottom overhangs an edge by a quarter-metre
before letting go. Every width is traversable walking straight; 0.2 m of beam still gives ±0.35 m.

| Width | 0.2 | 0.4 | 0.8 | 1.2 |
|---|---|---|---|---|
| Margin | ±0.35 | ±0.45 | ±0.65 | ±0.85 |

### Curved tops

Dome and horizontal-capsule tops are standable to **±40° from the crown**, independent of radius —
a dome of radius R gives a band `2 · 0.64 · (R + 0.4)` wide (1.8 m at R=1, 5.7 m at R=4).

## Consequences that shape the design

Three measurements decide what obstacles can work at all:

1. **Nothing drifts.** Below 45° a slope holds a standing character perfectly still (0.01 m over
   4 s); above it, they slide off entirely. Binary. Footing *shape* therefore only limits usable
   area — it never destabilises. Sliding-down-a-slope obstacles are not buildable, and slope
   sliding as a mechanic was considered and rejected.
2. **Air control is as strong as ground control.** `airControl 1` means air accel equals ground accel —
   55 m/s². Killing 5.5 m/s takes 0.17 s and a full reversal 0.23 s, inside a 0.73 s hang, so a jump can be
   redirected freely and small landing targets are cheap to hit. Precision has to come from what happens
   *after* landing, or from what the body collides with in flight — never from landing dispersion, and never
   from committing to a direction at take-off, because nothing commits.
   **Speed above `moveSpeed` — a mover's fling, a launch — is outside air control entirely** (ADR 0041): it
   is carried untouched, so holding the direction of flight neither helps nor hurts, and no input can raise
   speed above what the fling gave you. A moving platform can hand the player reach this table does not
   cover, and it is the only thing that can.
3. **Run-up length is not a lever, and neither is standing still.** Full speed arrives in 0.275 m on the
   ground, and at `airControl 1` it can also be built *in the air* — which is why the measured standing gap
   (**4.4 m**) now beats the running gap (**4.0 m**): a standing jump accelerates through its whole arc.
   Obstacles that try to deny a run-up do nothing at all.

Two further rules fall out of the numbers:

- **Autostep eats anything under 0.4 m.** A block or bar whose top is less than 0.4 m above the
  footing is simply walked over.
- **A 2.7 m apex hops most sweepers.** A bar is only a threat if it is ≥2.7 m tall, or sits under a
  ceiling lower than its height + 2.0 m, or the landing after the hop is itself the risk.
- **Push is pure displacement.** Being shoved off carries no lateral velocity — you drop straight
  down. Moving pieces can remove you from footing but can never help you cross anything.

## Vocabulary

Difficulty is **stage × threat**: static footing sets what you stand on, moving parts tax it.
Precision is the intended spine, then timing, then distance.

Levers in use: footing area, footing shape, footing continuity, body clearance, push, clock
coupling. Deliberately not in use: punish radius, reference frame, forced momentum, commitment,
approach angle, visibility, chain length, vertical direction.

### Built

**The pieces below no longer exist as code.** The kit and its generators are deleted (ADR 0027): geometry is
authored in the editor as prefab assets. The vocabulary is kept here because it is what the measurements
above *mean* — a beam is a footing-area obstacle whatever produces it — and because anything rebuilt as a
prefab should be rebuilt to these numbers.

| Piece | Was | Parameters that mattered |
|---|---|---|
| `beam` | `@mp/content` kit | `length`, `width` — margin per the table above |
| `padChain` | `@mp/content` generators | `pads`, `padSize`, `gap` (edge to edge), `rise`, `lateral` |
| `curvedBeam` | `@mp/content` generators | `radius`, `sweepDeg` (signed), `width`, `segments` |
| `curvedBeamExit` | `@mp/content` generators | exit point + heading, for chaining arcs |

`lateral` staggers pads either side of the centre line, so the real jump is the diagonal
`hypot(gap, lateral)` — a zig-zag needs a shorter `gap` than a straight run.

A straight beam only asks the player to hold one direction, which makes it an introduction and
nothing more. `curvedBeam` is the version with teeth: it starts at the local origin heading +x and
turns as it goes, so the player must keep changing direction and bring the camera round.

Each segment is a **convex prism through its eight exact corners**, not a box (ADR 0017). A swept
segment's end faces are perpendicular to the tangent and so not parallel to each other, which a box
cannot express at any subdivision — a box chain notches at every join. Neighbouring prisms share
their end-face corners, so the surface is watertight, and the renderer draws the same points, so the
mesh is the surface rather than an approximation of it. Subdivision is bounded by both surface
deviation (4 mm, felt) and facet angle (4°, seen).

Chain arcs into S-bends and hairpins by placing the next instance at `curvedBeamExit`'s position
with `rotation.y = -heading`.

Difficulty on a curve is as much **camera** as footing: movement is camera-relative, so a tight
hairpin means swinging the view through 180° while holding a narrow line. Tune with radius before
width.

### Courses that were built, and are gone

`modes/parkour/src/showcase.ts` — **deleted with the kit (ADR 0027)**. Kept here as a record of what the
levers above produced when they were exercised, and as parameters to rebuild against. All three ran
**outside** the ground slab so stepping off was a real fall, tops flush at y = 0 so you walked straight on,
each obstacle preceded by a checkpoint pad that doubled as its entry platform.

- **Beam course**, +z from the slab edge: widths 1.2 → 0.8 → 0.4 m, pieces abutting, nothing to
  jump. Holding a line — an introduction, deliberately simple.
- **Pad course**, +x on the z = 0 line: generous (1.6 m pads / 1.5 m gaps) → standard (1.2 / 2.5)
  → long (1.0 / 3.2, near the envelope) → zig-zag (2.2 gap, 2.0 lateral ≈ 3.0 m diagonal) →
  ascending (2.2 gap, 1 m rise per pad).
- **Curve course**, +x on the z = 20 line: gentle sweep (r 12, 90°, 1.2 m wide) → tight reversed
  turn (r 6, −120°, 0.8) → S-bend with no rest between halves (r 5, ±90°, 0.6) → hairpin
  (r 4, 180°, 0.8). Built by chaining exit points, so the seams are exact by construction.

`gym.test.ts` checked **every seam between consecutive pieces** against the gap table, using rotated world
AABBs so turned pieces got truthful extents. The first version only checked jumps *within* a pad chain, which
is how a 5.4 m step to a goal pad shipped. Both are deleted; the lesson is the one worth keeping for whatever
replaces them — **check the seams, not the pieces**.
