# ADR 0202 — Stage gates

Status: accepted. Kodjo's calls: a teleport to the level's stage breaks, through an in-game window; every one open
for now, reaching and paying for them a later pass; a component of this game's own, named Stage Gate, rather than
the shared `Checkpoint`; numbered in Hierarchy order; a player lands where it stands, facing its way; a marker for
it in the editor.

## Context

Keyboard's levels have stage breaks — the `InterLevel` prefab, between obstacles, each with a Wins pad — and Kodjo
wants players to teleport to them from a window, as the game being cloned does. Nothing marked where in a break a
player should land, or which way they should face.

## Decision

- **`StageGate`**, Keyboard's own component, no params: put on an empty object at the landing spot, turned to face
  the way a player should. `stageGatesOf` lists them in Hierarchy order with where to stand and the yaw.
- **`ModeDescriptor.facingGizmos`**: a game names types whose nodes get a marker with an arrow along their forward,
  on every node, collider or not. Keyboard's is the stage gate, blue as a spawn is.

## Rejected

- **The shared `Checkpoint`**: its meaning (a respawn point) and its params are shared by every game; the later
  Wins price is this game's alone, and the name would keep suggesting respawning.
- **Finding the `InterLevel` prefab itself**: no say over the spot or the facing, and one prefab only.
- **No marker**: an empty object draws nothing until selected, and there are seven to place and turn.
