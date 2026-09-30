# ADR 0175 — A shared component can be removed from a game

Status: accepted. Extends ADR 0077 (a game's shared components are data the editor adds to).

## Context

A game's shared components are a list in `content/<game>/game.json`. The editor appended to it — adopting one on
open, on a placement, from Add Component — and nothing took one out: the games window's Components tab was
read-only, and the list could only shrink by editing the file, which lives on the box. The editor's registry
also only ever added the live list over the bundled one, so a type dropped from the file stayed until a redeploy.

A game without a type cannot load a level that has one (`validateLevel` throws on an unknown type), and the editor
adopts it straight back the next time such a level opens.

## Decision

- A Shared row in the games window's Components tab has a remove button. Removing is an edit to the live data file.
- **Refused while anything of the game uses it**, with where (Kodjo's call): its levels, each with the prefabs placed
  in it (the server's listing, fetched again first, which counts live rooms), and its own prefabs, placed or not.
  A level the server could not read refuses too: it may hold one.
- `registryFor` builds a game's shared types from the live list alone — added and removed — keeping the code's own
  and built-in ones.
- No undo entry, as adoption has none: adding one again adopts it.

## Rejected

- **Removing it and stripping it from every object of the game.** One click, but it silently changes levels,
  including ones friends are in.
