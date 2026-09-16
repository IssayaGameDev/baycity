# ADR 0107 — The air is not free

Status: accepted. Adds one field to `CharacterTuning`; off by default, so [ADR 0043](0043-air-control-matches-roblox.md)'s
behaviour is what every other game still gets. Interacts with [ADR 0096](0096-weight-grows-with-the-square-root-of-speed.md).

## Context

Kodjo asked what happens in the air when the stick is released. The answer was nothing: the horizontal solve
was `if (grounded) {…} else if (hasInput) {…}`, so with no input no code touched `vx`/`vz`. Speed was held
exactly until landing, which is Roblox's `MaintainLinearMomentum` and was deliberate (ADR 0043).

He wants the air to cost something, and chose the strong form: it slows you whether or not the stick is held,
and it slows a mover's fling or a bumper too.

## Decision

`airDrag`, a **fraction of horizontal speed per second**, applied every airborne tick as
`vx, vz *= 1 / (1 + airDrag · dt)`. `DEFAULT_TUNING` 0 (off); keyboard 0.5, live on the Movement folder.

Three choices inside that:

**Proportional, not an m/s² brake.** Keyboard's speed climbs a hundredfold across the Level curve, 2.8 m/s to
283 m/s. That is the arithmetic that already forced `maxAccelScaling` to exist (ADR 0096): a fixed m/s² is 7 cm
of effect at Level 0 and hundreds of metres at Level 500. A fraction per second means the same thing at every
speed, so one slider spans the range with no scaling term. Measured reach cost is identical — −1.6 % holding
the stick, −16.2 % coasting — at 2.8, 5.5, 30, 100 and 283 m/s.

**After the steering, so the protected excess decays.** ADR 0096 forbids *air control* from spending speed
above `moveSpeed`, because pressing the way you are flying must not brake a fling. Drag is not air control: it
is not input-driven and cannot be avoided by letting go, so exempting the excess would leave a 100 m/s fling
coasting forever. It is placed before the ride/launch inherit, so the tick you leave a mover hands you its
velocity whole and drag starts on it the tick after.

**Implicit, `1 / (1 + k·dt)`, not `1 − k·dt`.** `k` is a live slider on a 30 Hz tick; the explicit form flings
the character backwards once `k·dt > 1`. The implicit form approaches zero, never reaches it, never reverses.

## What it does not do

Holding the stick costs 1.6 % of reach, not more, because air control re-accelerates toward `moveSpeed` and
refills the tick's loss on the next tick. The drag bites on a release and on anything above `moveSpeed`, which
is where Kodjo's question started. Making a held stick cost more is a separate decision — a lower `airControl`,
or a drag that outruns the air accel ceiling — and was not taken here.

`DEFAULT_TUNING` stays at 0, so the measured envelope in
[`platform/humanoid/controller.md`](../platform/humanoid/controller.md) is unchanged and no authored parkour or
swing gap moves. Only keyboard opts in.

## Rejected

- **A fixed m/s² air brake** (`airBrakeMaxAccel`, a fourth ceiling alongside the three). Symmetrical with the
  existing ones and it can reach a dead stop mid-air, but it needs the `√speed` scaling treatment to survive
  the Level curve, and even then one quoted number means a different feel at each end.
- **Drag only when the stick is released.** The cheap option: it gives a release its cost and leaves every
  measured reach number and every authored gap untouched. Kodjo chose the stronger form knowingly.
- **Drag sparing the excess**, keeping ADR 0096 exact. A fling that never slows.
- **Vertical drag.** Gravity, `fallGravityScale`, `apexGravityScale` and `maxFallSpeed` already shape the
  vertical (ADR 0041); a fifth term there would fight four tuned ones.
