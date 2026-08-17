# Obstacles

What the character can physically do, and the obstacle vocabulary built on it. Numbers here are
**measured** against the real controller, not derived — re-run
`packages/character/src/envelope*.test.ts` after any change to `DEFAULT_TUNING` or the KCC settings.

## Movement envelope

Tuning: `moveSpeed 5.5`, `jumpHeight 3`, `gravity 55` (Kodjo's values, above the Roblox reference).

| | |
|---|---|
| Air time per jump | 0.66 s |
| Capsule | 0.8 m wide, 2.0 m tall |
| Full speed reached in | 0.1 s / 0.275 m |
| Stop distance from full speed | ≈0.22 m |
| Step-up without jumping | **0.40 m** (autostep) |
| Step-up jumping | **3.0 m** |
| Walkable slope | ≤44°; ≥48° slides off |

### Max gap, edge to edge

| Landing vs take-off | Max gap |
|---|---|
| −2.0 m | 4.1 m |
| −1.0 m | 3.9 m |
| level | **3.5 m** |
| +0.5 m | 3.4 m |
| +1.0 m | 3.2 m |
| +1.5 m | 3.0 m |
| +2.0 m | 2.8 m |
| +2.5 m | 2.5 m |

≈0.35 m of reach per metre climbed, bought back by dropping. `modes/parkour/src/gym.test.ts`
encodes this table and asserts every authored jump in the level is inside it.

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
2. **Air control is strong.** 16.5 m/s² of steering over a 0.66 s hang redirects ~11 m/s mid-jump,
   so small landing targets are cheap to hit. Precision has to come from what happens *after*
   landing, or from what the body collides with in flight — not from landing dispersion.
3. **Run-up length is not a lever.** Full speed arrives in 0.275 m, which is why the measured
   standing gap (3.7 m) matched the running gap (3.6 m). Obstacles that try to deny a run-up do
   nothing.

Two further rules fall out of the numbers:

- **Autostep eats anything under 0.4 m.** A block or bar whose top is less than 0.4 m above the
  footing is simply walked over.
- **A 3 m apex hops most sweepers.** A bar is only a threat if it is ≥3 m tall, or sits under a
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

| Piece | Where | Parameters |
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

### Courses in the gym

`modes/parkour/src/showcase.ts`. Both run **outside** the 64 m ground slab so stepping off is a
real fall, with tops flush at y = 0 so you walk straight on. Each obstacle is preceded by a
checkpoint pad that doubles as its entry platform.

- **Beam course**, +z from the slab edge: widths 1.2 → 0.8 → 0.4 m, pieces abutting, nothing to
  jump. Holding a line — an introduction, deliberately simple.
- **Pad course**, +x on the z = 0 line: generous (1.6 m pads / 1.5 m gaps) → standard (1.2 / 2.5)
  → long (1.0 / 3.2, near the envelope) → zig-zag (2.2 gap, 2.0 lateral ≈ 3.0 m diagonal) →
  ascending (2.2 gap, 1 m rise per pad).
- **Curve course**, +x on the z = 20 line: gentle sweep (r 12, 90°, 1.2 m wide) → tight reversed
  turn (r 6, −120°, 0.8) → S-bend with no rest between halves (r 5, ±90°, 0.6) → hairpin
  (r 4, 180°, 0.8). Built by chaining exit points, so the seams are exact by construction.

`courses` is exported from `showcase.ts` in walk order. `gym.test.ts` checks **every seam between
consecutive pieces** against the gap table, using rotated world AABBs so turned pieces get truthful
extents. The first version of that test only checked jumps *within* a pad chain, which is how a
5.4 m step to a goal pad shipped; the seam check reproduces that failure if the pad is moved back.
