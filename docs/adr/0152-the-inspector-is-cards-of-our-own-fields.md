# ADR 0152 — The Inspector is cards of our own fields

Status: accepted, amended twice at Kodjo's ask — the header reads twist, enable, icon, name, and: a component's card is dragged by its header to reorder (`cardDrag.ts`, the stage cards' drag over one list), wherever Move up / Move down are offered; the Transform is always open, with no twist; the cards' outline has more contrast. Takes Tweakpane out of the editor, which ADR 0038 kept for the value widgets. Every choice a
person sees is Kodjo's, asked with the question tool and two options each; the Sequence card is unchanged
(ADR 0147).

## Context

The panel read as two designs: the Sequence in our own controls (ADR 0147), everything else in Tweakpane —
monospace, a bar between each number, a second kind of number field that dragged differently. Every component
was a bordered box with no icon; the prefab link, the override strip and Duplicate / Delete were a row each,
all of them already in the Hierarchy's menu; a component with no parameters spent a row saying so. A wide
panel stretched every field across the screen behind a fixed 92 px label column.

## Decision

| | |
| --- | --- |
| fields | ours everywhere, `controls.ts`: a number dragged sideways or typed, X Y Z red green blue; a tick box; a dropdown; a line of text; a colour as a swatch opening the browser's picker and its `#rrggbb`. Transform, every component, Environment, Game and its settings. A ranged number is the same drag field, clamped — no slider track |
| cards | a card per component, shaped like the stage cards: twist, the component's **icon**, enable, name, badge, ⋯. A component with nothing to edit is its header alone |
| wide panel | one column; the label column is about 40 % of a line (`--lw`), 72 px at least |
| prefab bar | on a placement or a piece: the prefab's name, `×N` placements, **Open**, **Overrides ▾** (Revert all, Apply all, Unlink) with the count on it. Replaces the link row and the override strip. A plain object has none |
| footer | gone: Duplicate, Delete and Save as prefab are the Hierarchy menu's and the keyboard's |

Technical choices under it:

- **A drag writes as it goes, as one history entry** — `Live` on a field; the Inspector opens
  `host.beginDrag` when the press becomes a drag and `endDrag(label)` when it lets go, what a gizmo drag does,
  so the viewport follows the pointer and the room gets one message. A remote repaint waits for it
  (`gizmoDragging` includes it), since it would rebuild the panel under the pointer. A value saved to a file on
  each write (a game setting, the network bound) and a multi-selection's transform (`writeAxis` is its own
  entry) write when they settle.
- **Typed values are clamped, never snapped** (ADR 0113 keeps holding): the step is the drag's (`numberScrub`).
- A mixed value is a blank field that is typed only; a drag would need a number to start from.
- Several selected, one axis of a vec3 they disagree about is written over **each node's own** other axes
  (`setParamsAcross` with a patch per target). The old blank row wrote `{ x }` alone, which replaced the whole
  vec3 on every node.

## Rejected

- **Restyling Tweakpane.** Less work; still two kinds of number field in one panel.
- **Unity's flat sections.** A line between full-width sections gains about 12 px; the cards match the
  Sequence's.
- **Cards in columns on a wide panel.** More in view, but reading order zig-zags and one tall card sets the
  height.
- **Keeping the link row and the strip, restyled.** Two rows for what one bar says.
