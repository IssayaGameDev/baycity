# Editor server — `tools/editor-server`

The content API the editor talks to, as one implementation with two hosts (ADR 0083): a Vite middleware in
`pnpm dev:editor` (no login, no git) and a Node server on the box behind Cloudflare Access (`editor.playgorbo.com`,
login, locks, commits on the `content` branch). `@mp/editor-server`, `tsx src/main.ts <config.json>`, no
dependency beyond `@mp/content` (imported by relative path so `vite.config.ts` can bundle it).

| File | Contents |
| --- | --- |
| `src/api.ts` | `createContentApi(opts): ApiHandler` — every route below; `keyFor`, `UPLOAD_EXTENSIONS`, `AuthError`, `safeJoin`, `sendJson` |
| `src/config.ts` | `ServerConfig`, `AuthConfig`, `User`, `parseConfig`, `loadConfig`, `DEFAULTS` |
| `src/access.ts` | `verifyToken` (pure RS256 over a key set), `createAccessVerifier` (fetches `/cdn-cgi/access/certs`, refetches on unknown `kid` at most once a minute) |
| `src/locks.ts` | `LockTable`, `acquire`, `release`, `heartbeat`, `holder`, `blocker`, `heldBy`, `sweep` — pure |
| `src/sessions.ts` | `SessionTable`, `markDirty`, `take`, `takeDue`, `takeAll`, `describeCommit` — pure |
| `src/git.ts` | `git`, `changedUnder`, `commitPaths`, `push`, `currentBranch` |
| `src/changes.ts` | `createChangeFeed(keep)` — numbered, bounded log of written paths with long-poll `wait`; `null` = full sync needed (behind, or ahead after a restart) |
| `src/live.ts` | `createLive(opts): Live` — the open documents (levels **and** prefabs, ADR 0091), their op log, holds, peers, debounced writes (ADR 0089); `docKey`, `LiveError(status)`, `levelPath`, `assetPath` |
| `src/prefabStore.ts` | `createPrefabStore(assetsDir)` — prefab definitions by asset id, off disk: `root`, `pathOf`, `write`; rescans once on an unknown id so a prefab saved seconds ago resolves |
| `src/sse.ts` | `encodeSse(event, data, id?)`, `SSE_HEADERS`, `SSE_KEEPALIVE` |
| `src/proxy.ts` | `proxyHttp`, `proxyUpgrade`, `routeFor` — the staging games and `/relay` under this origin (ADR 0086) |
| `src/server.ts` | `startEditorServer(config)` — identity, static editor, game proxy, timers, commit queue, state files |
| `src/assetOps.ts`, `src/assetImporter.ts` | moved from the editor: folder ops, `.meta` importer |
| `src/main.ts` | CLI; SIGTERM/SIGINT commit every session then exit |

## Routes (`api.ts`)

