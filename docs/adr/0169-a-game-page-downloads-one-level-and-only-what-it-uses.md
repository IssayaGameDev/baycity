# ADR 0169 — A game page downloads one level and only what it uses

Status: accepted. Amends ADR 0084 (the rejected "games fetch content from the box at runtime"), ADR 0089 (the level
read live at boot, now everything the level uses) and ADR 0161 (a build packing its levels' assets into the code).

## Context

A game's code carried its content (`virtual:game-content`): every level of the game, and on the box every asset of
its library and Shared's. Every player downloaded all of it to play one level. On the box every asset edit — a
material written behind, a prefab saved, a file uploaded — changed a module and reloaded every open game page,
the editor's Play frame included; only levels had stopped doing that (ADR 0089). The live level fetch also switched on
from a heuristic, "served under a base path", which a shipped build could trip.

Kodjo's direction: a player downloads what the level they play uses. Keyboard will ship alone as a build uploaded to
web portals, with no server of ours behind its files; later every game will be one app on his own domain, sharing
assets. Streaming parts of a level is out of scope.

## Decision

- **Every file stays its own file**, at its path from `content/`, and a level comes with **a list of what it needs**
  (`@mp/content` `levelNeeds.ts`): the level's address and every asset it uses through its prefabs and materials
  (`usage.ts`), limited to the game's own library and Shared's, plus what the code loads by path (`CODE_ASSETS`),
  each with its kind and address.
- **The same addresses everywhere**, relative to the game page: `content/<game>/levels.json` (the index: levels, and
  the default by ADR 0108's rule), `content/<game>/levels/<name>.needs.json`, then each entry's `url`. The page
  (`loadLevel`) reads the index, the list, then the level with every prefab and material on it; textures and models
  come as the renderer asks. It never knows who answers.
- **Who answers** (`game-content.ts`): a build writes the files, hashed, with the lists pointing at them; the local dev
  server makes them from disk and reloads on a content write (ADR 0084's loop); on the box the dev server proxies
  them to the editor server's `/api/play`, which answers from live documents. Nothing of `content/` is in a game's
  code, so no content edit reloads a player.
- **`/api/play` wants the login, not the editor's user list** (`identifyPlayer`): the page is only behind the login,
  and it has no bundled copy to fall back on any more, which is what an unlisted player played before.

## Rejected

- **One pack per level** (the level, its prefabs and materials in one file). One request, but an asset shared by ten
  levels is copied into ten packs, and an edit to it changes all ten — against one app sharing assets across games,
  and against streaming later.
- **Per-level code chunks** (content still imported, split by level). Keeps content in the module graph, so edits on
  the box keep reloading pages, and a build still freezes content into code.
- **`game.json` in the list too.** The rules build the registry from it at import; out of this change, and a settings
  edit on the box still reloads open pages.
