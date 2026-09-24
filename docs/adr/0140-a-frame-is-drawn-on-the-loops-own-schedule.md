# ADR 0140 — A frame is drawn on the loop's own schedule

Status: accepted. Refines how ADR 0011's local controller and ADR 0021's clock-driven pieces are
render-interpolated; the tick itself, the sim clock and the netcode are untouched.

## Context

Kodjo: moving platforms are a bit jittery from a distance and very jittery to stand on — the camera shakes
too — mostly mid-travel, with or without `smooth`.

Every frame drew the level and the local character a fraction of the way between their last two ticks, and
that fraction was **wall-clock time since the last tick ran**, over one tick. Ticks run on `setTimeout`
(`startFixedLoop`), which fires a few milliseconds late by a different amount each time. So each frame was
drawn off by that lateness times the speed of what was drawn:

- a platform seen from elsewhere is the only fast thing on screen — a slight shake;
- standing on it, the character moves at the platform's speed and the camera follows the character, so the
  whole view shakes;
- mid-travel is where either kind of mover is fastest, which is why `smooth` made no difference.

The game client and the editor's play-test both did it, each with its own `lastSimTickAt`.

## Decision

**Each drawn frame first runs every tick that is due (`LoopHandle.pump`), then draws everything at one
fraction read off the loop's own accumulator (`LoopHandle.alpha`)** — Fiedler's "fix your timestep", and the
same instant for the level, its lights and the local character (`LocalController.renderPositions(alpha)`).

The timer stays: frames stop in a hidden tab and the simulation must not. Whichever runs a tick first, the
timer or a frame, the accumulator is the same one, so the tick count and the sim clock are exactly what they
were.

## Rejected

- **Driving the ticks from frames only.** Smooth, and the simulation would stall whenever the tab is hidden.
- **Timestamping each tick with when it was *due* rather than when it ran**, keeping the timer as the only
  driver. Fixes the fraction but not the late tick itself: a frame drawn between the due time and the late
  wake would still hold the previous pose.
- **Smoothing the camera.** Hides the symptom on the rider's camera and leaves every platform drawn wrong.
