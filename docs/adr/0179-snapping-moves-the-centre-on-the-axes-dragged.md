# ADR 0179 — Snapping moves the centre, on the axes dragged

Status: accepted. Replaces [ADR 0117](0117-snapping-moves-the-corner.md)'s corner rule.

## Context

Kodjo dragged an object at 20, 41, 55 one tick along X with a 0.5 snap and got 20.175, 41.148, 55.153. Two causes.
Translation snapped the **minimum corner** of the world box (ADR 0117), so the position shown — the centre — was a
grid line plus half the size, never a round number. And it snapped **every** axis, so dragging X pulled Y and Z
onto the grid too. Unity snaps the position, only along the axis being moved, and lines edges up with vertex snap.
Kodjo: closer to Unity.

## Decision

- **World handles: Unity's grid snap.** Each axis the drag moved puts the object's position — its centre — on the
  grid; an axis it did not move stays exactly where it was. 20, 41, 55 dragged along X goes to 20.5, 41, 55.
- **Local handles: Unity's increment snap.** Whole steps along each handle axis from where the drag started; a world
  grid cannot be followed along a tilted axis, and Unity's grid snap works with world handles only.
- A sequence point's copy snaps the same way. Nothing in a level moves: an object untouched stays where it is, edge
  alignment included; one dragged with snap on lands by its centre on the axis dragged.
- **Vertex snap** — a corner of one object onto a corner of another, Unity's V — is how edges will meet, at any size
  and any key pitch. Its own job, next.

## Rejected

- **Keeping the corner, on the dragged axes only.** Platforms would keep meeting on grid lines, but the number shown
  is never round, Unity has no such rule, and it only lines edges up when sizes fit the step — keys at 0.9 never did
  (ADR 0117's own *Not done*). Vertex snap lines edges up exactly at any size.
