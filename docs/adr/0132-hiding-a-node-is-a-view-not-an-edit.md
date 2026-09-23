# ADR 0132 — Hiding a node is a view, not an edit

Status: accepted. Unity's eye column. Sits beside [ADR 0099](0099-a-node-can-be-switched-off.md)'s `active`
flag without touching it, and puts a control back in the Hierarchy that
[ADR 0102](0102-the-active-checkbox-lives-in-the-inspector.md) took out — under the condition 0102 set.

## Context

Kodjo wanted Unity's scene visibility: hide something in the Hierarchy so it is not drawn in the viewport and
cannot be clicked there, while the game is unaffected.

The editor already has `active` (ADR 0099), and it is the wrong tool: it switches the node off **in the
level**, which reaches the game, reaches everyone, and is a content edit that has to be merged. Hiding is
none of those things. It is how one person looks at the level while working on it.

## Decision

**A hidden node builds no meshes.** That is the whole implementation of both halves: nothing is drawn, and
picking raycasts the meshes, so it cannot be clicked either. The group still exists, so indices, the
Hierarchy and every child's frame are untouched.

| | |
|---|---|
| Click the eye | hides the node **and everything under it** |
| Alt-click | hides that node alone, children left visible |
| **Reveal** in the toolbar | shows everything without forgetting it; hidden when nothing is hidden |
| Play | unaffected — Play is the real game (ADR 0086), and a hidden object is still in it |

**Shared, and durable, and not in the level file.** Kodjo asked for all three. So it lives in the editor
server's `stateDir`, in `hidden.json` beside `locks.json`: it belongs to the server, not to the content, and
putting it in the level would make looking at a room a content edit everyone has to merge.

It travels the room the way everything else in this editor does — live, not on reload. Every other kind of
state here is live (ops, holds, peers, presence, prefab edits), and the level's SSE stream already carries
six event types; `hidden` is the seventh, riding the snapshot on join so the first paint is already right.
Shared-on-reload would have been the one thing in the editor that is not live, with two people looking at
different scenes and nothing on screen saying so.

**The whole set every time, never a delta**, so a dropped event cannot leave two editors disagreeing about
what is on screen. No sequence number and no holds: it is not an op, it contends with nobody, and it never
reaches the file.

**Keyed by `refKey`**, the same string holds use. A prefab's piece is therefore keyed by the placement it is
under, so hiding one wall does not hide it in every tower.

**Every descendant is named, rather than hidden by implication.** A set lookup is then all of `hiddenAt`,
with no ancestor walk on the render path — and, more to the point, "hide this one only" and "hide this
branch" stay two different sets rather than one set plus an exception. The cost is that a child added later
is not hidden by its parent's earlier toggle, which is visible to the person who can fix it.

## The Hierarchy, and ADR 0102

0102 removed a checkbox column from the Hierarchy because "a column of checkboxes running down it competes
with the names it exists to show". That objection is right and still holds, so the eye answers it rather
than ignoring it:

- **Empty until the row is hovered**, and always drawn once the node is hidden, so the column costs nothing
  when unused. This is also what Unity does.
- **A fixed gutter at the left of the panel, outside the indentation**, so the eyes line up however deep the
  tree goes. Indented, they would zigzag.
- **A hidden row does not dim.** Dimming already means switched off, and the two mean entirely different
  things — one is editor-only, the other is missing from the game. The icon is the only indicator.

## Rejected

- **Reusing `active`.** It is content: it reaches the game and everyone, which is the opposite of this.
- **Browser-local storage**, which was the first proposal. It is per-person, and Kodjo wants it shared.
- **A file in `content/`.** Shared and durable, and it makes hiding a content edit riding the content branch
  (ADR 0083) — the exact thing being avoided.
- **Shared on reload rather than live.** Roughly half the work, and the only state in this editor that is
  not live. Rejected once the live channel turned out to be one more event on a stream that already carries
  five kinds of state.
- **A separate pickability toggle**, Unity's second column. Kodjo described one control doing both, and a
  thing you can click but cannot see is a puzzle, not a feature.
- **Dimming the hidden row as well as drawing the eye.** Easier to scan, and it collides with the one visual
  the Hierarchy already uses for something else.
