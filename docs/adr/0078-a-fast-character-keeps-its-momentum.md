# ADR 0078 — A fast character keeps its momentum

Status: accepted. `CharacterTuning.groundMaxAccel` and `airMaxAccel` cap horizontal acceleration in m/s². Off
(`Infinity`) by default; keyboard sets 150 and 40 and exposes both sliders.

## Context

Once Max Speed actually reached the character (ADR 0071's correction), Kodjo at level 52 was running at 32 m/s
and reported: at high speed the character is far too sensitive, there is total control, and no momentum carries
from running flat out one way to running flat out the other.

The cause is one line. Ground acceleration is `moveSpeed / groundAccelTime`, and the stop and air rates are
built the same way. They are **times**, so they scale with the speed: a character ten times faster accelerates
and reverses ten times harder and steers exactly as it did at walking pace. At 5.5 m/s that is the shipped feel;
at 32 m/s it is 320 m/s², a full reversal in 0.2 s, and a right-angle turn with no arc.

## Decision

**Caps in m/s², not a change to the time-based rates.**

Two of them. `groundMaxAccel` bounds ground acceleration and ground braking; `airMaxAccel` bounds the air rate.
Below a cap nothing changes, so the shipped games — one speed each, tuned by eye — are untouched with the
default `Infinity`. Above it, reaching speed and reversing take `speed / cap` seconds, and turning at speed is an
arc because velocity can only swing so fast.

Two rather than one, from play: a single cap of 40 gave the air its momentum and made the ground feel heavy.
Kodjo's read was that this is mostly an air thing, and the ground wants snap. One number cannot be both.

Keyboard sets **150 on the ground and 40 in the air**. At level 1 (3.4 m/s) the time-based rate is 34 m/s²,
under both, so the first levels feel as before. At 32 m/s a ground reversal takes 0.4 s instead of 0.2 and an
air reversal 1.6 s. The numbers are Kodjo's to feel, so they are the two movement sliders in keyboard's
Progression folder, bound to the client's live tuning.

Why a cap rather than re-tuning the times: the times are the right model at one speed — Kodjo tuned them — and
the wrong one across a 10× range. A cap keeps the tuned feel where it was tuned and adds a physical ceiling where
the times stop meaning anything.

### Steering is one vector, not two axes

The first build of the cap sent Kodjo in circles: press forward, back, forward, back, and the character walked a
ring, worse the further the camera was from axis-aligned. The controller approached the target velocity **one
axis at a time**, x and z each by at most `rate × dt`. With rates in the hundreds both axes arrived within a
tick and the split never showed. Under the cap the axis with less to do finished first while the other kept
going, so the velocity swung off the line the stick was pushing — a diagonal reversal traced a curve, and
alternating reversals a circle.

Now the velocity moves toward the target along the difference vector, by at most `rate × dt` in magnitude
(`approachVec`). Direction is preserved and the time to arrive no longer depends on which way the camera faces.
A side effect worth naming: a diagonal used to reach full speed √2 faster than a cardinal, per axis; it no
longer does. Every shipped position test still passes to its tolerance.

## Consequences

- Keyboard at speed: momentum carries, turns arc, reversing takes real time. The skill curve ADR 0071 described
  — fast is hard to steer — now exists.
- Parkour, swing, `_template`: unchanged in feel; a diagonal no longer accelerates √2 harder than a cardinal.
- 5 tests: off by default reproduces the old six-tick reversal; the ground cap bounds the change per tick and
  the reversal takes `speed / cap`; a cap above the time-based rate changes nothing; a capped reversal along a
  30° diagonal stays on that diagonal to 1e-6; a ground cap leaves the air alone and an air cap binds only there.

## Rejected

**Scaling `groundAccelTime` with speed.** The same cap expressed backwards, and it would move the shipped feel.

**Lowering `airControl` for keyboard.** Air only; the ground reversal was the complaint.

**Quake-style projection.** Air-strafing, rejected already in the controller (see `stepCharacter`).

## Known open

- Braking to a stop is capped by the same number as ground accelerating. If stopping should be sharper than
  turning, that is a third value.
- 150 and 40 are first guesses.
