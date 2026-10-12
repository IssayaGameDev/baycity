# ADR 0207 — A model is drawn at its node's pivot, at its node's scale

Status: accepted. Kodjo's report and go: an imported model sat off its pivot and large in the editor, and on its
pivot and small in the game.

## Context

The editor drew a model at the node's pivot, scaled by the node's world scale — as Unity does. The game drew it at
**file size** whatever the scale (`addLevel` passed `VisualItem.scale` to built-in shapes only), and at its **first
collider's centre** rather than the pivot. So the same node looked different in each. A model whose file puts the
mesh to one side of its origin showed it most: the editor scaled that gap up with the model, the game did not.

## Decision

- **`addLevel` sizes a model by its node's world scale**, times its own root scale; a sequence's `drawScale` stretches
  from there.
- **The loader puts a model at the node's pivot.** It rides the first body when that body is on the pivot — every
  node without a collider `center` — and otherwise gets a body-less dynamic of its own, so a moving node's model
  follows the pivot while the collider rides off it.

## Rejected

- **Recentring a model on its bounds at import**: changes what every model file means; a model's origin is its
  author's, as in Unity. Re-exporting with the origin where the pivot should be is the fix for an off-centre file.
- **The editor drawing at file size instead**: scale would size a built-in and not a model.
