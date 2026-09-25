# ADR 0159 — Assets that are data files are live documents

Status: accepted, in progress. Step 3 of the asset rework (ADR 0156, 0157). Done: the layer, with materials on it
and their lock gone; one undo for everything (below). Next: who has which asset open. Amends ADR 0083's "locks per
file, taken on open" for materials.

## Context

A material was a file with a lock (ADR 0083): clicking one took it until the level changed, so nobody else could
edit it — a click just to look at one blocked the others — and a rename left it unlocked (the lock followed the
path). No undo. Everything else is edited at once by anyone now (ADR 0089, ADR 0158), and more editable data-file
kinds will come: Kodjo asked for the shape to be general rather than for materials alone.

## Decision

**Any JSON asset the editor edits is a live document**, the way a level is; the ops know nothing about what the
file means.

| Part | Now |
| --- | --- |
| ops | `@mp/content` `liveAssets.ts`: `set` a value at a path, or `unset` it; `applyAssetOps` (with inverses), `diffAssetOps`, `isAssetOp`. A kind is live when it has a validator (`LIVE_ASSET_KINDS`): `material` now. A new kind is a validator and a panel, not a protocol |
| the server | `liveAssets.ts`: a document per asset, opened on its first edit, kept until its file is deleted. A batch applies in arrival order, is numbered, and goes to **every** editor in any room (`asset` event) — a material is drawn in every level — the sender's copy being its acknowledgement. Written behind like a level, into the editor's session. No lock: the last to land stays (ADR 0158) |
| the route | `POST /api/live/asset/<id>/ops` on the editor's room connection: an asset is not a room anyone joins |
| the copy | `GET /assets/<path>` serves the live copy, with `x-asset-epoch` / `x-asset-seq` saying which edits it holds; `PUT` over one open live is 409 |
| the editor | `assetSync.ts`: what the server confirmed, the one batch in flight, the edits waiting (merged by path, newest value) — shown in that order, so a collaborator's edit lands beneath this tab's. A number out of step (a gap; an epoch from before a restart) fetches the live copy |
| the Inspector | an edit is `diffAssetOps(shown, edited)`; someone else's updates the fields in place, not the one being worked in |
| the watch | never fetches a live asset's file over its live copy (ADR 0156): its contents come as its edits do |
| undo | one history for the level and its assets, in the order made (Kodjo: one undo for all, as Unity). An asset entry is its ops and their inverses, undone by sending those as this tab's edit — so it overwrites whatever landed since, as a level undo does — and it shows that asset. A colour drag is one entry |

Prefabs stay their own kind of live document (ADR 0091): a node tree, with the tree's ops.

## Rejected

- **A room per material that an editor joins while it is open.** The others still need every edit, to draw it —
  so a second path for them, and a second stream per tab for the one editing.
- **Ops that know materials** (`setParam`, `setShader`). Every new kind would be new ops, on both sides.
- **Keeping the lock, released on selecting something else.** Still one person at a time, still no undo.
- **A history per material, while it is open.** Two Ctrl+Z orders to keep in mind; Kodjo chose one.
