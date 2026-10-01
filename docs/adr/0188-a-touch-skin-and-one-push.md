# ADR 0188 — A touch skin, and one push

Status: accepted. Amends ADR 0186 (platforms push the player) and what counts as contact (ADR 0054). Kodjo's
calls: contact from the physics, not a distance check of our own; the side effect on every touch component
accepted.

## Context

Kodjo: pushed by a moving Hazard, or hopping on one, without dying; dying at once on others. Measured through
the game's tick: a moving hazard deck ridden for 149 ticks reported contact on 1; a hazard wall pushing the
player, on none. Two causes:

- **Contact was the controller's own collisions** — what the character's move ran into, Unity's
  `OnControllerColliderHit`. A still hazard walked into or landed on reports at once; a platform carrying or
  pushing the player does not, and the controller keeps its gap, so the capsule itself never touches anything.
- **Two pushes.** The character controller pushes by a touched body's whole last step — measured, 0.2 m for a
  0.2 m step with the capsule already clear — and ADR 0186's push ran before it. The rider floated a step
  ahead of a pushing wall, 0.35 m at 10 m/s, never touching it.

## Decision

- **A touch skin**: a sensor capsule 5 cm proud of the player's, on the same body, with kinematic–fixed and
  kinematic–kinematic pairs switched on. `touching()` is what the physics' narrow phase says it overlaps; the
  components get it with `collisions` and the triggers, each handle once. Rapier refreshes a sensor's pairs only
  on a step where one of the two moved; what a resting player presses on is in `collisions` already.
- **One push**: `shove` runs before the step, and the movers it pushes are posed frozen for that step, as the
  ridden body is, so the controller does not push again. Turns are swept in 5° pieces: without the controller's
  push behind it, a straight-line sweep let a bar at two turns a second past.

Measured: a pushed player 0.020 m from the wall at 1–10 m/s; contact on every touching tick, still or moving,
ridden, pushed, hopping; the ADR 0186 cases unchanged; a bar at 4 turns/s.

## Rejected

- **A distance check of our own** each step. Kodjo's call: the physics' own contact, as a trigger.
- **Letting the controller push alone.** It pushes by the whole last step, so a rider floats ahead at speed too,
  and it fails outright past a few metres a second.
- **Freezing every mover.** A body the player is not touching keeps its motion for the ragdolls it carries.
