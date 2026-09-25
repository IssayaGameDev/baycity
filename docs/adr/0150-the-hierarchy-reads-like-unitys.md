# ADR 0150 — The Hierarchy reads like Unity's, and its drag is rebuilt

Status: accepted. Amends [ADR 0025](0025-nested-placement.md)'s three-zone drop and
[ADR 0132](0132-hiding-a-node-is-a-view-not-an-edit.md)'s eye. Every choice below that a person sees is
Kodjo's, asked with the question tool and two options each. Amended by ADR 0151: a prefab's piece takes a
drop too, now that the document can put one there.

## Context

The Hierarchy worked and was hard to read and to drag in. Kodjo named the drag ("very finicky"), the layout
("not super clear") and the scrollbar ("super bad"), and the eye's gutter on the left pushing every row right.
Looking further: `inline` sat on every object that is not a prefab, so the commonest row carried the most text;
a level of nesting was 14 px of indent and nothing else; the twist was a text glyph; a prefab's pieces looked
exactly like the level's own objects (their dim style was written and never applied); and the browser's drag
split each row into bands a few pixels tall, could not show how deep a drop would land, and never opened a shut
row.

## Decision

| | |
| --- | --- |
| rows | **a cube per row** — filled and blue for a prefab, light blue for its pieces, grey for the level's own — **guide lines** down each level of nesting, SVG twists. `inline` goes; the count stays, only for a prefab placed more than once. Game and Environment get icons instead of emoji |
| eye | **at the right end**, before the count, on hover and always once hidden. Its place is kept either way, so nothing shifts |
| drag | **rebuilt**, as the sequence editor's was (ADR 0147): a copy follows the pointer, a line shows where the drop lands and how deep, a row lights up when it would become the parent, holding over a shut row opens it, the list scrolls at its edges, Escape cancels. At the end of a group the pointer's x picks the depth |
| scrollbar | **every panel**: dark, no arrows, and — Kodjo's condition — easy to grab rather than thin: 12 px, the thumb drawn narrower inside it |

Technical choices under it: where a drop lands is `dropAt`, pure, over the rows measured each frame; a gap
offers only the depths that keep the tree what it shows, before the row below at its depth or after the row
above closing any of the groups it ends. Rows stay where they are during a drag — a tree's rows moving apart
would put the line somewhere other than where the pointer is — and the carried ones dim. The bands are 30 / 40 /
30 instead of 25 / 50 / 25, now that a gap between two rows is the bottom of one and the top of the next. The
scrollbar is `::-webkit-scrollbar` with Firefox's `scrollbar-color` only where the pseudo-elements are not
supported, because Chromium stops reading them wherever the standard properties are set.

## Rejected

- **Text and guides, no icons.** Blue text still marks a prefab, but a piece and one of the level's own objects
  stay alike.
- **The eye on the left, over the indent.** Nothing pushed right, and it crowds the twist at the top level.
- **Today's drag with bigger bands.** Still the browser's drag, still no depth and no auto-open.
- **The slim scrollbar on the Hierarchy only.** One look everywhere was Kodjo's pick.
