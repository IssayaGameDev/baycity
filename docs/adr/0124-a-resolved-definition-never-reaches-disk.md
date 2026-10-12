# ADR 0124 — A resolved definition never reaches disk

Status: accepted. Repairs a promise ADR 0091 made in three places and kept in none. A fourth door — a duplicate of
an open level — and the levels that already carried a copy: ADR 0204.

## Context

`level.prefabs` is a **resolution** table: the contents a document needs in memory to draw a placement's
inherited nodes, apply its overrides and validate an op against it. It is filled from the asset store on open
(`hydratePrefabs`) and removed again on the way out (`stripHydrated`). Reference on disk, contents in memory —
which is what Unity does with a prefab GUID, and what ADR 0091 intended.

Three doors add an entry mid-session: placing a prefab, pasting a clip that carries definitions, and **Save as
prefab**. Each said so in a comment:

> not an op and never written to the level … the save strips whatever was resolved

None of them recorded the id, and `stripHydrated` strips only what it is told. The editor's own list was
`hydratedPrefabs`, **assigned** once in `openFile` from that pass's `filled`, so an id resolved later in the
session was invisible to it. So the claim was true only of the ids present when the file opened.

What makes a definition on disk more than clutter is `hydratePrefabs` skipping an id the level already
carries — a deliberate compatibility path for content predating prefab assets, where the level's own table
*was* the only source. From then on the frozen copy is read **instead of** the asset, permanently, by both the
editor and the server. And because it is never in `filled`, it is never in `d.hydrated`, so every subsequent
write keeps it: self-perpetuating.

The visible cost is a placement that looks linked — badge, overrides, Open — and silently stops following its
prefab. `content/keyboard/levels/Roblox.level.json` carries three.

## Decision

**The document records what it resolved.** `Doc.resolvedPrefabs()` is the ids it put in `level.prefabs`, and
all three doors add to it. A save strips the open-time set **union** the document's own.

One place rather than three registrations at three call sites: the doors are inside `Doc`, so the bookkeeping
belongs there, and a fourth door added later gets it by adding one line next to the one it copies.

The ids present when the file **opened** stay the caller's to track. That hydration is the caller's — it owns
the asset source — and a table the level genuinely carries is not the document's to strip.

## Not fixed here

**Levels that already carry a definition.** Stopping production does not relink them, and they cannot relink
themselves for the reason above. That is a change to Kodjo's content, so it is his call and it runs against
the box, not a working copy.

## Rejected

- **Have `stripHydrated` drop every id that resolves to a real asset.** It would clean the files, and it would
  also throw away a table a level genuinely owns — the case the skip in `hydratePrefabs` exists for.
- **Register at each call site in the editor.** Three places to forget instead of one, and the third is the one
  that was forgotten.
- **Stop filling the table and pass definitions beside the level.** The right shape and a much larger change:
  every reader of `level.prefabs` — the loader, the ops layer, validation — would need the second argument.
