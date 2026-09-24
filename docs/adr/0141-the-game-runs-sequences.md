# ADR 0141 — The game runs sequences

Status: accepted. The loader half of [ADR 0137](0137-motion-is-a-sequence-of-stages.md); keeps ADR 0021's
movement base, ADR 0058's drive, ADR 0104's slicing and ADR 0106's frames.

## Context

The engine (`sequence.ts`) answers what one sequence does to one target at an instant. The loader has to turn
that into what the game collides with and draws — for five kinds of change, on two clocks, with riders standing
on some of it — while every level without a sequence costs what it always did.

## Decision

**Compiled once, sampled per tick.** Each enabled `Sequence` on a node is compiled while building; a frame
lists the sequences that move it — its own aimed at itself, its parent's aimed at its id — and each compiled
sequence is sampled once per instant however many frames it moves. A frame with any is `animated`: kinematic
bodies and a place in the per-tick pass, like a mover's.

**Built at level time 0.** The build poses every frame at the instant every sequence starts, so a platform
whose first stage switches its collider off is built without one, rather than solid until the first tick.

| channel | how |
| --- | --- |
| move, turn | added into the frame's local pose, like a mover's travel |
| scale | into the frame's world scale, which is now live and inherited, so a branch grows together. Collider shapes are replaced in place (`PhysicsBody.setShape`) only when the scale changed; what is drawn is stretched by `drawScale`, the scale now over the scale it was built at |
| fade | `VisualItem.opacity`. The renderer gives a fadeable visual **its own** material copy, transparent from the start: the original may be shared by every piece using it, and switching transparency on mid-fade would recompile the shader. Faded to 0 it is not drawn, since a transparent mesh still casts a full shadow |
| collider on / off | the target's own bodies (`PhysicsBody.setEnabled`): no contacts, no triggers, out of every query |
| enable / disable | the target **and its branch** — Unity's `SetActive` — not drawn, bodies off, lights off |

A fade and a collider switch stay on the target: a material's alpha and a collider are the object's own, and a
branch that should go together has `disable`.

**The local clock counts from the first instant this screen posed the level.** It moves in step with the tick,
so a sliced tick (ADR 0104) moves both clocks by the same amount and an intermediate pose stays exact.

**A piece a local sequence moves is never a base on the wire.** Another screen has it somewhere else, so a
rider's position relative to it would put them in the wrong place there; the rider is sent in world
coordinates instead. Carrying the rider here is untouched. A local sequence that only fades or switches does
not move the piece, so it stays a base.

**Slicing counts sequences**: a frame's movers and sequences add, so their distances do.

## Rejected

- **Fading the shared material.** Every piece using it would fade together.
- **Recreating a body to rescale it.** A new body is a new collider handle, and handles are what a rider's
  base, a rule's contact and the camera's occluder list all key on.
- **`performance.now()` for the local clock.** It would not move with a sliced tick, so a local platform would
  be posed at the wrong instant inside one.
- **Fading and switching colliders across the whole branch.** Then a platform could not fade under a child that
  stays, and `disable` already says "the whole thing".
