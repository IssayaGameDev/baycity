# ADR 0164 — A click selects an asset, a drag places it

Status: accepted. Replaces arming: a click armed an asset and the next viewport click placed it.

## Context

A click on a prefab or model tile armed it, a hint said *Click in the viewport to place X · Esc to cancel*, and the
next viewport click placed it; a click on any other tile opened it in the Inspector. Two meanings for one click,
and a mode to fall out of. Kodjo: the Unity way.

## Decision

Kodjo's calls:

| # | Decision |
| --- | --- |
| 1 | A **click selects** any tile and shows it in the Inspector |
| 2 | A prefab or a model is **dragged into the viewport** to place it, with the surface and snapping a placement had |
| 3 | While it is held there, a **see-through copy follows the pointer**, so you see where it lands; only you see it until you let go; Escape cancels |
| 4 | A **double-click opens a prefab**, as its right-click *Open prefab* does |
| 5 | The arming click and its hint go |

One that cannot go into this game (ADR 0076, ADR 0161) is still selected by a click, and dragged over the viewport
says why beside the pointer instead of taking the drop. The right-click menu's *Place in the level* went with
arming: a placement is a drag.

## Rejected

- **Nothing until it is dropped.** Simpler, but you guess where it lands.
- **Double-click does nothing.** Opening stays two clicks away, in the menu.
