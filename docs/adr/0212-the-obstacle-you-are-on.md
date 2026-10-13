# ADR 0212 — The obstacle you are on is the last trigger walked into

Status: accepted. Kodjo's ask and calls: track which obstacle the player is on; the last trigger; own player only.

## Decision

- **`KeyboardSession.currentObstacle()`**: the node of the last `Obstacle` whose trigger was walked into (InterLevel
  `k` is before obstacle `k`, so its trigger starts it), or of the checkpoint the teleport window landed on
  (`KeyboardTeleport.obstacle`). Walking back through an earlier trigger is that one again.
- **`null` from the spawn**: at the start, after a death (`takeDeath`), a cash-out, a respawn or Restart (`respawnAt`),
  and a teleport to Start.
- **The player's own**: not sent, not saved. Nothing draws it yet.

## Rejected

- **The obstacle's area** — a trigger box per obstacle, on none between them: one more box to place and size per
  obstacle (Kodjo's pick was the trigger).
- **Everyone's** — a peer's on the wire: not needed yet.
