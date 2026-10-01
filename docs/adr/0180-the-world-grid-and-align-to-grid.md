# ADR 0180 — The world grid, and Align to Grid

Status: accepted. Continues [ADR 0179](0179-snapping-moves-the-centre-on-the-axes-dragged.md).

## Context

After ADR 0179, Kodjo snapped `floor`, a child of `Obstacle 10`, and read −20.325, 41.648. The snap was right: the
floor was on the world grid. But `Obstacle 10` sits off it (about −820.67, 53.35, 428.59, likely left there by the
corner rule of ADR 0117), and the Inspector shows a child's position relative to its parent, so it read the world
grid shifted by the group's offset.

## Decision

- **The grid stays the world's** (Kodjo, after weighing it): Unity's grid snap, and one grid for everything, so
  pieces snapped in two different groups still meet.
- **Align to Grid**, Unity's (Ctrl+\, and in the object's right-click menu): the selection's positions onto the move
  grid, all three axes at once, snapping on or off. Aligning a group once puts its children back on round numbers.

## Rejected

- **Snapping in the parent's frame**, so the number shown is always round. Each group would have its own grid,
  offset by wherever the group happens to sit, and pieces of two groups would no longer line up.
