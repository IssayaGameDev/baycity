# ADR 0155 — The status bar becomes notices, and its state moves to where it belongs

Status: accepted, in progress. Steps 1 and 2 of 3 have landed. Step 1: the notices, and every item the bar carried
moved or dropped. Step 2: who is in the room at the top bar's right end — everyone's icon in their outline colour,
yours last with a dot for the connection, the Hierarchy's hold badges in the same colours, a toast when someone joins
or leaves, and a card per person with **Focus** (frame what they hold, open the Hierarchy down to it) and **Follow**
(your camera copies theirs; theirs is sent ~5 Hz, and only while someone follows). Kodjo's calls on Follow: any move
of your own ends it — rotating while following, around their point or in place, and a camera locked against input
were both rejected — and a frame round the viewport in their colour plus the hint pill show it. **Parked after step
2**, Kodjo's call: step 3 (who is in which level, on the Project panel's tiles) was too narrow — who is on which
asset, of every kind, belongs to the asset panel's rework, not to tiles that rework will replace. Every choice a
person sees is Kodjo's, asked with the question tool.

## Context

One 22 px line at the bottom of the editor carried seventeen things, joined with `·` and cut off at its right end:
your name, the level and its object count, a lock, the room and who was in it, the selection, the Motion clock,
the placing hint, the undo depth, the clipboard, about eighty messages sharing one slot that never faded, and two
lasting problems. Its length changed with every item, so nothing had a place, and a new message overwrote an error.

## Decision

| item | now |
| --- | --- |
| messages | **toasts** in the viewport's corner, by kind (`notify.ok` / `warn` / `error`): a confirmation fades in 2.5 s, a refusal in 5, an error stays until closed; repeats count up. Every one also goes in a **log** behind the top bar's **bell**, whose red count is the errors not yet seen |
| lasting problems | a **banner** above the viewport until fixed: the editor's own problem and the content push's |
| undo depth | **undo / redo buttons** at the top bar's right end, greyed when there is nothing, the tooltip saying what they would do and how many more |
| lock | a badge beside the level's name: `Read-only · Ana has it` |
| Motion clock | beside the Motion button while it runs |
| placing, playing | a hint pill over the viewport |
| face pull's size | a readout beside the pointer |
| object count | the Hierarchy's header |
| selection, level name | dropped: the Inspector, the Hierarchy and the top bar already say |
| clipboard, your name | dropped; your name comes back as your icon in step 2 |

Technical choices under it: the kind is chosen where the message is written, so a host gets `notify: Notify` rather than
a string sink; the banner sits above the stage rather than over it, so it cannot cover the navigation gizmo the canvas
draws in its own corner, and a `ResizeObserver` on the canvas keeps the post-FX targets in step; toasts and the log are
`textContent`, never markup.

## Rejected

- **A slimmer bar with the latest message** (Unity's). Nothing covers the scene, and a message is easier to miss.
- **Fixed zones for every item.** Nothing lost, and still a bar of seventeen things.
- **Problems as a sticky error toast.** Closable, and then forgotten while the problem goes on.
- **Dropping the undo depth.** The toast says what an undo did, but nothing would say beforehand whether there is one.