| Route | Body → reply | Gate |
| --- | --- | --- |
| `GET /api/me` | `{ user, heartbeatMs, lockStaleMs, maxUploadBytes, games }` — `games`: name → URL Play frames | |
| `GET /api/status` | `{ pushError, locks: [{ path, owner, since }] }` (live locks only) | |
| `POST /api/locks/acquire` | `{ path }` → `{ ok }` or `{ ok: false, owner: { name } }` | |
| `POST /api/locks/release` | `{ path }` → `{ ok }`; then `onLockReleased(user)` | |
| `POST /api/locks/heartbeat` | `{ paths }` → `{ lost }` | |
| `GET /api/levels` | `[{ name, mode, prefabs? }]` — `name` qualified `<game>/<name>`, `mode` the **folder** it is in, so a file that will not parse still lists with its game (ADR 0108) | |
| `GET/PUT /api/levels/:game/:name` | level JSON — two segments, because a game is a folder (ADR 0108). GET serves the **live copy** when the level is open; PUT runs `validateLevel(raw)` (structure only, no registry) and makes the game folder on demand, **409** while the level is open live. A name that is not a legal `<game>/<name>` is a 404 | lock |
| `GET /api/live` | `{ docs: [{ name, seq, peers, holds }] }` | |
| `GET /api/live/:kind/:name/events` | `:kind` is `level` or `prefab` (ADR 0091); a level's `:name` is the qualified `<game>/<name>` and so spans two segments (ADR 0108). SSE (`text/event-stream`, `:keepalive` every 25 s): `hello { connId, name }`, `snapshot { level, seq, holds, peers }`, then `ops { seq, from, batchId, ops }` with `id: seq`, `holds`, `peers`, `presence`, `error`, and on a **level's** stream `prefab { assetId, ops }` when a prefab it uses was edited. 404 when there is no such document. The stream closing is the leave | |
| `POST /api/live/:kind/:name/ops` | `{ connId, batchId, ops }` → `{ ok, seq }` · 400 an op does not apply (`OpError`) · 423 `{ error, holder }` a node held by another connection. On a **prefab**, a connection in a level that uses it is accepted too — what *Apply to prefab* needs | |
| `POST /api/live/:kind/:name/hold` | `{ connId, refs }` — **this connection's holds become exactly `refs`** → `{ ok }` / `{ ok: false, holder, refused }` (another's refs named and left out; the rest applies) | |
| `POST /api/live/:kind/:name/release` | `{ connId, refs }` → `{ ok }` | |
| `POST /api/live/:kind/:name/ping` | `{ connId }` — still here | |
| `POST /api/live/:kind/:name/presence` | `{ connId, data }` — relayed to the others, unnumbered | |
| `POST /api/live/:kind/:name/flush` | write the file now (the editor's Play) | |
| `POST /api/live/:kind/:name/leave` | `{ connId }` — a closing tab's beacon | |
| `POST /api/levels/move` | `{ from, to }`, both qualified — rename, or move into another game's folder; the `id` inside follows the file name. **409** while either is open live, 400 on a clash or a bad name, 404 when `from` is not there (ADR 0110) | lock |
| `POST /api/levels/delete` | `{ path }`, qualified — the file goes for good. **409** while it is open live (ADR 0110) | lock |
| `GET /api/games` | `[{ name }]` — the folders at the content root that hold a `game.json` (ADR 0108) | |
| `GET/PUT /api/games/:name` | `{ components: string[] }` — `content/<name>/game.json`; PUT makes the folder, which is how a new game starts | lock |
| `GET /api/assets` | `{ entries, folders }` — runs the importer | |
| `POST /api/assets/mkdir` · `move` · `delete` | `{ path }` · `{ from, to }` · `{ path }` | lock (move/delete; a folder is refused if anything under it is held) |
| `POST /api/assets/upload?path=` | raw bytes → `{ entry }` | lock; ext ∈ `png jpg jpeg webp ktx2 glb`; `≤ maxUploadBytes` else 413 |
| `GET /assets/<path>` | bytes — a prefab open live is served from its document, as a level is | |
| `PUT /assets/<path>` | JSON asset; **409** while that prefab is open live | lock |
| `POST /api/admin/commit-all` | `Authorization: Bearer <stateDir/admin.token>` → commits every session | token, no user |
| `GET /api/tree` | `{ seq, files: [{ path, size, sha1 }] }` — every file under `content/` (mirror, ADR 0084); flushes every live level first, as `GET /api/file` does | |
| `GET /api/changes?since=N&timeout=MS` | `{ seq, paths }` long-poll (≤ 60 s); **410** when N is behind the feed or ahead of it | |
| `GET /api/file?path=content/…` | the bytes; 404 when gone | |

Identity first: `identify(req)` → `null` is 401, `AuthError` is its status (403 signed in but not in `users`, 503
`aud` unset). **Lock gate**: `blocker(locks, key, user)` non-null → 423 `{ error: 'locked by X', owner }`. Lock
keys = repo-relative posix paths, built by `keyFor` from `@mp/content`'s layout (ADR 0108):
`content/<game>/levels/<name>.level.json`, `content/<game>/game.json`,
`content/assets/<path>`. Every write reports its paths to `onChanged` and to the change feed (sidecars included; a PUT of a new JSON
asset rescans so its `.meta` is attributed to the writer; a folder move or delete is reported as the **files** it touched). Upload with the same path **replaces and keeps the
sidecar**, so the id survives. Anything other than `/api/*` and `/assets/*` resolves `false` for the host to serve. The built editor's own files are under `/app/` (`build.assetsDir`), because `/assets/` is this route.

## Locks

`Lock { owner, since, seen }`, one per key. Live = `now − seen < staleMs`. Rules: your own re-acquire refreshes;
a **stale** lock is anyone's; a live one is nobody else's; no force-unlock (everyone equal, Kodjo). Release of
someone else's lock is a no-op `{ ok: false }`. Persisted to `stateDir/locks.json` on every change; swept once a
minute — an owner whose last lock went stale has their session committed.

## Live documents (`live.ts`, ADR 0089, ADR 0091)

```ts
createLive({ readLevel, writeLevel, changed(users, path), onDocClosed?, prefabs?, idleMs = 500, maxMs = 5000, logKeep = 500, schedule?, staleMs? }): Live
// join(key, client) · leave(key, connId) · apply(key, connId, user, { batchId, ops }) → { seq } | throws LiveError
// hold · release · presence · ping · sweep · flush(key) · flushAll() · isOpen · levelOf · status()
docKey(kind, name)   // 'level:<name>' | 'prefab:<assetId>'; a bare name is a level
```

**Two kinds of document** (ADR 0091). A prefab is a `Level` wrapper holding its one root node — the shape a
prefab document has always had in the editor — so every op, hold, log and debounced write applies unchanged.
It loads from `opts.prefabs`, writes back to its own file (`changed` reports `content/assets/…`), and refuses
to contain a placement: `validateNodeTree(root, …, { insidePrefab: true })` runs after every batch, and a
failure **refills that root object** rather than replacing it, because every level holding the prefab holds
that object.

**One object per prefab.** Resolving a level's references (`hydrate`) takes each definition from that prefab's
open document, opening one where there is none, so a prefab edit is in every open level's resolution the
instant it applies. A prefab stays open while any level resolves from it (`dependents`); `close` writes and
forgets a document with neither clients nor dependents.

`hydrate` opens and registers **every** reference, not only the ones whose definition it had to fetch
(ADR 0123). `hydratePrefabs` skips an id the level already carries inline — which `stripHydrated` preserves on
purpose — so such a level used to leave the prefab's document shut, and `apply` on a prefab needs an open one:
*Apply to prefab* answered 404 "is not open" while every visible thing about the placement worked. The inline
definition is neither adopted nor stripped by opening it; a level keeping a frozen copy is a separate defect.

**One delivery path.** After a prefab's batch, every dependent level's clients get `prefab { assetId, ops }` —
no sequence, because the level's own file did not change. A tab is in one document at a time, so nobody gets a
batch twice. `apply` also accepts a connection that is in a level **using** this prefab (`editorOf`), which is
what "Apply to prefab" needs to push a placement's overrides without leaving the level.

One `Doc` per open level: `{ level, seq, log ≤ logKeep, clients: Map<connId, LiveClient>, holds: Map<refKey, hold>,
dirtyBy: Set<email> }`. The first join reads the file (`readLevel` → `validateLevel`), sends `hello` + `snapshot`.
`apply` runs `applyBatch` (in place; an `OpError` is a 400 and nothing changed), refuses an op whose touched ref or
any ancestor is held by another `connId` (423), then `seq++`, logs, broadcasts `ops` to **every** client, the
sender included. Holds go with their connection (leave, stream close) and with the node when it is removed.

**Liveness.** `seen[connId]` is set on join and on every message. `sweep()` leaves every connection silent for
`staleMs` (default two minutes; the box passes `lockStaleMs`) — a tab whose stream died without the server
hearing it, whose holds would otherwise stay. `server.ts` sweeps on its minute timer; the dev plugin every
minute too. The editor pings on its heartbeat.

**Writes.** `idleMs` after the last edit, `maxMs` at most since the first unflushed one, on the last client leaving,
on `flush`/`flushAll` (Play, `/api/tree`, `/api/file`, `commit-all`, shutdown): `level.id = name` →
`writeLevel` → `changed(contributors, content/<game>/levels/<name>.level.json)`. In `server.ts`: `markDirty` per contributor,
then `feed.record([path])` once — disk before the feed, so the mirror always reads the new file. When the last
client leaves, `onDocClosed(contributors)` commits each contributor's session (the level's equivalent of a lock
release). A restart loses at most `maxMs` of edits; clients reconnect and take the fresh snapshot.

