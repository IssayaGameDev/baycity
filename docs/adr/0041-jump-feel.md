# ADR 0041 — Jump feel: an exact arc, a shaped one, and two forgivenesses

Status: accepted. Extends ADR 0012's locomotion and ADR 0034's coyote time. Follows an investigation of
the current jump, of Roblox's, and of the published platformer literature.

## Context

The jump was measured rather than reasoned about. Eight findings, in the order they matter:

1. **The apex was 10% short of the slider.** `jumpHeight 3` flew as **2.700 m**. The vertical step was
   `y += v·dt`, which for a constant acceleration undershoots by `½·g·dt²` per tick; over a rise that
   accumulates to `½·v₀·dt` — half a tick of take-off speed, 0.303 m at these numbers, against 0.300
   measured. The number in the pane could not mean what it said.
2. **A tap shorter than one tick was thrown away.** Jump was read as a *level* (`keys.has('Space')`,
   `jumpId >= 0`) at tick time. A press and release inside one 33 ms tick never appeared in either. A 20 ms
   tap was lost about 40% of the time. Both input paths, keyboard and touch.
3. **No jump buffer.** A press before landing was discarded outright.
4. **Air authority is weak, and correctly so.** Killing 5.5 m/s of momentum costs
   `groundAccelTime/airControl` = 0.33 s, which is exactly the time to apex; a full reversal takes the whole
   0.66 s hang and completes as you land. ADR 0012's "can't stop/reverse" is accurate. Recorded because it
   was briefly misread as strong during the investigation.
5. **The arc is a plain symmetric parabola** — 10 ticks up, 10 down, no fall bias, no apex float, no
   variable height. Height 0.74× the length: a very vertical arc.
6. **A coyote jump off a mover dropped the mover's momentum**, because the live `ride` it is taken from
   needs footing, and footing is what the coyote window replaces. Flagged when coyote time shipped
   (ADR 0034) and now closed.
7. **Air input braked a character flying faster than `moveSpeed`.** The air solve is
   `approach(v, moveSpeed·dir, rate·dt)` per axis, and `approach` pulls toward the target from *either*
   side. So once lift momentum storage started handing over a mover's fling, holding the direction of
   flight was a brake: launched at 12 m/s, holding forward travelled **5.02 m** against **8.40 m** for
   letting go of the stick. Pressing the way you are going cost three and a half metres. Found while
   researching air-control practice, not while playing — nothing in the game surfaced it.
8. **Corner correction is not needed here.** Measured: a run-up into a step-up lands on top from 15 of 16
   take-off points, at every height from 1.5 m to 2.9 m, including above the theoretical reach. The capsule's
   top is a hemisphere and its contact normal is diagonal, so Rapier slides it off a corner on its own, and
   autostep covers 0.4 m more. The technique exists for axis-aligned boxes in 2D, where a two-pixel overlap
   stops all vertical motion; it does not transfer.

Roblox was examined as the reference (ADR 0012 named it). Its legacy `Humanoid` is a **dynamic** assembly
held upright by a balance force and floated at `HipHeight` by a leg spring; `JumpPower = √(2·g·JumpHeight)`
is the same conversion this controller uses. The newer Character Controller Library replaces it with
`ControllerManager` + `GroundController`/`AirController`, adding ground friction, acceleration curves and
momentum conservation on jumps — the same problems addressed here. Roblox ships **none** of the assists:
no coyote time, no buffer, no variable height, no apex modifier. ADR 0012 already rejected its architecture,
so nothing structural was taken from it.

## Choice

**The vertical step is the trapezoid `½(v₀+v₁)·dt`** — the exact integral for constant acceleration, and
the same closed form as the `½at²` term. Written as an average of the endpoints rather than as `v·dt + ½at²`
because the terminal-velocity clamp can bend `v₁`, and the average stays correct when it does.

**Except while settling**, where the full `v·dt` is kept. Resting on a surface, `vy` is clamped back to 0
every tick, so nothing is being integrated: the downward number is not motion, it is the nudge that holds
the capsule in contact. Halving it to the exact value **measurably destabilised the controller** — Rapier
began dropping slices of the *horizontal* step (`CONTACT_NUDGE`: the start has to not be touching), and
platform carry crept 33 mm over 3 s where it had held to the millimetre. Keyed on the ground **probe**, not
on `state.grounded`: the flag is last tick's answer and is `false` on a fresh character, so a capsule seating
for the first time took the exact value, settled at a different depth, and stayed flaky from then on. That
one tick was the whole regression.

