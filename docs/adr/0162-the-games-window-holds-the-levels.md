# ADR 0162 — The games window holds the levels

Status: accepted. Amends ADR 0108, which put the games at the top of the Project panel's tree, and ADR 0052, whose
Game row and game dropdown this replaces.

## Context

The editor holds several games sharing one asset library (ADR 0161). The Project panel mixed the two: games with
their levels at the top of the tree, the libraries under them, and levels listed twice, as rows and as tiles.
Kodjo: a game is not a folder of assets; the Project window should be the libraries, and the games a place of their
own, PlayCanvas's project dashboard his reference.

## Decision

Kodjo's calls:

| # | Decision |
| --- | --- |
| 1 | A **top-left button**, `Keyboard › Roblox ▾`, opens a window over the editor |
| 2 | **Games on the left**; the picked game's page with **Levels**, **Settings** and **Components** tabs |
| 3 | Levels: tiles, **who is in each**, double-click opens (and so moves the editor to that game), right-click New / Duplicate / Rename / Delete. Picking a game only browses |
| 4 | Components: read-only — its own, the shared ones it took, the built-in ones |
| 5 | Settings: the game's tunings and curves, moved from the Hierarchy and made **live** like materials (step 3) |
| 6 | A level moves to another game by dragging it onto that game, with a short confirmation; refused, with why, while it uses another game's own components or its old game's assets, or someone is in it (step 2) |
| 7 | The Hierarchy's Game row becomes **Level** (network bounds); Environment keeps its row. The Inspector's game dropdown goes: the folder is the game, and it only changed a tag inside the file (step 3) |
| 8 | No "New game": a game still starts as code |

A level moved to another game keeps its tag in step with its new folder. The editor greys a game that cannot take
it before the drop, from what it knows — a level of that name there, someone in it, another game's own component
(the level listing names the types each level uses) — and the server refuses the rest: its old game's own assets.

A game's settings are its `game.json`'s, and that file becomes a live document of the kind materials are
(ADR 0159): an id no asset can have (`game:<game>`), a validator, a route; the same ops, events, numbering and
write-behind. So a change shows at once, is everyone's, overwrites nothing silently, and is an entry in the one
undo history — which is why the curve graph's own history goes. Adopting a shared component is an op on the same
document.

Who is in which level comes from the server: every document anyone is in, sent to every connection on each join
and leave (`rooms`). A level made, renamed or deleted elsewhere tells every editor to read the list again
(`levels`).

## Rejected

- **Keeping levels in the Project panel, grouped by game.** Levels are not assets, and Unity has one game.
- **Asking the server for who is where on a timer.** Every tab polling for what the server already knows the
  moment it changes.
- **Keeping the whole-file PUT for settings.** Two people editing two settings: the second write drops the first.
- **A protocol of its own for game files.** The material one already has everything; a file that is not an asset
  only needs an id of its own.
