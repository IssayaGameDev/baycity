# ADR 0032 — A bumper, and triggers that carry parameters

Status: accepted. Extends the trigger seam of ADR 0014.

## Context

Kodjo asked for a bumper/trampoline: a launch pad that any object can be given while keeping its own visuals
and colliders, with editable parameters, savable as a prefab.

Two of those four already worked. `Piece.trigger` attaches to a single piece, and that piece keeps whatever
collider and material it has, so "any object inherits the behaviour" is what a piece-level trigger *is*.
Prefabs already save. What did not work was the parameter: `trigger` was a bare string
(`'checkpoint' | 'goal' | 'hazard'`) with nowhere to put a number.

This was also the concrete example weighed against building a component system first. The bumper needed one
schema change, one four-line engine change and a mode branch; none of that is affected by whether components
own their own code. Building the component system to hold one bumper would have shaped the whole abstraction
around a single case.

## Choice

**`Trigger` is a discriminated union**, and `Piece.trigger` holds one. `checkpoint`, `goal` and `hazard` carry
nothing and still carry nothing; `bumper` carries `power`, an upward launch speed in m/s.

**`WorldTrigger` intersects it** (`Trigger & { colliderHandle, position }`) rather than copying its fields, so
`t.kind` reads the same everywhere it did and narrowing on it yields the kind's own parameters with no second
lookup.

**The launch goes through `stepCharacter`, not around it.** `CharacterState.launch` is an upward speed the
mode sets and the step *consumes*. It cannot be a write to `vy` from outside, because leaving a surface is
five decisions in that function, not one:

- the ride stops owning the vertical (`riding` is what zeroes `vy` every tick while standing on a mover),
- gravity applies again,
- footing is released,
- the movement base is dropped,
- the mover's velocity is inherited.

`jumping` already threads all five. So the step computes `leaving = jumping || launching` and every one of
those keys off `leaving`. **Without this a trampoline mounted on an elevator would not work at all**: the ride
would zero the bounce on the very next tick. That case is the reason the launch tests exist.

A launch **outranks a jump** on a tick both land: the bumper is the bigger, more deliberate event, and adding
them or taking the larger would let a jump silently alter a bumper's tuning.

A launch **does not require footing**, so a bumper can catch someone mid-air, and it *replaces* the fall rather
than adding to it.

**Consumed, not latched**, so one contact is one bounce. Resting on a trampoline reports contact every tick, so
each landing bounces once and nothing pins the player in the air.

**Nothing goes on the wire.** Movement is client-authoritative (ADR 0011/0013): each client simulates its own
character and relays position, so whoever touches the bumper computes the bounce locally and peers see the
result in the position stream. Same as hazard. No replication, no authority decision.

**`power` is validated rather than defaulted.** A missing one reaches `vy` as `NaN`, which puts the player
nowhere with no message. The old bare-string form is rejected by name, since a silently-never-firing piece is
worse than a load error.

**Numbers.** With the tuned gravity of 55 and a jump height of 3 m, a jump leaves the ground at
`√(2·55·3) ≈ 18.2` m/s. So **any power below 18 throws you lower than your own jump** and is only useful as a
soft catch. 26 gives about 6.1 m, roughly twice a jump, and is the editor's default and the shipped
`Trampoline` prefab's value.

## Consequences

- **9 authored triggers migrated** from `"trigger": "hazard"` to `"trigger": { "kind": "hazard" }`. Mechanical,
  and the validator now rejects the old form explicitly rather than ignoring it.
- **A `Trampoline` prefab ships**, with its own orange material matching the editor's bumper gizmo colour, and
  one is placed in `default.json` at (-6, 0.15, 4) so the thing can be jumped on without authoring anything.
  The prefab is a convenience: the mechanism is the trigger on a piece, and any piece can have it.
- **The Inspector has its first parameterised trigger.** Choosing `bumper` reveals a `launch (m/s)` field, which
  is the conditional-field pattern this panel expresses by rebuilding (ADR 0024). One field is fine; this is the
  pattern that got ugly at four, and it is the argument a component registry would eventually win on.
- **`MARKER_COLORS` is keyed by marker kinds *and* trigger kinds.** They overlap everywhere except `spawn` (a
  marker only) and `bumper` (a trigger only), and the editor draws a wireframe for both.
- **Horizontal launch is not implemented.** It needs a decision that is not technical: `vx`/`vz` are solved
  toward the input target every tick and braked to a stop in `groundStopTime` when there is no input, so a
  sideways bumper would be eaten by locomotion within a few frames unless control is suppressed for a window.
  How long that window is, and whether air control applies during it, are feel questions.
- **`collisions()` reports handles and no normals** ([world.ts](../../packages/physics/src/world.ts)), so
  "launch along the surface you hit" is unavailable without extending the physics layer. `probeGround` has
  normals; contacts do not.
- **Inherited velocity comes from the mover's movement *this tick*.** `ride` is a catch-up offset, so it is
  non-zero only when the surface actually advanced since the last resolve. A mover always does, so this is
  correct rather than a limitation, but it is why the test has to launch on a tick the platform moves.

## Rejected

**Widening `trigger` to a string plus a sibling `triggerParams` bag.** No migration of the three existing
kinds. Rejected because the parameters would not be typed against the kind, so a checkpoint could carry a
`power` and a bumper could carry none, with nothing to say so.

**Keeping the bare string and reading `power` from somewhere else on the piece.** Same objection, plus the
number would live nowhere a person editing a bumper would look.

**Building the component system first.** The bumper is the case that decided it, and it argues the other way:
one schema change and one four-line engine change, none of it touched by who owns component behaviour. Written
up in the discussion preceding this ADR; the short version is that a component registry should be designed
against four examples of the same shape, not one.

**Writing `state.vy` from the mode.** The obvious implementation, and it works on flat ground, which is what
makes it dangerous. It is silently wrong on a moving platform, which is exactly where a trampoline gets
mounted.