**`jumpHeight` is 2.7, and the jump did not change.** With the integration exact, the apex is the number, so
the number was set to the apex that had always been flying (measured 2.695, 99.8%). Reach and hang are
unchanged. Typing 3.0 is a real change for the first time: +0.30 m of apex, +0.18 m of reach, one more tick
of air. Which value to run is Kodjo's; preserving today's jump is the choice that decides nothing.

**Both input paths latch the press.** `jumpLatch` in the mode (`keydown`, `e.repeat` excluded) and
`drainJumpPress()` in `touchControls`. Both are drained every tick whether used or not, dead or alive, so a
press made during a pause cannot surface later as a jump. The level reads stay, because they are what makes
holding the button re-jump on landing (ADR 0022).

**`jumpBuffer` mirrors `coyote`.** Refilled while the button is down, counted down otherwise, spent when the
jump fires. `coyote` forgives a press that is slightly late, the buffer one that is slightly early, and the
gate is now `jumpBuffer > 0 && (grounded || coyote > 0)`. The buffer is also what keeps a one-tick latched
tap alive long enough to be spent.

**Lift momentum storage** keeps the departed surface's velocity for `liftStoreTime` and hands it to a jump
that no longer has a live `ride`. Read from the same `ride` the on-time branch uses, so a late jump and an
on-time one inherit the same thing. Matched to `coyoteTime` deliberately: its whole job is to make the
coyote jump behave like a normal one, and a different number would just move the inconsistency.

**The arc ships shaped, at the literature's starting values**: `fallGravityScale` **1.6**,
`apexGravityScale` **0.5** over an `apexSpeed` **4 m/s** window, `jumpCutScale` **0.4**. Each reverts on its
own to an inert value (1 for all three), so any one can be switched off without disturbing the others.

They were first shipped at those inert values, on the reasoning that an assist only widens an input window
while reshaping the arc changes what the jump *is*, and the latter is a design decision. **That was the wrong
call and it was reverted the same day.** A default is not a decision — it is a starting point that reverts
with one drag of a slider, and the person tuning it said so. What shipping-at-inert actually delivered was
six features of which three did nothing when the game was launched, which is not a delivery. The rule it came
from ("never make design decisions") is about not *overriding* Kodjo, not about refusing to pick a starting
point he can see and change.

The assists — coyote time, the buffer, lift storage — ship on for the original reason, which still holds:
they can only turn a press that was discarded into the jump the player asked for.

**Speed above `moveSpeed` is not air control's to spend.** The air solve splits the horizontal velocity
into `moveSpeed` worth of it, which is steered exactly as before, and the **excess**, which is carried
through the tick untouched and added back along the direction it came in on. Measured consequences:
holding the direction of flight now matches coasting to the millimetre (8.40 m either way); pressing
against it still brakes to 0.45 m/s; peak speed never exceeds what you came in with, in any input
direction; distance falls monotonically with turn angle (8.40 → 6.00 → 5.81 → 4.17 m at 0/45/90/180°);
and below the cap the branch does not fire, so ordinary jumps are bit-for-bit unchanged — which is why
the measured envelope did not move.

The design space this comes from is worth recording, because "air control" is one number here and three
everywhere else. Smash Bros splits **air acceleration**, **max air speed** and **air friction** into
independent values, and states the rule this controller already followed: acceleration is the same
whether you are speeding up, slowing down or reversing, because separate rates make turning mid-air
lurch. Roblox's `AirController` is force-based — `MoveMaxForce` (default 1000) with
`MaintainLinearMomentum` deciding whether releasing input brakes you to a stop; the legacy `Humanoid` has
no air-specific property at all. Ours: one `airControl` scalar over the ground rate (16.5 m/s²), max air
speed borrowed from `moveSpeed`, air friction 0. The borrowed cap is what caused finding 7.

**The camera dip on landing** is the one piece of jump feel outside the controller: the character stops dead
on contact and the camera continuing down for a moment is what sells the weight. Scaled by impact speed
over a plain jump's landing speed, so 1 is landing your own jump. `landKick` is **0.12 m**, the middle of the
0.10–0.15 range that reads as an impact rather than as a bob; 0 turns it off.

## Consequences

- **`CharacterTuning` gains six fields, `CharacterState` four.** Every tuning literal in the repo is a
  `{...DEFAULT_TUNING}` spread, so nothing else needed touching.