The dev editor (`tools/editor/vite.config.ts`) mounts the same `createLive` over the repo's `content/<game>/levels` with
`changed: () => {}`; the watcher ignores `content/<game>/levels/**`.

## Sessions and commits

`Session { user, dirty: Set<path>, since }` per email. Commit points: a lock release (`take(user)`), a live
level closing (`onDocClosed`), a stale sweep, `safetyCommitMs` since the session began (`takeDue`), `commit-all`, shutdown (`takeAll`). Commit =
`git status --porcelain -z -- <paths>` → `git add -A -- <changed>` → `git commit --only -m <describeCommit>` with
`GIT_AUTHOR_*` = the user and `GIT_COMMITTER_*` = `config.git.committer`; unchanged paths mean no commit. Then
`git push origin <branch>` when `push`; a failure sets `pushError` (shown by the editor as "not on GitHub yet"),
cleared by the next good push. **The server never pulls, rebases, merges or forces** — it is the only writer to
its branch; deploy merges master in after `commit-all`. Commits are queued one at a time.

Subjects: `Edit level keyboard` · `Edit texture warn.png` (sidecar folded) · `Edit material goal and 1 more` ·
`Edit the keyboard component list`.

## Config

```ts
interface ServerConfig {
  port: number; repoRoot: string; stateDir: string; editorDist: string   // dist default: <repoRoot>/tools/editor/dist
  auth: { kind: 'none'; user: User } | { kind: 'access'; teamDomain: string; aud: string; users: Record<email, name>; services: Record<clientId, name> }
  git: { branch: string; push: boolean; committer: User } | null
  maxUploadBytes: number; lockStaleMs: number; heartbeatMs: number; safetyCommitMs: number
  games: Record<name, { path: string; target: string; host?: string }>   // ADR 0086; path = the game's Vite base
  relay: string                                                          // default http://127.0.0.1:9200
}
```

