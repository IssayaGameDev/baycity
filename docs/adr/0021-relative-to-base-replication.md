# ADR 0021 — A rider replicates in its platform's frame, not the world's

## Context

Kodjo, watching another player stand idle on a moving platform: it looked right while the platform
travelled, and at each reversal the rider visibly slid across the deck and settled.

Two things that have to agree were drawn on different clocks. The level is simulated locally from the
synced clock and drawn at *now* (`loaded.update(simClock.tick())` then `render(alpha)`). Peers are drawn
at *now − 100 ms* (`interpolationDelayMs`). So a rider was placed where they were 100 ms ago, on a deck
drawn where it is now, and their spot on the deck was wrong by whatever the deck travelled in 100 ms.

The shape of the artifact follows from that exactly, and explains why the constant phase looked fine:

- The **error** is proportional to the platform's velocity. `movePosition` eases as `(1 − cos)`, so
  velocity peaks mid-travel — that is where the rider is most displaced, up to 94 cm on the 12 m / 4 s
  mover. Nearly static there, and with nothing to compare against it reads as standing slightly off.
- The **change** in the error is proportional to acceleration, which peaks at the ends of the travel.
  That is the slide, about 1.5 m/s on the same mover.

It is not latency in the sense of the network being slow: a zero-latency connection with the same
interpolation delay shows the identical artifact.

## Choice

**Replicate the rider's transform in the platform's frame, with the platform identified** — the
industry-standard fix. Unreal does it by default (`CharacterMovementComponent` tracks a `MovementBase`,
and `ACharacter` replicates relative location and rotation instead of absolute while that base is
dynamic); Source-family engines get the same result by parenting the player to the mover. Roblox does
*not* — it replicates world CFrames under client ownership, and has this exact artifact.

Why it beats correcting the position locally, which would have cost no bytes at all (a viewer can probe
what is under a peer and re-time it, since the behaviours are closed-form in time):

- **It fixes the facing too.** A rider on the turntable lags 4.5° at an 8 s period for the same reason.
  Base-relative facing removes that; a position-only correction does not.
- **It does not depend on the platform's motion being analytic.** Today any client can evaluate
  `movePosition` at any instant. The day a platform is physics-driven or player-pushed, a local
  correction stops working and this does not.
- **No guessing.** A probe misattributes at a deck's edge or under stacked geometry, and a wrong base is
  a visible jump.

**One byte: `base` = `LoadedLevel.baseIndex + 1`, 0 for none** (protocol v10). While it is non-zero the
position and yaw are in that piece's frame. Cost measured, not estimated: snapshot entities 11 B → 12 B,
and the load harness 3.5 → 3.7 kB/s per client at 20 bots, against a 20–30 kB/s budget.

**An index the loader assigns, not a Rapier collider handle.** Every client instantiates the same level
JSON in the same order, so the index means the same thing everywhere by construction. The handles happen
to match today and that is not a promise.

**Nothing new is computed on the sending side.** `CharacterState.base.localPos` — the rider's position in
the surface's frame — already existed, because that is how platform carry has always worked locally
(ADR 0012's movement base). The wire now carries a quantity the solver was already keeping.

**The receiver undoes the frame against the piece's *drawn* pose**, not the last sim tick's. That
distinction is the fix: the deck the eye sees is the interpolated one, so `basePoseOf(index, true)` is
what a rider must be placed against. The collision proxy for peers uses the tick pose instead, because
that is what physics resolved against.

## Consequences

- **Interpolation cannot blend across a base change.** Two samples on different bases are two different
  coordinate systems; lerping 0-in-the-world against 10-on-a-platform walks the rider through whatever
  lies between. The older sample is held for that one interval instead — 50 ms of stillness at the
  instant of stepping on or off.
- **The relay must treat a base change as a change worth sending.** A rider stepping onto a platform as
  it passes through its own origin reports identical numbers in a different frame; nothing else would
  have forced that relay, and a viewer left on the old base would draw them somewhere else entirely.
- **The transition now steps, where before it was a constant lag.** Riding, a peer is drawn against the
  deck's current pose — effectively at *now*. Off it, they are drawn from a delayed world position. Both
  are right; the step between them is the rider's displacement over the interpolation delay, and off the
  fast mover, whose velocity they inherit, that is nearly a metre. It is kept as an offset and decayed
  (`BASE_SWITCH_HALFLIFE`, 100 ms): the drawn position stays put and closes on the truth. Same class of
  thing as Unreal's network smoothing. 0 restores the teleport.
- **Above 254 clock-driven pieces there is no room in the byte**, and those fall back to world
  coordinates — degraded, not aliased onto another piece's frame.
- A peer's **vertical velocity is still derived** from their rendered position, and while they ride, that
  position now tracks the deck, so the derived vertical picks up the platform's lift as it always did.
- The loader gained `baseIndex` and `basePoseOf`, and records the pose `render(alpha)` drew rather than
  leaving callers to read it back off the visual, which would have depended on call order.

## Rejected

**Correcting the position locally with no wire change.** See above — no facing fix, dependent on analytic
platform motion, and it guesses the base.

**Drawing the movers on the peers' delayed timeline.** Zero bytes, and it moves the artifact onto the
local player, who is the one being looked at.

**Extrapolating peers to *now* instead of interpolating with a delay.** Removes the mismatch by removing
the delay, and buys overshoot on every stop. The wire also carries no vertical velocity to extrapolate
with, so the idle-rider case — the one reported — would not have been fixed.

**Sending the platform's velocity so viewers could compensate.** More bytes than the index, and still
wrong at a reversal: a velocity sampled 100 ms ago is the wrong velocity.