- **The apex assertion is now ±1%**, down from a `0.8×–1.3×` band that existed only to accommodate the
  integration error and would have hidden the next one.
- **The measured envelope widened by ~0.5 m** and `obstacles.md` is updated: running gap 3.6 → **4.1 m**,
  level gap 3.5 → **4.0 m**, step-up and autostep unchanged. It is the apex float — half gravity through the
  `|vy| < 4` band adds ~0.15 s of air near the top, worth ~0.8 m of reach, against ~0.35 m handed back by
  the heavier fall. Every authored jump got *easier*; nothing became unreachable. Take-off speed also moved,
  derived from `jumpHeight`: 18.2 → 17.2 m/s, which is the bumper legibility threshold too — a `power` below
  17.2 now throws lower than a jump.
- **The measured envelope is unaffected by the air-excess rule**, because the envelope harnesses never
  exceed `moveSpeed` — they run on flat ground. It only ever engages after a mover's fling or a launch.
- **Measuring the envelope means holding the button.** With `jumpCutScale` live, the envelope harnesses'
  one-tick press became a deliberate short hop and the running gap read 2.5 m. They hold while `vy > 0` now.
  The same trap caught the ceiling test, where a cut jump never reached the roof at all.
- **Tests that pin the plain parabola use a `NEUTRAL_ARC` tuning**, since the integration guarantee is
  "apex == jumpHeight" and the shipped apex float deliberately coasts ~0.14 m past it.
- **Nothing new on the wire.** All of it is local to the client that owns the character (ADR 0011).
  `STATE_GROUNDED` still means real footing; a character inside its coyote window is airborne.
- **A test detector for a repeated jump must measure against gravity, not against the previous `vy`.** A
  jump re-firing every tick pins `vy` to a constant, which "did `vy` rise?" reads as no jumps at all.
  Inherited from ADR 0034 and still the trap in this file.
- **Audio is still absent everywhere in the game** — no playback call exists in any package, though sounds
  are an asset kind and the editor auditions them. The literature puts audio among the largest contributors
  to jump feel, and it is the one recommendation from the investigation left unbuilt: it needs content
  decisions, not code.

## Rejected

**Corner correction on a head bump.** Measured as unnecessary — see finding 7. Building it would have meant
lateral retry sweeps in the physics wrapper, risking the ceiling stop, for no measurable gain.

**Making the settling nudge exact too.** The physically correct value, and it is what caused the carry
regression. The nudge is a contact device, not an integration.

**Retuning the retry threshold in `move` instead** (it only fires below 90% loss, and the dropped slices were
94%). Would have touched every caller of the physics wrapper and risks the autostep-climbing side effect its
own comment warns about. The targeted fix is in the character.

**Shipping the arc knobs inert.** Tried first, reverted the same day — see the choice above. It delivered
sliders at their neutral value and no way to feel the arc they were built for.

**Leaving the apex window ungated.** A resting character sits at `vy = 0`, which is inside any apex window,
so the first version quietly halved gravity while standing still — and that number is the contact nudge, so
it reproduced the platform-carry creep by a second route. The window is gated on having no ground underfoot:
the apex of a jump is not the top of a stand.

**Quake's projection cap for the above-`moveSpeed` case.** Cap the projection of velocity onto the
acceleration direction rather than its magnitude, and turning while accelerating *gains* speed — that is
air-strafing, and the skill ceiling that comes with it. Rejected because every reach number in
`docs/obstacles.md` is a straight-line measurement, and a movement system that can exceed it silently
invalidates authored gaps. The corrective family (Mario, Celeste, Smash) is the right one for a course
with authored distances.

**Stretching the air *target* to the current speed** when the input agrees with the motion. The first
attempt, and it fed back on itself: the target is recomputed from the live speed each tick, so a 90° turn
conserved speed instead of costing it and a fast mover could be redirected losslessly. Air-strafing
arriving by the back door. Splitting off the excess has no feedback path.

**Giving air its own `maxAirSpeed` and `airFriction`** as Smash does. The larger, more honest fix, and
still open: it would also decouple air acceleration from `groundAccelTime`, which currently means
retuning ground accel silently retunes the air. Not done because the bug did not require it and three new
feel values would need Kodjo. Recorded as the next step if the air ever needs its own character.

**Deriving the apex float from a height threshold** rather than from vertical speed. Speed is what the
integrator already has, needs no knowledge of where the jump started, and works identically for a bumper
launch and a fall off a ledge.
