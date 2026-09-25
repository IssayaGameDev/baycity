# ADR 0156 — Asset changes reach every editor, and the server keeps its asset list in memory

Status: accepted. Step 1 of the asset rework Kodjo asked for after the backbone review; the rest (reloading only
what changed in the renderer, materials, leftovers, large files in git) are later steps with their own ADRs.

## Context

- **Nobody else's asset change reached you.** An editor read the asset list and every material and prefab at
  boot, and again only after its own file operations. Another person's upload, rename, move, delete or material
  edit appeared with your next file operation, or a page reload.
- **The server walked the tree for every lookup.** `GET /api/assets` ran the importer, and so did every `GET` or
  `PUT` of a prefab file (to find whether it was open live) and every miss in the prefab store — so one editor
  loading the library walked the whole asset tree once per prefab.
- The server already numbers every path it writes (`changes.ts`), and answers a long poll the moment there is news:
  the live mirror follows it (ADR 0084).

## Decision

| Part | Now |
| --- | --- |
| the list | `createAssetIndex(assetsDir)` (`assetIndex.ts`): one walk, then lookups (`entries`, `byPath`, `byId`). Every API write and every `GET /api/assets` rescans; a lookup that finds a file it has not seen refreshes once. Shared by the API and the prefab store, so a prefab the API just moved is where the store looks |
| the feed position | `GET /api/assets` → `{ entries, folders, seq }`: where the feed stood, read in the same tick as the list |
| the watch | the editor follows `GET /api/changes?since=seq` (`assetWatch.ts`) — the mirror's feed, no new route or event — and hands on the asset paths. 410 (a restart, or too far behind) reloads everything; errors back off 2 s → 30 s |
| applying | fetch the list and only the named JSON files (`loadAssetLibrary({ reuse, refetch })`); `libraryChanges` says whether the list changed and whose contents did (JSON compared; a texture or model named at the same path is taken as replaced). Nothing changed — this tab's own write coming back — does nothing. Contents the renderer compiled (a material, texture, model) reinstall the runtime and redraw; the rest (a prefab, a new or moved asset) only swap the library, since the runtime reads it through a live view |
| not on top of work | a drag or a play-test finishes first; paths gathered meanwhile are one batch |
| its own writes | a path this tab holds the lock on is skipped: only this tab writes it, and a drag's saves come back out of step with the ones in flight |
| the dev server | gets a feed as well, so the watch runs the same in `pnpm dev:editor` (without one it would be answered at once, and spin) |

Levels go by on the feed too — every live edit's write — and are not the watch's: one open here is live already,
and one that is not is read fresh when opened.

## Rejected

- **A new event on every room's stream.** A tab with no room open (between two, or on a material) misses it, and
  it duplicates a feed that already exists and is already tested.
- **Asking for the list every few seconds.** A walk per editor per interval, and a delay on every change.
- **A WebSocket.** A new dependency for what a long poll already does through Cloudflare.
