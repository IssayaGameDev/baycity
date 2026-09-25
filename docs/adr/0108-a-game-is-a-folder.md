# ADR 0108 — A game is a folder

Status: accepted. Finishes the job [ADR 0052](0052-a-game-is-a-descriptor.md) started; the shared asset
library is unchanged, and so is [ADR 0026](0026-asset-pipeline.md)'s rule that a reference is an id. Amended by
[ADR 0161](0161-each-game-has-its-own-asset-library.md): each game has its own library beside the shared one. Levels
left the Project panel's tree for the games window ([ADR 0162](0162-the-games-window-holds-the-levels.md)).

## Context

Kodjo: *"I don't like the way that we have to select which game we want to be in and then which level we want
to open."* Two dropdowns in the toolbar, and nothing about a game in the Project panel.

ADR 0052 listed twelve places where the editor answered a question only a game can answer. The twelfth was
*"`content/levels/` was flat, so every game's levels would appear in every game's picker"*, and the fix at the
time was a tag inside each file plus a filter in the UI. That tag is the last implicit answer:

- **It can be absent, stale, or in a file that will not parse.** `GET /api/levels` had to list a broken level
  without its game, and the editor and the game each carried an "unassigned levels are always offered" branch
  for files that predate the tag.
- **It cannot make two games own a `default`.** `packages/game-client/src/levels.ts` carried the apology in a
  comment: *"a level's name is its filename and `content/levels/` is shared: two games cannot both own
  `default.json`"*. Swing boots on a level called `swing` for no reason but that.
- **There is nowhere for a game's own things to live.** The question that prompted this was about browsing, and
  a flat directory of everyone's levels has nothing to browse.

Kodjo also asked whether assets should go per game. They should not, and the content says so: of twenty
assets, **nine are used by more than one game** and four by exactly one. Splitting would duplicate nearly half
of them, and duplicates drift.

## Decision

**A game is a folder at the content root**, holding its own `game.json` and its `levels/`. Assets stay one
shared library.

```
content/
  keyboard/  game.json  levels/default.level.json
  parkour/   game.json  levels/default.level.json
  swing/     game.json  levels/swing.level.json
  assets/    materials/ prefabs/ textures/
```

`packages/content/src/layout.ts` is the only place that spells this out, because three readers have to agree:
the server, the editor and the game. It used to be spelled out at a dozen call sites — a regex in the API
router, a `join` in two servers, a glob in the game, a template string in two lock-key tables.

**A level's identity is the qualified `<game>/<name>`** — the API route, the lock key, the live document key,
the editor's open file. Two things stay bare, and deliberately:

- the level's own `id` field, because an `id` is a file name;
- the game's `?level=`, because the page knows which game it is and qualifies the name itself. So every game
  may own a `default`, and the URLs do not get longer. The multiplayer room was already keyed on game *and*
  level (`filterBy(['game', 'level'])`), so two games' `default` were never one room.

The folder is authoritative for which game a level belongs to. `config.mode.name` stays in the file and is
kept in step, because a level fetched over HTTP has no folder to read and `LevelSource.validate` still has to
refuse another game's.

`assets` is not a legal game name: the shared library has that folder.

## In the editor

The two dropdowns are gone. The Project panel's tree is games first, each expanding to its levels, then the
shared asset library; clicking a level opens it, clicking a game authors for it without opening anything.

`Place` is a union — `{ at: 'game', game }` or `{ at: 'assets', folder }` — rather than a path with a reserved
prefix, because the two are not one tree: a game is not a folder of assets and its levels are not asset
entries. `gameRows` is the pure part and is tested; the rest is DOM.

## Migration

`tools/editor-server/src/layoutMoves.ts` plans and applies; `migrateLayout.ts` is the CLI around it.

Nothing inside any file changes — a level's folder is the game it already declared — so it is a pure rename,
and the gate is exact rather than a sampled fingerprint: every move is verified byte-for-byte. Asset ids are
untouched, so no level or prefab is rewritten. A level declaring no game is refused and named rather than
filed somewhere invented, and any refusal moves nothing at all.

`deploy/editor/migrate-layout.sh` runs it once, by hand, like the three migration scripts beside it: stop the
server (an open live level holds its own copy and would write it back to the old path), move, commit on
`content`, push, restart.

It is **not** a step in `deploy/editor/update.sh`. It was, to close the window where the box has the new code
and the old layout — an editor showing no levels — but a one-off does not belong in the thing that runs every
deploy, and putting it there also stopped the server for the whole install and build rather than just the
restart. The window is the price of the transition: deploy, then migrate.

## Rejected

- **Levels as assets under `content/assets/<game>/levels/`.** Reuses the asset database, the folder tree, the
  tiles and the previews as they are. But levels are not assets — nothing references one by id — and the word
  `assets` in the path of every level is the thing that would need undoing later.
- **Assets split per game**, which is what the question originally proposed. The numbers above.
- **Keeping the flat folder and grouping in the UI only.** The cheap version: no migration, no API change. It
  leaves the tag as the source of truth, so every reader keeps its "unassigned" branch and no game can own a
  `default`. Kodjo chose the disk matching the model.
- **A compatibility shim reading both layouts** for one release, so master is green at every commit. Code
  written to be deleted; folding the migration into the deploy gets the same result with none of it.
