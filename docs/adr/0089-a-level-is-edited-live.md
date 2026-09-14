# ADR 0089 — A level is edited live

Status: accepted, in progress. Phases land as separate commits; each phase adds its section here.

## Context

Three people author content on the hosted editor (ADR 0083). A level was locked per file while open: one
person per level. Kodjo rejected "lock per object, save later" — a stale save overwrites a colleague — and chose
**live editing**: every edit is an operation applied the moment it ends and seen by every open editor within a
fraction of a second; a node is held while selected; undo is per person, as inverse operations; no Save for
levels. Prefabs and materials keep the per-file lock.

Decisions taken up front (Kodjo's): hold while selected; held nodes tinted in the viewport with the holder's
name on the Hierarchy row; Save removed for levels; undo puts a node back where *I* had it even if someone moved
it since; New asks for a name and creates at once, plus Duplicate; phase 2 is drag streaming and others'
selection.

## Phase 0 — the game reads its level at boot

**Problem.** The staging game (`dev.playgorbo.com`, the editor's Play frame; ADR 0085/0086) is the game's Vite
dev server, which bundles `content/levels/*.json` and full-reloads every open page when one changes. Today that
is once per Save; under live editing it is once every few seconds. Anyone playtesting while anyone else edits
would reload forever. Kodjo: fix this first.

**Decision.** A page served under a base path (the box) reads its level **over HTTP at boot** —
`pickLevel(levels, requested, fetchLevel)` in `@mp/game-client`, `GET /api/levels/<name>` on the page's origin —
and the staging Vite stops watching level files (`server.watch.ignored` when `MP_BASE` is set) and proxies
`/api` to the editor server for `dev.playgorbo.com`. The page plays the level as it was when it loaded; the
editor's Play frame is created fresh on every Play, after a flush, so it is always current; a player on
`dev.playgorbo.com` reloads by hand for the newest.

The bundle stays: it is the fallback when there is no server, when the live copy fails validation (a component
the deployed game does not know yet) or belongs to another game, and it is the whole story locally and in a
production build. Locally the base is `/`, so the mirror's writes still reload the game — that is the loop
Kodjo wants on his PC (ADR 0084). A level created in the editor after the build loads live even though it is
not bundled.

**Rejected.** Turning off the watcher alone: the eager glob would serve the build-time copy forever. Vite HMR
accept handlers for JSON: the level is consumed at boot, there is nothing to hot-swap into. A build per save:
seconds of CPU per edit for what a fetch does.

## Phase 1 — edits are ops, undo is inverse ops

**Decision.** `packages/content/src/ops.ts`: a discriminated union of every edit the editor makes, with
`invertOp` computed against the state before applying and `applyOp`/`applyBatch` as the one implementation every
copy runs. Nodes are addressed by id — `{ id }`, `{ table, id }` for a prefab table entry, `{ owner, node }` for a
prefab-side node seen through a placement — never by index. Ids and table keys are minted client-side and carried.
The editor's `Doc` keeps its index-based API; every mutator now builds ops and commits them, reporting
`{ ops, inverses }` on `onOps`. `opHistory.ts` replaces the snapshot history: an entry is one edit's ops and
inverses; undo applies the inverses as an ordinary edit.

**Why keep the `Doc` API.** Forty call sites in the panels address nodes by index and the document's policy
(prefab-mode refusals, registry-driven `canAdd`, `reidSubtree`) is UI policy. The network needs ops, not a new
document model.

**Why inverse ops, not snapshots.** A snapshot cannot belong to one person: putting back "the document as it
was" puts back a colleague's work with it (ADR 0030's design assumed one author).

**Rejected.** Replacing `Doc` with an op-first model (a rewrite with no gain). Diffing the document to derive
ops (`recordEdit` had only a post-hoc notification; the mutator knows what it did). Snapshot undo scoped by
author (impossible to compute).

**Consequences.** Undo inside a prefab opened on top stays there. A gizmo drag is one op. `history.ts` is gone.
The `Doc` still applies edits locally and immediately; phase 2 sends the same batches to the server.
