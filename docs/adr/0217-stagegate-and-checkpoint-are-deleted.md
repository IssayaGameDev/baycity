# ADR 0217 — StageGate and Checkpoint are deleted

Status: accepted. Kodjo's call: remove both.

## Context

`StageGate` (ADR 0202) was kept beside the `Obstacle` (ADR 0211) only so the box's levels would load until they had
swapped. The shared `Checkpoint` had no use left: Keyboard's checkpoints are Obstacles, and no level on the box has
one. A file naming a component the build does not know does not load (ADR 0076), and `sharedComponents` throws on
a game list naming one — Keyboard's still lists `Checkpoint`, on the box and on master.

## Decision

- **Both deleted, not converted.** A node with only a `StageGate` leaves the teleport list; one with an `Obstacle`
  too keeps its Obstacle. `CheckpointStop.alwaysOpen` goes with the gate. `effects.progress` stays: every Keyboard
  pad reports through it.
- **The strip tool takes the types by name** (`strip-components.sh <Type,Type>`, `componentStrip.ts`) — ADR 0137's
  Mover/Spinner tool, the set made an argument.
- **Two commits, in order**: the tool; Kodjo pushes it, strips the box (`StageGate,Checkpoint`) and merges `content`
  into master; then the code that drops the two. Master's `content/` changes only by that merge, and its tests load
  `content/keyboard/game.json`, so the removal cannot land green first.
- `ModeDescriptor.facingGizmos` stays in the platform with no game setting it.

## Rejected

- **Converting a StageGate into an Obstacle**: not asked for; an Obstacle's trigger, pad and texts are Kodjo's to set.
- **A game list tolerating a name the build lacks**: the failure ADR 0077's throw exists to end.
