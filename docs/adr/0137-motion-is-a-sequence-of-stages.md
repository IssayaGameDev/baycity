# ADR 0137 — Motion is a sequence of stages

Status: accepted. Supersedes [ADR 0103](0103-motion-is-a-speed-not-a-keyframe.md): `Mover` and `Spinner` are
deleted. Keeps ADR 0103's
clock-driven invariant, its speed-is-the-average rule and its fraction offset, ADR 0104's tick slicing and
ADR 0106's frames. The library behind it is [ADR 0138](0138-only-easing-is-borrowed.md).

## Context

Kodjo wants the motion system to be something substantial, able to take his future needs, where `Mover` and
`Spinner` only move and turn. Tweens, as he would write them in code: timing, easing, yo-yo, on position,
rotation, scale or a material's alpha, exposed as a component he uses in the editor.

Designed from three of his cases:

1. A ball spawns, falls onto a slope, rolls down, despawns at the bottom, waits, repeats.
2. A platform fades in, its collider turns on at the end of the fade, it stays, fades out, collider off,
   waits, repeats.
3. A wall moves forward at a given speed to the end of a corridor, despawns, waits, repeats.

All three are the same loop — appear, do something, disappear, wait — all three are touched by players and so
must look the same on every screen, and all three need instant actions and waits as well as tweens.

The first pass at this was a full design produced without asking, and Kodjo rejected it as slop: the shape
and the UX are his. Every decision below is his answer to a question put to him with two options.

## Decision

**A sequence is stages, played one after another; everything in a stage runs together, and the next stage
starts when the stage's longest step ends.** Boxes, not a "with previous" flag on each step: what runs
together is then visible, and the box is what a dragged step is dropped into.

| | |
| --- | --- |
| steps | move, turn, scale, fade, collider on/off, enable/disable, wait |
| a move | goes **to a point measured from where the object was placed**; each point independent, so fixing one moves no other. Not chained (DOTween's `SetRelative`), not fixed spots in the level |
| a turn | goes **by** an angle about **any** axis; its length is ignored |
| scale | **times the scale it was placed at**, so a resize or a bigger placement keeps its pulse |
| fade | 1 = as its material is, 0 = invisible |
| collider on/off | all of the target's colliders |
| target | the object itself or **one of its children**, nothing else — it travels with the prefab |
| despawn | `disable`: not drawn, no collision; back at its start when the sequence repeats. The same object, never a copy. A spawner is a separate job |
| starting state | the object as set up, until a step changes it. No "from" values |

**Timing.** Every step can take seconds. A move can take m/s and a turn °/s instead — speed decides whether a
platform can be ridden, and with seconds only, moving a point silently makes it faster (ADR 0103). A speed is
the **average** over the step. Any timed step can last **as long as its stage**, so the ball spins exactly as
long as it rolls whatever the roll's speed; a stage needs one step that ends by itself.

**Looping.** Restart or yo-yo. **A yo-yo is a rewind**: moves go back the way they came, eases mirror, instant
steps undo themselves, and a wait at the end counts twice at the turnaround. Firing instant steps again on
the way back was rejected: the object would not be in the same state at the same point of the sequence.
Forever or a set number of passes. Staggered by a fraction of the cycle, as ADR 0103 did.

**The full standard easing set,** on move, turn, scale and fade. ADR 0103 turned eases down because on an
out-and-back three of five jerk at the turnaround; a sequence writes the way back explicitly or yo-yos it, so
which ease jerks is now the author's call per step.

**Clocks, one per sequence.** `shared` reads the room's clock and looks the same on every screen. `local`
reads this browser's and may differ — and **may change collision**, for the per-player door; other players see
you walk through a door still closed for them, which is what such a door should look like to them. It cannot
be a riding base across the network. Per sequence, not per step: a local step lasts differently per screen and
would push every shared step after it out of sync.

**Starting only when the level starts, for now,** built as "time since start" so a trigger later supplies only
a start time. Shared triggers need a relay message and the start time for late joiners.

**Several sequences on one object**, each looping on its own: moves add, turns stack in component order,
scales and fades multiply, and collider and enabled are **off wins** — independent of component order, and a
blinking platform is never standable when any sequence says it is not there.

**Axes, one setting per sequence, for moves and turns both**: the object's axes as placed (the default, so a
rotated prefab's route rotates with it) or the level's. The object's own turning never bends its route.

**In the Inspector, as one component** holding its settings, stages and steps, each step with a hidden id so a
placement can override one step. A flat stack of step components cannot draw boxes.

**Mover and Spinner are deleted, not converted**: nothing authored with them needs keeping. A one-off script
strips them from the content, because a file naming an unknown component fails to load.

## Rejected

- **A full design produced up front.** See Context.
- **A flag per step for "runs together"** — a small mark on a row, and nothing to drop a step onto.
- **Start times per step** — a step at a speed has no known end without arithmetic, and lengthening one step
  means retyping every start after it.
- **Seconds only.** The riding-bug trap from ADR 0103.
- **Local sequences restricted to visuals.** Safer, and it rules out the per-player door.
- **Several objects moved only by their own sequences.** Two door halves would keep in step only while
  nobody edited one of them.
- **A `from` value on each step.** Two values per step and a second rule for where things begin.
- **Converting Mover and Spinner.** Nothing to keep.
