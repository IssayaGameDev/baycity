# ADR 0079 — The inertia layer believes only so much

Status: accepted. `GaitTuning.inertiaAccelCap` bounds the acceleration the humanoid's inertia layer responds to,
in m/s²; `GaitTuning.maxStrideRate` bounds the legs' cadence in strides per second; `inertiaUpperArmLateral`
weights the arms' sideways lag on its own, and an arm never rolls inward past vertical. The first two are off
(`Infinity`) by default and the weight defaults to what it always was; keyboard sets 55, 3.25 and 0.35.

## Context

At level 50 in keyboard the arms and torso swung violently against every movement. Kodjo asked for an
investigation of the whole procedural animation at speed.

Findings, in order of what he saw:

- **The inertia layer is the culprit.** Arms, torso and head lean against acceleration by `atan(a / 55)`
  (ADR 0018's layer, normalised so a walking-pace hard start of 55 m/s² reads as 45°). Nothing bounded the
  input. With Max Speed at 32 m/s every stick input reaches the controller's acceleration cap — 150 m/s² on the
  ground (ADR 0078), and 320 m/s² before that cap existed — so every start, stop and reversal threw the arms to
  70–80°. The pose was being fed three times the acceleration it was tuned for.
- **Cadence** is `speed / stride`, and stride stops growing at 5.5 m/s, so at 32 m/s the legs cycle about ten
  times a second against a 30 Hz tick. Kodjo first chose to leave it, tried the result, and asked for the cap.
- **Sideways, the arms went far too wide** (Kodjo, after the first two fixes). The inertia layer rolls both
  arms the same way against a sideways acceleration — one flies out, the other swings across the chest and
  through the torso — and the roll shared its weight (1.0) with the fore-aft pitch. Fore-aft lag is nearly
  invisible from a camera behind; a sideways roll is the most visible motion on the body. Same number, very
  different result. At this game's speed every strafe and turn is a hard sideways acceleration while the body is
  still swinging round to face the new direction.
- Everything else — lean, bob, arm swing, torso twist, the head and shoulder trail — already saturates at
  `runSpeed` or at its own `*LagMax`, and is fine.

## Decision

One gait value, `inertiaAccelCap`, applied to the measured acceleration before `atan`: the planar vector is
scaled down so the lean keeps the direction of the push, and the vertical component is bounded on its own.
Below the cap nothing changes, so with the default `Infinity` every shipped game is untouched.

Keyboard sets **55** — exactly the acceleration the layer was tuned at — so its poses never exceed what a hard
start at walking pace produces, however fast the character is moving.

An input cap rather than an output angle cap, because the formula already has a physical meaning (a pendulum
under acceleration) and the fix is to stop lying to it about the acceleration, not to clip its answer.

### The cadence cap

`maxStrideRate`, strides per second. Past it the stride is `speed / maxStrideRate` instead of `strideRun`, so
the legs cycle no faster and each step covers more ground. The IK still bounds how far a leg can actually reach,
so beyond that the feet slide rather than the legs flail. Keyboard sets 3.25, which is what 5.5 m/s over a 1.7 m
stride already produces, so nothing changes up to `runSpeed`.

### The arms, sideways

`inertiaUpperArmLateral` weights the roll; `inertiaUpperArm` keeps the pitch. Default 1, the shared value it
always was, so nothing moves elsewhere; keyboard sets 0.35, about 16° at the cap. The Inertia debug folder gets
the slider.

And, in every game: **an arm never rolls inward past hanging straight down.** Past vertical it is inside the
torso, which was a clip nobody had reported because at walking pace the roll never got there.

## Consequences

- Keyboard at speed: the arms lean as they do at level 1. Starts and stops read as starts and stops, not as
  being hit by a car.
- Legs cycle at 3.25 strides a second from `runSpeed` up; the steps lengthen instead.
- Strafing at speed: the outer arm lifts a little; the inner arm hangs. No arm through the chest, anywhere.
- 5 tests, two of them: an arm shoved either way never crosses vertical; the lateral weight cuts the sideways
  swing without touching the fore-aft. And the earlier three: a 40 m/s shove under a cap of 20 moves the arm less than 70% of the uncapped distance and a gentle
  push under the cap produces the identical pose; by default cadence at 30 m/s is over three times cadence at
  5.5; capped, it is the same, and below the cap nothing changes.

## Rejected

**Capping the output angle.** Clips a formula with a meaning instead of fixing its input.

**Lowering `inertiaStrength` for keyboard.** Scales every response down, including the walking-pace ones that
were right.

**Leaving the cadence alone.** Tried first at Kodjo's request; the strobe at speed was worse than long steps.

## Known open

- The head and shoulder trail sit at their `*LagMax` permanently at speed. Small, bounded, and not what was
  reported.
