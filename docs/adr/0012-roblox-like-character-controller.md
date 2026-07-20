# ADR 0012 — Roblox-like kinematic character controller

Status: accepted. Refines ADR 0010's TPS controller for the client-authoritative stack
(ADR 0011). Feel values are provisional (Kodjo tunes by play).

## Context

Kodjo wants the TPS character to feel like Roblox's. Research finding: Roblox drives a
**dynamic, force-based** body (the classic `Humanoid` is a dynamic assembly held upright by
an internal balance force and floated at hip height by a leg spring; the newer
`ControllerManager`/`GroundController`/`AirController` formalize this with forces/impulses).
Roblox does this because it is a **general physics sandbox with user-generated worlds** — the
character must be a first-class physics citizen with two-way coupling (push props, get pushed,
ride platforms, ragdoll). The floatiness and occasional bounce are symptoms of that choice.

Our game class does not need two-way coupling: client-authoritative (ADR 0011), scarce
player interaction, a **static** obstacle course, and no shared dynamic props (deferred, ADR
0011 D1=B). We want the crisp, predictable half of the trade-off.

## Decision

**Kinematic** (keep the Rapier kinematic character controller, ADR 0010) and script the
Roblox *feel* on top of it — matching the classic Humanoid's behaviour without the dynamic
bounciness. `stepCharacter` (in `@mp/server/tps`, run client-side + by tests):

- **Fixed-apex jump:** `v₀ = √(2·g·h)`, so a ground jump reaches exactly `jumpHeight`
  regardless of gravity (gravity then only shapes how snappy the arc is).
- **Ground accel/decel:** horizontal velocity eases toward the input direction over
  `groundAccelTime` and brakes to a stop over `groundStopTime` (snappy, arcade).
- **Force-limited air control:** airborne steering runs at `airControl`× the ground rate and
  momentum is otherwise preserved (no braking) — nudge your arc mid-jump, can't stop/reverse.
- **Slopes/stairs:** wrapper sets max climb ~50° / min slide ~45°, plus autostep + snap-to-ground.
- **Auto-face-movement:** client-derived facing (off the wire), unchanged from ADR 0010.

Feel values live in a `CharacterTuning` object with `DEFAULT_TUNING` = Roblox's defaults
converted from studs (~0.28 m/stud): speed 4.5 m/s (WalkSpeed 16), apex 2 m (JumpHeight 7.2),
gravity 55 m/s² (196.2 studs/s²), accel 0.1 s, stop 0.08 s, air control 0.3. The demo exposes
them as **live debug sliders** — safe because, under client authority, tuning is purely local
and not a prediction contract (it *was*, under the old server-auth model). Kodjo tunes by
playing; the values landed on get baked into `DEFAULT_TUNING`.

Scope: **core locomotion only** — walk, jump, air control, slopes, stairs. No sprint/crouch.

## Consequences

- `CharacterState` gains `vx`/`vz` (horizontal velocity, for momentum + acceleration).
- The TPS world's Rapier gravity is now 0 — the kinematic character integrates its own gravity
  in `stepCharacter`; nothing dynamic reads world gravity.
- If shared dynamic props arrive later (ADR 0011 D1=B), kinematic-with-scripted-pushing extends
  this rather than forcing a dynamic rewrite.

## Rejected

- **Dynamic force-based body (true Roblox model)** — bouncy, imprecise, finicky to tune, lower
  determinism, and reverses ADR 0010; buys two-way physics coupling our game class doesn't use.
- **Sprint / crouch / climb / swim** — beyond the requested core moveset; add if a game needs them.
