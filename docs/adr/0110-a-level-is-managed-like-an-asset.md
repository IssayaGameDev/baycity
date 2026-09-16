# ADR 0110 — A level is managed like an asset

Status: accepted. Adds the operations [ADR 0108](0108-a-game-is-a-folder.md)'s tree made reachable, and
overturns the one line of [ADR 0027](0027-content-is-data-only.md) that says the editor has no delete for
levels — it did not, and it does now.

## Context

Kodjo, on the new Project panel: *"reuse the same schema as being able to right-click the level assets,
rename, delete, of course with a very heavy confirm popup, duplicate."*

An asset had all of this and a level had none of it. `packages/game-client/src/levels.ts` recorded why in a
comment: *"it is not deletable, because the editor has no delete for levels at all: those routes are read and
write only, and deleting exists solely for assets."* True, and only because no one had needed it: a level was
reached through a dropdown, and a dropdown is not a place you manage files from. A tree is.

## Decision

Two routes, shaped like the `/api/assets/move|delete` pair because it is the same job:

```
POST /api/levels/move    { from, to }   both qualified <game>/<name>
POST /api/levels/delete  { path }       qualified
```

Checked before the `/api/levels/:game/:name` router, whose trailing `(.+)` would otherwise read `move` as a
level name. Lock-gated like every other write.

**Both refuse with 409 while the level is open live.** The open document holds its own copy, so the next flush
would write it straight back: a rename would silently duplicate the level and a delete would undo itself.

**Renaming the level you have open works anyway**, because the editor leaves first: flush, `collab.leave()`,
rename, reopen under the new name. `leave` now returns a promise for exactly this — every other caller is
leaving on the way to something else and ignores it. A 409 past that point is somebody *else* holding it,
which is theirs to release.

**`to` may name another game**, which moves the level into that game's folder. The folder is the game
(ADR 0108), so a move between folders is the only thing a change of game could mean. The `id` inside follows
the file name, as every writer of a level already keeps it.

Duplicate is not new: it is `createLevel(from)`, which the toolbar button already ran, now also in the menu.

## The confirm

`askDestructive` (ADR 0097) with Cancel as the keyboard default, and the body names the consequences:

- the file goes for good — no undo, and no copy anywhere else;
- whether it is the level you have open;
- whether it is the game's `default`, and what the game will boot into instead;
- whether it is the only level that game has.

Heavier than an asset's, and deliberately. Deleting a prefab leaves its placements behind still drawing what
they drew (ADR 0097); deleting a level deletes the content.

## Rejected

- **Close the live document server-side and do the move anyway.** Would let anyone rename a level out from
  under whoever is editing it. The 409 is the protection; the client leaving its own session is the escape.
- **`DELETE /api/levels/:game/:name`, and rename as a PUT to the new name plus a delete of the old.** More
  RESTful and worse: two writes where one is needed, with a window in between where both or neither exist.
- **Rename via `window.prompt`**, as the asset menu still does. `askName` exists because a prompt's empty
  answer once deleted a file.
