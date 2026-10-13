# ADR 0211 — The Obstacle: a checkpoint reached through a trigger, holding its stage's numbers

Status: accepted. Kodjo's design, every call his: replace the stage gate (ADR 0202) with one component that holds
what there is to know about an obstacle.

## Decision

- **`Obstacle`**, on the InterLevel prefab's root where the stage gate was, pointing inside the prefab (a level node
  cannot point inside a placement yet — logged as open, `components/api.md`):
  - `teleport` (a transform) — where the teleport window lands you and which way you face. Empty: its own node.
  - `trigger` (a trigger collider) — walking into it reaches the checkpoint. Empty: never reached.
  - `winsPad` + `wins` — the pad pays this, over its own `wins`, which stays for a pad nothing points at.
  - `sign` + `requiredLevel` — that Text reads "Requires Level X". The level gates nothing yet.
- **Not reached is greyed** in the teleport window and cannot be picked. Start and a stage gate are always open.
- **Reached is kept for good**, per level, in the game's save through its adapter (`CLAUDE.md`). Platform accounts
  later.
- **Nothing on screen** when one is reached.
- **The switch-over**: the Obstacle ships beside the stage gate, which stays listed (always open) until the box's levels
  have swapped theirs; a level naming a component the game does not know does not load, so removing it first would
  break every level with an InterLevel.

## Rejected

- **On the `Obstacle N` parent**: Kodjo's first plan; the pad and the sign are inside the InterLevel placement, out of
  a level node's reach.
- **A popup on reaching one**: not asked for.
