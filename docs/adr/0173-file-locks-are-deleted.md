# ADR 0173 — File locks are deleted

Status: accepted. Amends ADR 0083 (a file is locked while open, a session commits on release).

## Context

ADR 0083 locked a file while someone had it open: read-only for everyone else, a heartbeat to keep it, a session
committed when the lock was released. One kind of document at a time became live instead — levels (ADR 0089),
prefabs (ADR 0091), materials (ADR 0159), game files (ADR 0162) — and nothing the editor opens is a plain file any
more. The lock machinery stayed: the routes, a table persisted to `locks.json`, a heartbeat every thirty seconds, a
sweep, a "read-only" badge, and a save path for a document that is not a live room, which no document is.

## Decision

The locks go, server and editor: `locks.ts`, `/api/locks/*`, the 423 gate on every write, `locks.json`, the lock
sweep, `lockStaleMs` in `/api/me` and the locks in `/api/status`; the editor's lock client, `readOnlyBy` and its
badge, the heartbeat's lock half, and the non-live save path with its `dirty` flag and unsaved-changes prompt
(`saveNow`, `guardUnsaved`, `askUnsaved`), with `Doc.resolvedPrefabs` that only that save read.

What stays: the heartbeat pings the live connection and learns of a push failure; a session commits when a live
document closes, on `safetyCommitMs`, at deploy (`commit-all`) and on shutdown. `lockStaleMs` keeps its name in the
config and times out a silent live connection, as it already did.

## Rejected

- **Keeping the gate for plain writes** — an upload, a move, a delete. Nobody takes a lock, so the gate never fires;
  concurrent asset operations are last write wins, and refused where they would break a reference (ADR 0161).
