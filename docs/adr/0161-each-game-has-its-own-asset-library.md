# ADR 0161 — Each game has its own asset library, beside the shared one

Status: accepted, in progress. Step 1 of 5 has landed: an asset's path starts with its library. Amends ADR 0108's
single shared library.

## Context

Games share one asset library (`content/assets`, ADR 0108), so every game's builds carry every game's assets, and a
prefab using another game's own component sits in every game's library, greyed out. ADR 0108 kept one library
because nine of twenty assets were shared; Kodjo wants the sharing kept and each game's own things kept apart.

## Decision

Kodjo's calls:

| # | Decision |
| --- | --- |
| 1 | Each game has **its own library**, `content/<game>/assets/`, beside **Shared**, `content/assets/` |
| 2 | A level uses **its own game's assets plus Shared**, nothing from another game's library |
| 3 | Moving an asset between libraries keeps its id; moving a Shared asset into a game's library is **refused** while another game's level uses it |
| 4 | Nothing moves now: everything stays in Shared until Kodjo moves it |
| 5 | Game builds pack Shared plus their own library, then only what their levels use |

Five steps, one commit each: (1) the path says the library; (2) which levels use which asset; (3) the libraries in
use, moves between them and the refusal; (4) the rule, in pickers and a check per game; (5) the builds.

**Step 1: an asset's path is its path from `content/`**, starting with its library — `assets/materials/red.mat.json`,
`keyboard/assets/prefabs/pad.prefab.json` (`libraryDir`, `libraryOf`, `inLibrary` in `@mp/content`). The same name in
two libraries is two assets. The importer scans every library in one pass, so an id is unique across all of them.
Bytes are served at `/content/<path>`, as on disk. The file routes touch only paths inside a library of the shared
one or of an existing game — never a level, a `game.json` or a library's own folder — and a move stays inside one
library until step 3 can say who uses what. Level files store ids, so no content file changes.

## Rejected

- **A `root` field on the entry beside a library-relative path.** Two strings to keep in step at every map, key and
  drag, where one path says both.
- **Keeping `/assets/<path>`.** `/assets/assets/…` for Shared, or an ambiguity with a Shared folder named like a game.
