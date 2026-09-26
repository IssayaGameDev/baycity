# ADR 0168 — The Inspector follows an edit made elsewhere in place

Status: accepted. Finishes what ADR 0167 left.

## Context

A collaborator's edit to the object you have selected rebuilt your Inspector: a field you were typing in lost what
you had typed, a number you were dragging let go. After ADR 0167 only an edit to the object shown did; that one
still did.

## Decision

The panel remembers **its shape** as it drew it: the object, its cards and their lines, and every value that
decides them — an enum gating other lines, a picked asset, a collider's kind, a node picked, a sequence, each card's
switch and overrides; with several selected, all their values. An edit from elsewhere to the object shown
(`inspector.refresh`):

- **The same shape**: each line shows its value as it is now through the control's own setter, which leaves a
  field being dragged or typed in alone; what you type is written when you are done, over the others' values as
  they are now. The head and the transform follow as the gizmo's do.
- **Another shape** — a component added, a kind picked, a sequence changed, several selected: the panel draws again,
  as before.

Followed in place: numbers, ticks, texts, colours, vectors, a collider's sizes. The level's and the environment's
panels still draw again.

## Rejected

- **Drawing again and putting the typing back.** A drag cannot be handed to a new field, and the caret, the
  selection in the text and an open colour picker would each need their own restoring.