| Field | Default | Note |
| --- | --- | --- |
| `port` | 8080 | cloudflared's origin |
| `maxUploadBytes` | 10 MiB | Kodjo's cap; JSON bodies have a fixed 32 MiB limit |
| `lockStaleMs` | 120 000 | |
| `heartbeatMs` | 30 000 | advertised to the editor via `/api/me` |
| `safetyCommitMs` | 600 000 | |
| `auth.aud` | `''` | empty refuses every login and logs the `aud` the token carried, so the tag can be read off the first attempt |
| `auth.users` | | lower-cased email → display name; a verified email not listed is 403 |
| `auth.services` | `{}` | service-token Client ID → display name for logs; any token Access let through is accepted (the Access policy is the list) |

Dev host (`tools/editor/vite.config.ts`): `identify → { local, local@localhost }`, `locks: {}` in memory, rules
from `DEFAULTS`, no git. Same handlers, so the editor's lock code runs against both.

## Access verification

Header `cf-access-jwt-assertion`; RS256; `iss === https://<teamDomain>`, `exp > now`, `aud` includes `config.aud`,
`email` lower-cased. Keys from `https://<teamDomain>/cdn-cgi/access/certs` (`{ keys: Jwk[] }`). The plain
`Cf-Access-Authenticated-User-Email` header is never trusted: cloudflared connects from loopback, so loopback
proves nothing.

