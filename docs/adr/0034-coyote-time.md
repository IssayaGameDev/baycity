# ADR 0034 — Coyote time, and two vertical stops the jump was missing

Status: accepted. Extends the locomotion of ADR 0012; the feel numbers are Kodjo's and live on the pane.

## Context

Reviewing the controller turned up three things, one asked for and two defects.

**Asked for: coyote time.** The jump gate was `cmd.jump && state.grounded`, and `grounded` is read as of the
end of the previous step. At 30 Hz that is a 33 ms quantum with no grace at all: a press aimed at the last
frame of a ledge either lands on a grounded tick or is discarded silently.

**Defect: the rise had no upper stop.** `vy` was zeroed on landing (`grounded && vy < 0`) and by nothing on
the way up. Jumping into a low roof left `vy` positive with nowhere to go, so the character pushed into the
ceiling for the remainder of its hang time and reported `STATE_RISING` the whole way — which the animation and
every peer read as still climbing.

**Defect: the fall had no cap.** Gravity integrated without bound. Invisible in the shipped levels because a
kill plane ends the fall near 30 m/s, and unbounded on a `physical-fall` level, which has no kill plane.

## Choice

**Coyote time is a countdown in `CharacterState`, not a timestamp.** `coyote` holds the seconds of grace left:
refilled to `tuning.coyoteTime` on every tick with footing, decremented otherwise, and the gate becomes
`state.grounded || state.coyote > 0`. A countdown rather than "when did footing end" because the slider can
move mid-air, and a refill re-reads the current value every grounded tick instead of comparing against a
duration captured earlier.

**The grace is spent on the way out** (`if (leaving) state.coyote = 0`), and the refill is additionally gated
on `!leaving`. Both are load-bearing and neither subsumes the other:

- Without the spend, the counter keeps decaying while airborne and a **held** button gets a second jump one or
  two ticks after the first. Measured at 4 jumps out of one ground jump over 12 held ticks.
- Without the `!leaving` on the refill, a jump's first tick can still report footing — the sweep starts on the
  surface it is pushing off — and the refill hands back the grace the spend just took.

`coyoteTime: 0` reduces the gate to exactly the old behaviour, so the feature switches off cleanly.

**`coyote` is separate from `grounded`.** `grounded` stays the honest answer to "is there ground under us": it
is what `STATE_GROUNDED` puts on the wire and what the animator reads, and a character inside its coyote
window is in the air. Nothing about coyote time reaches the protocol.

**A roof stops the rise, detected from contact normals.** `CharacterBody.move` now returns `ceiling` beside
`grounded` — the step asked to rise and a contact's outward normal points down past `CEILING_NORMAL_MAX_Y`
(−0.5). `stepCharacter` zeroes `vy` on it, mirroring the landing clamp one line above.

Not detected by comparing `applied.y` against `desired.y`. Autostep and snap-to-ground both move the capsule
vertically on their own, so a shortfall cannot distinguish a roof from either of those, and a false positive
there kills a jump on its first tick.

**Terminal velocity is `tuning.maxFallSpeed`, clamped after gravity and before the mover-velocity inherit**, so
it bounds the fall and never clips a jump or a bumper launch — both of those are a positive `vy`.

## Consequences

- **`CharacterTuning` gains `coyoteTime` (0.1 s) and `maxFallSpeed` (60 m/s)**; `CharacterState` gains
  `coyote`. Every existing tuning literal in the repo is a `{...DEFAULT_TUNING}` spread, so nothing else
  needed touching. Both are sliders in the parkour pane with the rest of the feel values.
- **60 m/s is a safety net, not a feel value.** It is above anything the shipped levels reach and equals 2 m of
  travel per tick at 30 Hz, which is already past the controller's 0.4 m snap-to-ground reach and thicker than
  most authored slabs — the swept resolve is the only thing left holding the character out of the floor.
  Lowering it changes how a long drop feels, which makes the number Kodjo's.
- **A coyote jump off a moving platform does not inherit the platform's velocity.** The inherit comes from
  `ride`, which needs a live movement base, and the base is released by the same lost footing that opens the
  window. So a late jump off the fast mover drops the momentum a normal jump would have kept. Flagged to Kodjo
  before building and left as-is deliberately: fixing it means holding the last base pose across the window,
  which is state and a decision about how stale a frame may be, for a case that may never be felt.
- **The controller's air authority is unchanged and remains weak**, which is worth writing down because it was
  briefly misread as strong during this review. Air accel is `moveSpeed/groundAccelTime × airControl` =
  16.5 m/s²; killing 5.5 m/s of momentum takes `groundAccelTime/airControl` = 0.33 s, which is exactly the
  0.33 s to apex, and a full reversal takes the whole 0.66 s hang. So a mid-air reversal completes as you land.
  ADR 0012's "nudge your arc, can't stop/reverse" is accurate.
- **Test detectors for a repeated jump have to measure against gravity, not against the previous `vy`.** A jump
  re-firing every tick pins `vy` to a constant, and "did `vy` rise?" reads that as no jumps at all — the first
  version of the held-button test passed with the guard deleted. It now counts ticks where `vy` lands above
  where gravity alone would have put it, with a speed floor so the grounded `vy < 0 → 0` clamp cannot count.

## Rejected

**Jump buffering** (remembering a press made just *before* landing, and firing it on touchdown). The sibling
technique and the natural pair to coyote time, deliberately not built: it was not asked for, and it needs its
own window number. Cheap to add on the same counter pattern if Kodjo wants it.

**A timestamp for coyote time** (`lastGroundedAt`, compared against `now`). Needs a clock in a function that
currently takes only `dt`, and reads stale if the slider moves while airborne.

**Deriving `ceiling` from `applied.y < desired.y`.** No physics-layer change, and wrong: autostep and
snap-to-ground make a vertical shortfall ambiguous, and guessing wrong ends a jump on its first tick.

**Clamping the fall inside the physics wrapper.** Terminal velocity is locomotion feel, and the wrapper owns no
feel values — it would also have applied to any other kinematic body that later used `move`.
