# ADR 0089 — A level is edited live

Status: accepted, implemented in four phases (one commit each); each phase has its section here.

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

## Phase 2 — the live session

**Decision.** The server holds every open level (`tools/editor-server/src/live.ts`): a client joins over a
server-sent-events stream (`GET /api/live/:name/events`), gets `hello` + a snapshot, and POSTs each batch its
document reported (`/api/live/:name/ops`). The server applies with the shared `applyBatch`, numbers the batch and
broadcasts it to everyone, the sender included — the echo is the acknowledgement. The file is written on a debounce
(500 ms idle, 5 s max) and on Play, `/api/tree`, `/api/file`, the last leave, `commit-all` and shutdown; the write
feeds each contributor's session and the mirror once. The editor (`tools/editor/src/collab.ts`) applies its own
edits at once and keeps them *unacked* until the echo; a remote batch is applied under them (roll back, apply,
re-apply); a refusal rolls the batch back and drops its history entry; a sequence gap reopens the stream for a
fresh snapshot. Save is gone for levels; Play flushes first; New asks for a name and creates at once; Duplicate
copies the server's current copy.

**Why SSE + POST, not WebSocket.** No new dependency is allowed and a hand-rolled RFC 6455 server would share the
`upgrade` listener with the game proxy and Vite's HMR in dev. SSE is plain HTTP: the existing middleware, the
Access cookie and the tunnel carry it unchanged, `EventSource` reconnects on its own, and the batch rate (an op
when an edit ends, 10 Hz presence later) is nothing for POSTs. The transport is an interface, so the core is
tested with a fake one and could move to a socket without touching it.

**Why the sender gets its own echo.** One ordering for every copy, and one code path: the ack is "the server
placed my batch at seq N", the same message the others act on. A client that missed a number knows it and asks
for a snapshot instead of guessing.

**Why write on a debounce, not per op.** The file is the mirror's and the game's view, not the source of truth
while the level is open; a write per drag end would be a git-visible churn and a `sync:content` storm. Every
reader that needs the file current (`/api/tree`, Play) flushes first, so the debounce is invisible to them.

**Rejected.** A file lock plus periodic autosave (the stale-save problem this ADR exists for). Client-side
persistence of unacked ops across reloads (the server has them within 5 s; a reload takes the snapshot). Server-
minted ids (the client's op must apply locally before the round trip).

**Consequences.** `PUT /api/levels/:name` is refused while the level is open (409); `GET` serves the live copy.
A level's session commit happens when its last editor leaves, not on a lock release. The name field is read-only
for levels: the name is the room. `window.prompt` for New is gone. Holds and presence travel on the same stream
and land in phases 3 and 4.

## Phase 3 — holds follow the selection

**Decision.** Selecting a node holds it for this connection (`/api/live/:name/hold`); deselecting releases it.
The server refuses any other connection's op on a held node or anything under it (423), and drops a hold with
its connection, on release, and when the node is removed. The editor filters held nodes out of every selection,
so the gizmo never lands on one; the Hierarchy row carries the holder's name as its badge and is dimmed; the
viewport draws a box in the holder's colour over the node, refreshed each frame so a drag shows through.

**Why a hold covers the subtree.** A move of the parent moves the held child; a removal takes it. Refusing at
the ancestor is the only way "mine while selected" holds for a node inside a group someone else grabbed.

**Why refuse at the server too.** The client's filter runs on the holds it last heard; two people selecting the
same node inside one round trip both think it free. The server is the arbiter: the loser's hold is refused and
its selection drops the node; an op that raced ahead is a 423 and rolled back like any refusal.

**Rejected.** A floating name label in the viewport (Kodjo: name in the Hierarchy, tint in the viewport).
Force-take (everyone equal; no owner). Holding on hover or on pointer-down alone (a hold that outlives the
gesture by a frame is not a claim anyone can see).

**Consequences.** Two tabs of one person block each other, as two people would. Renaming and dragging a held
row are off with selection. A reconnect is a new connection, so the editor re-holds its selection on the fresh
snapshot.

### Amendment — holds are a set, and a connection has to stay alive

In use, a level showed three nodes held by someone who had nothing selected. Two ways there: a `hold` and its
`release` sent as separate POSTs could arrive in the other order, leaving a hold for nothing; and a stream that
died without the server hearing it (a sleeping laptop, a tunnel hop) kept its connection, holds included,
forever. Now `hold` carries the connection's whole set — "mine are exactly these", so any message, in any
order, ends in the right state — and is queued client-side one behind another; every message marks the
connection seen, the editor pings on its heartbeat, and a minute sweep leaves anyone silent for two minutes,
the lock rule. A reconnecting editor also says goodbye for its dead connection as soon as it hears its new id.

## Phase 4 — presence: a drag is streamed, not written

**Decision.** While a gizmo drags, the editor streams the poses of what it drags at 10 Hz on the presence
channel (`/api/live/:name/presence`, relayed to the others, unnumbered, never stored); peers pose their groups
from it and write nothing. The transform batches the document reports mid-drag are held back and go as **one**
op batch when the drag ends — the same ops the history entry holds. Others' selection needs no channel of its
own: a selection is a hold, and holds are already drawn.

**Why not stream the ops.** Before this, a drag was a POST and a `seq` per pointer event: a hundred numbered ops
for one gesture, each one a line in the bounded log that a reconnecting client replays, and a hundred inverses
for one undo. A pose is a picture, an op is a change; the room needs the picture often and the change once.

**Why the groups' poses, not the document's.** With a key selected the gizmo writes a keyframe, and the
document's transform does not move; the group does. What the peer should see is what the dragger sees.

**Rejected.** A `select` presence message (redundant with holds). Streaming at pointer rate (bandwidth for
nothing the eye can use). Keeping presence server-side for late joiners (a joiner sees the op within a second).

**Consequences.** A drag returned to its start sends no op; the `end` message puts peers' groups back on their
data. Undo of a drag is one entry, as before. The op log grows by one per drag, not per pointer event.
