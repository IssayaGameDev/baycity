# ADR 0171 — Parkour, Swing, the viewer and `Goal` are deleted

Status: accepted. Keyboard is the one game; `modes/_template` stays as the game to copy.

## Context

Parkour (the first game, "the reference obby") and Swing (a rope locomotion, ADR 0067) are no longer played or
developed; Keyboard is. Neither is hosted on the box, so in the editor they only ever played in place, a
hand-built copy of each game inside the editor that had drifted until it no longer worked. `tools/viewer` showed
one hard-coded Parkour level with debug overlays and its own play-in-place, all of which the editor now does.
`Goal` was a shared component with no behaviour ("no goal rule exists yet"); only those two games listed it,
and adding it to a game did nothing.

Kodjo: they are dead; remove them, and the viewer with them.

## Decision

- `modes/parkour`, `modes/swing` and `tools/viewer` are deleted, with their scripts, docs and tests. The share tool
  and the bots default to Keyboard.
- `Goal` leaves the shared library. A game wanting a finish line gets one with a rule behind it.
- Their content — `content/parkour`, `content/swing` — is removed on the box by `deploy/editor/remove-parkour-swing.sh`,
  a one-off like the earlier migrations, so it reaches master through the `content` branch as every content change
  does. Until then the level check skips a level whose game has no code.
- Shared assets only their levels used stay until someone deletes them in the editor.

## Rejected

- **Hosting them on the box** so they get a Play window like Keyboard's: two more dev servers on a 4 GB box for games
  nobody plays.
- **Keeping `Goal`** as a menu entry for later: an entry that does nothing is a trap for whoever adds it.
