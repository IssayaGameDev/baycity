# ADR 0186 — Moving platforms push the player

Status: accepted. Extends ADR 0104 (slicing) and ADR 0105 (boarding). Kodjo's call: pinned with nowhere to go,
the player stays and the platform passes through.

## Context

Kodjo: players pass through moving platforms, fast ones and slow ones. Measured through the loader and the
character exactly as the game ticks them, a 1 m wall moving sideways into a standing player passed through at
0.5, 1 and 20 m/s; walking into a wall moving toward you passed through at every speed; a 20 m/s lift rising
past a floor edge passed through a player standing on the edge; a spinning bar passed through. Two causes:

- **A wall taken as the base.** When the ground probe found still ground, the controller's fallback still took
  a moving collider it touched as the base. Never ridden, but a base is excused from Rapier's kinematic push —
  the slow cases and the walk-in.
- **Nothing pushes.** The character controller resolves only the character's own motion; a kinematic platform
  arriving in one step, deeper than Rapier resolves, or turning, simply overlaps it — the fast cases, the lift
  at the edge, the bar.

## Decision

- The base fallback runs only when the probe **missed**.
- After the movers are posed each slice, `LoadedLevel.shove` sweeps every solid mover that moved, from its last
  pose by the motion it gave the capsule's centre, and pushes the capsule the rest of that motion plus a sliver
  — at once, through a cast that ignores the pushers and stops at anything else, before the character's own
  move. The ridden base included: the ride places by an absolute point, so nothing doubles.
- Already inside a mover at the slice's start pushes nothing, so a player pinned against a still wall stays
  and the mover passes through. Nobody is thrown.

All of it measured, then kept as `sequencePush.test.ts`: walls 0.5–40 m/s, walking in, the lift at the edge,
a bar at up to 2 turns/s, pinned; riding up, down and sideways unchanged within 0.03 m.

## Rejected

- **Making the player a dynamic body.** Pushed by anything for free, but it changes how all movement feels —
  stopping, sliding, slopes. A design change, not a fix.
- **Pushing through the controller's own move.** Tried: the push and the character's step resolved together
  start inside the mover, which the controller then ignores — the walk-in still passed through.
- **Death when crushed.** A new rule; not asked for (option B, declined).
