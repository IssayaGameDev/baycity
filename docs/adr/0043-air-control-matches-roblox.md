# ADR 0043 — Air control equals ground control, as Roblox's does

Status: accepted. Sets the `airControl` value ADR 0041 left at 0.3. Kodjo's call, asked for by name.

## Context

Kodjo's one complaint about the air was that it could not stop: jumping at full speed and immediately
pressing the other way, "the character barely has the time to stop going in the first direction before
dropping to the ground". Measured at `airControl 0.3`, that was right — 0.40 s to reach zero and 0.70 s to
reverse, against a 0.73 s hang. The reversal completed as you landed.

He then asked for Roblox's feel specifically. So the Roblox side was established rather than guessed:

- **Legacy `Humanoid` has no air-specific property at all.** `WalkSpeed` applies in the air unchanged.
- **`AirController`** (the Character Controller Library) exposes `MoveMaxForce` **1000**,
  `MaintainLinearMomentum` **true**, `MaintainAngularMomentum` **true**, `TurnMaxTorque` **10000**,
  `TurnSpeedFactor` **1**.
- **`GroundController`** has no move-force cap at all, `AccelerationTime` and `DecelerationTime` both
  **0** — instant — and `TurnSpeedFactor` **1**.
- `ControllerManager`: `BaseMoveSpeed` **16**, `BaseTurnSpeed` **8**.

`TurnSpeedFactor` is **1 in both**, so Roblox does not restrict air steering at all; the only air/ground
asymmetry is that the air goes through a force cap where the ground is instant. Air is a *softer* version of
ground, not a *restricted* one. `MaintainLinearMomentum` true means releasing input preserves momentum,
which this controller already did (air friction 0).

## Choice

**`airControl` is 1** — air acceleration equals ground acceleration, 55 m/s². That is the Roblox model as
closely as a kinematic body can express it: on a kinematic body a force cap collapses to an acceleration
cap, which is what `airControl` already is, so there is nothing else to port.

Measured: stopping 5.5 m/s costs **0.17 s** and a full reversal **0.23 s**, inside a 0.73 s hang.

The excess rule from ADR 0041 stays: speed above `moveSpeed` is not air control's to spend. It is the same
property `MaintainLinearMomentum` describes, and it is what keeps a mover's fling from being braked away by
holding the direction of flight.

**The SM64-style angular turn-rate cap is not built.** It was proposed, and it was aimed at the wrong axis:
it makes *turning* slower, where the complaint was about *braking*, and Mario 64's own backward
deceleration (13.5 m/s²) is weaker than what was already here. The proposal also rested on a claim that the
air felt "loose", which was an invention — nobody said it. Left unbuilt.

## Consequences

- **Run-up is worth nothing, and a jump no longer commits to a direction.** Full speed can now be built
  *in the air*, so the measured standing gap (**4.4 m**) beats the running gap (**4.0 m**) — a standing jump
  accelerates through its whole arc. This is the price of Roblox-like air control and it is the main thing
  level design has to absorb; `obstacles.md` says so where the numbers are.
- **The envelope widened again**: level gap 4.0 → **4.1 m**, jumping step-up 3.0 → **3.1 m**, and the
  standable band on curved tops went from ±40° to ±50–60° from the crown, because landing on things is
  easier when the arc can be steered freely. Everything got easier; nothing authored became unreachable.
- **Two tests were wrong, not regressed.** One asserted `hypot`, which cannot distinguish a stop from a
  completed reversal — at full air control the character does reverse, and 5.5 m/s backwards has the same
  magnitude as forwards. The other bounded the walk-across-a-mover offset at 0.1 m, which was luck about a
  starting position rather than a guarantee: the same 3 m/s platform at `airControl 0.3`, entered from
  z = 0.11 instead of z = 0, gives 0.1169. Loosened to 0.15 with that control recorded in the comment. The
  per-tick slip tests (1/3/4.5/9 m/s) are what guard a real carry regression and they are untouched.

## Rejected

**An angular turn-rate cap (Mario 64's model).** 84°/s against the ~250°/s measured here. It is what makes a
3D jump feel committed, and it is the opposite of what was asked for. Available if Kodjo ever wants the
committed end of the spectrum instead.

**Splitting air braking from air acceleration** so pressing against the motion decelerates faster than
pressing with it accelerates. The direct answer to "I cannot stop", and unnecessary once both are 55 m/s².
Multiple sources also warn that asymmetric rates make turning mid-air lurch.

**Giving air its own `maxAirSpeed` and `airFriction`** (Smash's three-value split). Still the more honest
structure — air acceleration is derived from `groundAccelTime`, so retuning the ground silently retunes the
air — and still not needed by anything.
