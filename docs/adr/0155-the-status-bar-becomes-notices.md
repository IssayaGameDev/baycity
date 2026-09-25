# ADR 0155 — The status bar becomes notices, and its state moves to where it belongs

Status: accepted, in progress. Step 1 of 3 has landed: the notices, and every item the bar carried moved or
dropped. Step 2 is presence in the top bar (everyone's icon, Focus and Follow); step 3 who is in which level. Every
choice a person sees is Kodjo's, asked with the question tool.

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
