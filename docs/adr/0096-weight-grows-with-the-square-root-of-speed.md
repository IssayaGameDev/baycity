# ADR 0096 — Weight grows with the square root of speed, and only when you lose it

Status: accepted. Refines ADR 0078, which introduced the two acceleration ceilings; both survive, one splits in
three and all of them now scale.

## Context

Keyboard's speed curve is `(0, 10) → (100, 210)` studs/s, linear and extended, so **Level 500 is 1010 studs/s
= 283 m/s** against Level 0's 2.8. A hundredfold range.

ADR 0078's ceilings are constants, and a constant ceiling cannot cross that. Stopping distance under one is
`v² / 2c`, so over a hundredfold speed climb it grows **ten thousandfold**. Measured against the shipped
numbers:

| Ceiling | Level 0 | Level 500 |
| --- | --- | --- |
| fixed 60 | 7 cm, 0.05 s | **667 m, 4.7 s** |

Nearly five seconds and two thirds of a kilometre to stop. And the shipped `groundMaxAccel: 150` does nothing
at all below 15 m/s — about Level 22 — because the time-based rate is smaller than the ceiling there. So Kodjo
tuning at low speed was only ever moving the air number, and nothing he found transferred upward.

## What the genre does

Kodjo put a short non-technical brief to his collaborators and had them measure Roblox and its imitators at low
and high speed. Their report:

| | Observed |
| --- | --- |
| Start | instant, at every speed |
| Stop | slides more and more the faster you go, heavy inertia |
| Turn | crisp but not instant, same inertia as stopping |
| Air | the faster you are, the harder it is to steer |

That is not one of the invariants that was on the table. It is **asymmetric**: gaining speed has no weight,
losing it has a lot, and the weight grows with speed without ever becoming unusable.

## Decision

**Three ceilings, split by what the change does to your speed.**

- `groundMaxAccel` — gaining speed on the ground. Keyboard leaves it `Infinity`: a start is instant.
- `groundBrakeMaxAccel` — losing or redirecting it. New. A release, and every turn.
- `airMaxAccel` — steering in the air, which is all inertia.

**Which one applies is decided by projection, not by magnitude.** The component of the needed change along the
current direction of travel: negative means it fights momentum, which is what braking *and* turning both are.
Comparing magnitudes was tried first and is wrong halfway through a reversal — by then the target is larger
than the speed left, so it reads as a start and rounds the character at the uncapped rate.

**Every ceiling scales.** `ceiling(v) = ceiling × (v / ACCEL_REF_SPEED) ** maxAccelScaling`, with
`maxAccelScaling` defaulting to **0.5** — Kodjo's choice from the table below.

| scaling | ceiling | time to stop | stop distance, Level 0 → 500 |
| --- | --- | --- | --- |
| 0 | fixed | grows with `v` | 7 cm → 667 m |
| **0.5** | grows with `√v` | grows with `√v` | **4 cm → 42 m** |
| 1 | grows with `v` | constant | 14 cm → 14 m |

`ACCEL_REF_SPEED = 15` m/s, because that is where ADR 0078's fixed ceilings first bit at all, so numbers tuned
under the old model keep their meaning at the speed they were tuned at.

Keyboard ships `groundBrakeMaxAccel: 200`, `airMaxAccel: 60`, scaling `0.5`: stopping 0.03 s at Level 0 and
0.33 s at Level 500, air steering 0.11 s to 1.1 s.

## Rejected

- **Constant time** (scaling 1, or no ceiling). Perfect transfer across speed and no weight at all — a 283 m/s
  character turns on a dime. This is what ADR 0078 was written to escape.
- **Constant distance** (scaling 2, ceiling growing with `v²`). "Always four metres to stop", every Level.
  Transfers the thing a player actually sees, and makes a fast character react *quicker in time* than a slow
  one, which reads as floaty.
- **Keeping one ground ceiling for both directions.** The reason the split exists: one number cannot give
  instant starts and a long slide, and the shipped 150 was a compromise that did neither well.
- **Scaling the times instead of the ceilings.** `groundAccelTime` and `groundStopTime` are already
  speed-relative, so scaling them again double-counts. The ceiling is the thing that is absolute.
- **A per-game curve rather than one exponent.** A curve is what ADR 0088 exists for and it would be four
  points to author where one number does. Revisit if 0.5 turns out to be wrong in different places.

## Consequences

- `CharacterTuning` gained two fields. Every game but keyboard leaves all three ceilings `Infinity`, which
  short-circuits the scaling entirely, so parkour, swing and the template are bit-for-bit unchanged — asserted.
- Uncapped is **not** instant. The time-based rate still applies, so a reversal past its turnover point takes
  `moveSpeed / groundAccelTime` and not zero.
- A reversal now runs at two different rates: braking down, then accelerating away. That is what it is.
- The keyboard debug pane's Movement folder lost its ground-accel slider (there is nothing to cap) and gained
  a brake slider and the scaling exponent.
- ADR 0078's tests kept their subject but not their numbers: the uniform-cap-across-a-whole-reversal
  assertion is now false by design, and reads only while the character is still slowing.
- Two hazards at 283 m/s are noted and **not** addressed here: a ±1000 m network bound is 3.5 seconds of
  running (ADR 0093), and one 60 Hz tick is 4.7 m of travel. Kodjo has stress-tested the second and reports
  the physics holds; the first is accepted for now.
