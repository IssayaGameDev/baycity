# ADR 0158 — A selection is shown, never refused: anyone edits anything

Status: accepted. Amends ADR 0089's holds (phase 3).

## Context

A node someone had selected was theirs (ADR 0089, phase 3): nobody else could select it, rename it, drag it or
edit anything under it, and the server refused any batch touching it (423). Two people working on the same
platform had to take turns — Kodjo: "two collaborators cannot select the same game object, and that's really
annoying". Batches already reach the server one after another and apply in that order, and every editor
repaints to what landed; the holds were what kept two people apart, not what kept the level consistent.

## Decision

Kodjo's call: **anyone selects and edits anything; two changes to one thing, the last to land wins.**

| Part | Now |
| --- | --- |
| a hold | what one connection has selected, one per connection per node (`holdKey` = `connId` + `refKey`) — several may hold one node. `hold` sets exactly the refs asked, never refusing |
| `apply` | no hold check: the batch applies in arrival order |
| the editor | nothing filtered out of a selection, no "X has that selected"; a Hierarchy row stays selectable, renamable and draggable, with a badge per person who else has it selected, in their colour |
| still shown | their outline in their colour, the badges, the people card's "Selected: …", Focus |

A number field being typed into still ignores what arrives meanwhile, and gets focus back if the panel is rebuilt
under it (`controls.ts`), so a collaborator's edit does not eat a half-typed value.

## Rejected

- **Anyone selects, but a drag or a typed edit in progress blocks the others on that object** until it lets go.
  Fewer surprises, and a lock of its own to build and keep right; Kodjo chose the simpler one.
- **Keeping holds exclusive.** The annoyance itself.
