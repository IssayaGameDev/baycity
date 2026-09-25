# ADR 0161 — Each game has its own asset library, beside the shared one

Status: accepted. All five steps have landed: an asset's path starts with its library; which levels use which asset;
moving between libraries; the rule in the editor and a check per game; what a game build carries. Amends ADR 0108's
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

**Step 2: which levels use which asset** (`usage.ts` in `@mp/content`), found as Unity finds a dependency: an id
appearing in the file. A string equal to a known id is a reference wherever it sits, so a game's own components,
whose fields no shared code knows, are covered like the shared ones; a prefab or material used is followed to what it
uses in turn. Counting a little too much is safe for a refusal and a build; counting too little is not.

**Step 3: moving between libraries.** Refused into a game's library while another game's level uses any of it
(Kodjo's rule), and — so that rule cannot be got round through a material — while an asset in another library uses
it: a Shared asset is anyone's, so it uses only Shared's. Refused anywhere while what it uses is in neither Shared
nor where it goes, unless that moves with it. The Project panel draws the open game's library below Shared until the
panel is rebuilt (Track B).

**Step 4: the rule, where a reference is made.** `mayUse(user, path)` in `@mp/content`: a game's levels and its
library's assets use its own and Shared's; Shared's use only Shared's. The object Inspector's asset pickers and the
material's texture slot offer only those, and placing refuses the rest, as it refuses another game's private
component. `libraries.test.ts` reads every game's content and fails on anything outside.

**Step 5: what a game carries** (`game-content.ts`, a Vite plugin making `virtual:game-content`, which replaced the
game client's globs over every game's levels and all of `content/assets`). Its own levels and its own library and
Shared's, never another game's. A build takes only what its levels and `game.json` use, plus what the client's code
loads by path (`CODE_ASSETS`: the sky, which no level names). The staging game on the box is a dev server whose page
reads its level live, so served it keeps the whole of both libraries. Materials and prefabs are read as data and no
longer also packed as files. Whether a build should warn above a size is Kodjo's to say, now that it is measured.

## Rejected

- **A `root` field on the entry beside a library-relative path.** Two strings to keep in step at every map, key and
  drag, where one path says both.
- **Keeping `/assets/<path>`.** `/assets/assets/…` for Shared, or an ambiguity with a Shared folder named like a game.
- **Reading references from each component's declared asset fields** (`assetParamIds`). It needs every game's
  registry, which the server does not load, and misses anything outside a component.
