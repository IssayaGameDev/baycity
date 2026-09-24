# ADR 0147 — A sequence is edited as cards on a rail, with its own controls

Status: accepted. Restyles [ADR 0143](0143-a-sequence-is-edited-as-boxes-in-the-inspector.md)'s boxes; the
model and what each gesture commits are unchanged. Every choice below that a person sees is Kodjo's, asked with
the question tool and two options each.

## Context

The editor worked, and read as a developer's tool: the settings were Tweakpane rows and the steps our own boxes,
two fonts and two kinds of field in one panel; a step's line was a monospace string (`move (0.5, -9.617, -2.74)
0.5 s linear`) that an open step repeated above its fields; a number could only be typed; and dragging needed
the pointer to land on a 5 px gap.

## Decision

| | |
| --- | --- |
| layout | stages as **cards on a rail**, a `+` on the rail to insert a stage anywhere, and a bar of stage lengths in proportion |
| a step, closed | **one line**: an icon per kind on a chip **tinted by kind**, the name, the values rounded to a tenth, the duration in a column that lines up down the sequence, the ease as a tiny curve. Grip and × on hover |
| a step, open | only its icon and name above the fields: nothing repeated. Several may be open at once |
| fields | numbers you **drag sideways** or click to type, with red/green/blue X Y Z; timing as a switch; the ease picked from a **grid of curves** |
| settings | clock, loop and axes as **icon toggles** in the header; name, repeat and offset in a **popover** from ⚙ |
| adding | a palette of kinds with their icons; a new step opens |
| drag | rebuilt on pointer events: grab a line or a card's header anywhere, a copy follows the pointer, the rows slide apart, the **nearest** place wins, the panel scrolls at its edge |

Technical choices under it: every control is ours (`controls.ts`, `seqIcons.ts`, `easeCurve.ts`), no dependency;
a dragged number commits **once**, when the drag ends, because an edit rebuilds the panel under the pointer; a
field's key carries the focus across that rebuild to the field clicked next; one popover at a time, as there is
one context menu; where a drop lands is `placeFor`, pure, over measured boxes.

## Rejected

- **Timeline first** — a bar of stages with only the chosen one's steps below. Compact, but the whole sequence
  is never in view.
- **Two-line steps.** Easier to read, twice as tall in a narrow panel.
- **Today's fields restyled.** Typing stays the only way to change a number.
- **Today's drag with bigger targets.** Still the browser's drag, still a thing to hit.
- **Settings as rows under ⚙.** Every setting spelled out, and the stages pushed down.
- **One step open at a time.** Kodjo kept several.
- **One neutral icon colour.**
