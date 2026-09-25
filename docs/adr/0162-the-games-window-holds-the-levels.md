# ADR 0162 — The games window holds the levels

Status: accepted, in progress. Step 1 of 3 has landed: the window, its Levels and Components, who is in each level,
and the level list kept live. Next: moving a level to another game; then the game's settings, made live. Amends
ADR 0108, which put the games at the top of the Project panel's tree.

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

Who is in which level comes from the server: every document anyone is in, sent to every connection on each join
and leave (`rooms`). A level made, renamed or deleted elsewhere tells every editor to read the list again
(`levels`).

## Rejected

- **Keeping levels in the Project panel, grouped by game.** Levels are not assets, and Unity has one game.
- **Asking the server for who is where on a timer.** Every tab polling for what the server already knows the
  moment it changes.
