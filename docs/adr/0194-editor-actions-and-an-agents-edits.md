# ADR 0194 — Editor actions, and an agent's edits in a shared level

Status: accepted. Kodjo's calls: the action list now, the agent that drives it and MCP later; one undo for everything
one prompt did; undoing it leaves what someone has changed since — and so does everyone's own Ctrl+Z, reversing
ADR 0089's undo rule; what undo cannot take back stays out until it can;
an agent stays off what someone else has selected; the selection stays the person's when an agent edits; a picture of
the viewport, small and light.

## Context

The assistant's next level is to use the editor as a person does. The editor's ~120 actions were wired straight to
clicks — `main.ts` and the panels calling subsystems on "whatever is selected" — with no list an agent could be handed.
The editor is live and shared: no locks, the last batch wins, holds shown and never refusing (ADR 0158), undo per tab,
and a server that checks only a level's structure.

## Decision

- **Actions in the tab, through the editor's own calls**: the `Doc`, the history, the room, the Inspector's refusals,
  the Hierarchy's reframe, the Project window's placing checks. Named, input as checked data, ids as `refKey`s.
- **One batch an action, all or nothing**; **one undo entry a turn** (one prompt), level and asset steps together.
- **Undo checks values, per key**, for every entry — a person's edit as much as an agent's turn: a step goes back only
  while what it wrote is still there; the rest is given up and said.
- **Holds are the agent's fence**: in a turn, an edit touching a node another connection holds is taken back unsent.
  People are never refused.
- **Built now, run later**: every new editor feature adds its action, so the list is whole when an agent is handed it.

## Rejected

- **A headless client on the server** joining rooms: it would need every game's registry and the browser-only logic
  (prefab override write-back, refusals, adoption) copied, and its edits would sit in no person's undo.
- **Tracking who touched what since a turn** to decide its undo: wrong once edits are undone out of order — a later
  edit of yours undone first puts the agent's value back, and a record of your touch would still keep it.
- **Undoing whole regardless**, overwriting others' work (ADR 0089's rule until now); **refusing an undo whole** when
  anything changed since.
- **Locks for agents**: holds already say who is where, and people stay unrefused.
- **MCP now**: every feature would have to be added twice while the editor grows; the list is the one place.
