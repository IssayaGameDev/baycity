# ADR 0201 — The editor's view reaches the whole level

Status: accepted. Kodjo's call: the editor only — the game's draw distance answers to other performance needs.

## Context

The editor looks through the stage's perspective camera, the game's, whose far plane is 1000 m (isometric: 2000).
Looking at a big level from a few hundred metres away, its far parts were cut off.

## Decision

- Outside play, the editor sets the active camera's far plane each frame to the level's far side as seen from the
  camera (its bounding sphere, measured every 500 ms), with 5% over, in 100 m steps — never nearer than the
  camera's own.
- Play puts the game's 1000 m back.
- The near plane is unchanged: depth precision is set there, so the further far plane costs next to nothing.

## Rejected

- **One bigger far plane for the editor and the game**: Kodjo's call — the game has its own performance needs.
- **A fixed bigger number in the editor**: still a cut for a bigger level, and nothing gained over following it.