A **service token** (the mirror, `content-sync.md`) arrives as a JWT with `common_name` = its Client ID and no
`email`; `verifyToken` returns `{ email: '<id>@service', service: '<id>' }` and the server names it from
`auth.services`.

## Deploy — `deploy/editor/`

| File | Role |
| --- | --- |
| `setup.sh <repo ssh url>` | once, as root: Node 22, pnpm via corepack, user `editor`, deploy key (printed; add with write access), clone to `/srv/editor/repo` on `content` (created from master if absent), install, build, `/etc/editor-server/config.json` from the example, systemd unit, start |
| `update.sh` | `pnpm deploy:editor` pipes it over ssh: `commit-all` → merge `origin/master` into `content` → install → build → reinstall the three units and `systemctl restart` them → push `content` |
| `editor-server.service` | `User=editor`, `tsx tools/editor-server/src/main.ts /etc/editor-server/config.json`, `TimeoutStopSec=45` |
| `mp-relay.service`, `mp-game-keyboard.service` | the staging game (below) |
| `editor-server.config.example.json` | team `cold-boat-3e59`, branch `content`, 10 MiB |
| `migrate-primitives.sh`, `migrate-prefab-refs.sh`, `migrate-motion.sh`, `migrate-layout.sh` | one-off content migrations (ADR 0090, ADR 0091, ADR 0103, ADR 0108). Dry by default; `-- --write` stops the editor server, runs, commits on `content` and pushes. A refusal exits non-zero. Never steps in `update.sh`: a one-off does not belong in what runs every deploy |

Box: Hetzner CX23 (2 vCPU, 4 GB) `2.28.227.20`, Ubuntu 26.04; cloudflared installed by the dashboard's tunnel
command, `editor.playgorbo.com → localhost:8080`; Access application `Editor` with two policies: `Team` (Allow,
emails, One-time PIN login) and `Sync` (Service Auth, the `content-sync` service token, `content-sync.md`).
Dashboard names as of setup: Cloudflare One → *Access controls* (applications, service credentials),
*Integrations → Identity providers* (One-time PIN). Nothing listens publicly. State in `/var/lib/editor-server/`.

## Staging game — `dev.playgorbo.com` (ADR 0085)

| Unit | Runs | Port |
| --- | --- | --- |
| `mp-relay.service` | `tsx packages/server/src/main.ts` | 9200 |
| `mp-game-keyboard.service` | `vite --host 127.0.0.1 --port 5177 --strictPort` in `modes/keyboard` — the **dev server**; with `MP_BASE` set it does **not** watch `content/<game>/levels/**` and proxies `/api` → `:8080`, and the page reads its level at boot from `GET /api/levels/<game>/<name>` (`pickLevel`, ADR 0089), so a save never reloads a player | 5177 |

The game runs with `MP_BASE=/play/keyboard/` and is reached **through this server** at
`editor.playgorbo.com/play/keyboard/` (ADR 0086): every request under a configured `games[].path` is proxied
to its `target` (HTTP and upgrade), `/relay` upgrades go to `config.relay`, and a request whose `Host` is a
game's `host` (`dev.playgorbo.com`) is redirected to its path, query kept. The editor's Play frames that URL
(`editor.md`). Tunnel hostname `dev.playgorbo.com → http://localhost:5177` still works too: Vite redirects its
root to the base. Both units are installed by `setup.sh` and restarted by `update.sh`. Keyboard only; another
game is another unit, a `games` entry and a hostname.

## Open

- `content/<game>/game.json` writes are lock-gated but never locked by the editor: two adoptions in the same
  second could drop one. Append-only set; the merge story is the rule that only the editor writes it (ADR 0083).
- Contributors' names come from `auth.users`, edited by hand on the box.
- No merge driver for `games.json`; ADR 0083 records the option.
