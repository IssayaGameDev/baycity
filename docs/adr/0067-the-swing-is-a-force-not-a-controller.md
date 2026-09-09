# ADR 0067 — The swing is a force, not a controller

Status: accepted. `modes/swing` has a rope: hold a key, it finds an anchor above and ahead, and a damped spring
plus `stepCharacter` does the rest.

## Context

ADR 0065 and ADR 0066 both made the same claim — that a game can build something the platform has no concept of
without the platform gaining a field. Neither had been tested by a real feature. This is that test, and the
design was Kodjo's, taken as four decisions:

- **Anchor found automatically**, over **any surface** rather than authored anchors.
- **A pendulum on a fixed length, with a little give**, not a rigid link.
- **On top of the character controller**, not replacing it.
- **Hold to swing**, and the stick **pumps** rather than steering.

## Decision

### The rope is a one-sided damped spring

Rest length is fixed at the moment of the grab. Below it the rope is slack and applies nothing; past it, a
spring pulls toward the anchor with a damper on the radial motion.

**A force rather than a constraint**, which is both what Kodjo asked for and the cheaper direction: a force adds
to whatever else is acting that tick, where a rigid link has to be solved and fights the controller for the same
frame. The give lands exactly where it should — at the bottom of the arc, where centripetal force peaks and the
stretch is largest.

One-sided because a rope goes slack. A two-sided spring would shove the player away from the anchor as they rose
above it.

### `stepCharacter` keeps running

Every tick, attached or not. It is what supplies gravity, which is what drives the pendulum, and it is what
resolves collisions. "On top of the controller" means precisely this: the rope adds velocity *before* the step,
and the step integrates it.

**The stick is taken away while attached.** Air control steers toward `moveSpeed` in whatever direction the
stick points, which on a rope is a second thing pulling the character; the two only fight. The stick is not idle
— it pumps.

### The pump is the stick projected onto the arc

The radial component is removed, so pushing at the anchor does nothing and pushing along the swing adds energy.
Pushing backwards removes it, which makes stopping a swing something the player does rather than something that
happens.

### It replaces `Locomotion` rather than sitting beside it

Two components could not do it. `onLocomote` handlers run in definition order, so a second one adding a force
after `Locomotion` had already stepped would be a tick late, and neither could stop the other's air control.

`playerDefs` returns `[createSwing(...)]` and no `createLocomotion` — the swing *is* this game's locomotion,
which is the shape ADR 0061 built.

### Anchors are found by casting, not authored

A fan of 25 sphere casts (5 yaws × 5 pitches) ahead and up. Each cast returns the first thing along it, so the
clear-line requirement comes free: a hit is by definition not through a wall.

Scored on **ahead** (horizontal only, so a good anchor is in front of where you are going and puts you at the
*start* of a downswing) and **distance band** (mid-band preferred; the extremes are legal and feel worse).
Rejected outright: behind, too shallow, too near, too far, directly overhead.

**Cast only while the key is held with nothing attached.** Searching every tick cost 25 casts a second for an
answer nobody had asked for; this costs nothing the rest of the time and still grabs the instant something comes
into range mid-hold.

The origin is `CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.3` above the body — clear of the capsule's crown, which
matters for ADR 0068.

### Feel is a folder on the debug pane

Seven sliders: stiffness, damping, pump, min/max length, cone, rise. Nobody sets a stiffness by argument
(ADR 0018), so `DebugPane` hands out its tweakpane root and the game adds its own folder. Same move as handing
over the scene: no concept per idea, and the pane never learns what a rope is.

## Consequences

- **Zero fields added** to `TpsClientOptions` or `ModeDescriptor`. Four files in `modes/swing` plus one line of
  key binding. That is the whole claim of ADR 0065 and ADR 0066, tested.
- 20 tests on the arithmetic, headless — scoring, choosing, slack, stretch, damping, pump, and a full undamped
  pendulum swing that has to return to within a metre of its release height.
- Four test beams in `content/levels/swing.json` (`swing test beams`, one group, deletable). The level had
  nothing above 7.2 m and every ray went into open sky; there was nothing to swing from at all.
- `?probe=1` and `modes/swing/src/probe.ts` are gone — the rope exercises the same handles, which ADR 0066 said
  would retire the probe.

### A damper does not slow a swing

Asserting the opposite as a test is how this was found. The damper acts on motion *along* the rope, and a taut
pendulum's motion is almost entirely across it, so there is nearly nothing to absorb. Its job is the bounce:
drop onto a rope and the spring rings, and this stops it.

The consequence is that **a swing does not decay on its own**. Energy leaves it when the player pumps backwards
or the controller puts them into a wall, and not before. Possibly right for a swing game; a design call either
way, and a one-line change.

## Rejected

**A rigid constraint.** Has to be solved, fights the controller in the same tick, and gives no stretch at the
bottom of the arc, which is the thing Kodjo asked for by name.

**Replacing the controller.** Gravity and collision resolution are exactly what the pendulum needs; rewriting
them to add a rope would be rewriting the wrong half.

**Authored anchor nodes.** Kodjo asked for any surface: a level should not have to be prepared to be swingable.
Filtering to tagged geometry is still open — `nodeOf(colliderHandle)` already answers "what did I hit and what
is authored on it", so it is a predicate away.

**A second component beside `Locomotion`.** A tick late, and no way to stop the other's air control.

## Known open

- **Nothing decays a swing** (above).
- **No tagged-surface filter.** The handle exists; the component type and its editor gizmo do not.
- **The camera does nothing special mid-swing.** `client.camera` is reachable and unused — `camera.land` on a
  grab is the obvious first thing.
- Every number is a first guess.
