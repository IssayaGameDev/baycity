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
| `src/live.ts` | `createLive(opts): Live` — the open levels, their op log, holds, peers, debounced writes (ADR 0089); `LiveError(status)`; `levelPath` |
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
| `GET /api/levels` | `[{ name, mode? }]` | |
| `GET/PUT /api/levels/:name` | level JSON — GET serves the **live copy** when the level is open; PUT runs `validateLevel(raw)` (structure only, no registry), **409** while the level is open live | lock |
| `GET /api/live` | `{ docs: [{ name, seq, peers, holds }] }` | |
| `GET /api/live/:name/events` | SSE (`text/event-stream`, `:keepalive` every 25 s): `hello { connId, name }`, `snapshot { level, seq, holds, peers }`, then `ops { seq, from, batchId, ops }` with `id: seq`, `holds`, `peers`, `presence`, `error`. 404 when there is no such level. The stream closing is the leave | |
| `POST /api/live/:name/ops` | `{ connId, batchId, ops }` → `{ ok, seq }` · 400 an op does not apply (`OpError`) · 423 `{ error, holder }` a node held by another connection | |
| `POST /api/live/:name/hold` · `release` | `{ connId, refs }` → `{ ok }` / `{ ok: false, holder }` | |
| `POST /api/live/:name/presence` | `{ connId, data }` — relayed to the others, unnumbered | |
| `POST /api/live/:name/flush` | write the file now (the editor's Play) | |
| `POST /api/live/:name/leave` | `{ connId }` — a closing tab's beacon | |
| `GET/PUT /api/games/:name` | `{ components: string[] }` | lock |
| `GET /api/assets` | `{ entries, folders }` — runs the importer | |
| `POST /api/assets/mkdir` · `move` · `delete` | `{ path }` · `{ from, to }` · `{ path }` | lock (move/delete; a folder is refused if anything under it is held) |
| `POST /api/assets/upload?path=` | raw bytes → `{ entry }` | lock; ext ∈ `png jpg jpeg webp ktx2 glb`; `≤ maxUploadBytes` else 413 |
| `GET /assets/<path>` | bytes | |
| `PUT /assets/<path>` | JSON asset | lock |
| `POST /api/admin/commit-all` | `Authorization: Bearer <stateDir/admin.token>` → commits every session | token, no user |
| `GET /api/tree` | `{ seq, files: [{ path, size, sha1 }] }` — every file under `content/` (mirror, ADR 0084); flushes every live level first, as `GET /api/file` does | |
| `GET /api/changes?since=N&timeout=MS` | `{ seq, paths }` long-poll (≤ 60 s); **410** when N is behind the feed or ahead of it | |
| `GET /api/file?path=content/…` | the bytes; 404 when gone | |

Identity first: `identify(req)` → `null` is 401, `AuthError` is its status (403 signed in but not in `users`, 503
`aud` unset). **Lock gate**: `blocker(locks, key, user)` non-null → 423 `{ error: 'locked by X', owner }`. Lock
keys = repo-relative posix paths: `content/levels/<name>.json`, `content/games/<name>.json`,
`content/assets/<path>`. Every write reports its paths to `onChanged` and to the change feed (sidecars included; a PUT of a new JSON
asset rescans so its `.meta` is attributed to the writer; a folder move or delete is reported as the **files** it touched). Upload with the same path **replaces and keeps the
sidecar**, so the id survives. Anything other than `/api/*` and `/assets/*` resolves `false` for the host to serve. The built editor's own files are under `/app/` (`build.assetsDir`), because `/assets/` is this route.

## Locks

`Lock { owner, since, seen }`, one per key. Live = `now − seen < staleMs`. Rules: your own re-acquire refreshes;
a **stale** lock is anyone's; a live one is nobody else's; no force-unlock (everyone equal, Kodjo). Release of
someone else's lock is a no-op `{ ok: false }`. Persisted to `stateDir/locks.json` on every change; swept once a
minute — an owner whose last lock went stale has their session committed.

## Live documents (`live.ts`, ADR 0089)

```ts
createLive({ readLevel, writeLevel, changed(users, path), onDocClosed?(users), idleMs = 500, maxMs = 5000, logKeep = 500, schedule? }): Live
// join(name, client) · leave(name, connId) · apply(name, connId, user, { batchId, ops }) → { seq, ops } | throws LiveError
// hold · release · presence · flush(name) · flushAll() · isOpen · levelOf · status()
```

One `Doc` per open level: `{ level, seq, log ≤ logKeep, clients: Map<connId, LiveClient>, holds: Map<refKey, hold>,
dirtyBy: Set<email> }`. The first join reads the file (`readLevel` → `validateLevel`), sends `hello` + `snapshot`.
`apply` runs `applyBatch` (in place; an `OpError` is a 400 and nothing changed), refuses an op whose touched ref or
any ancestor is held by another `connId` (423), then `seq++`, logs, broadcasts `ops` to **every** client, the
sender included. Holds go with their connection (leave, stream close) and with the node when it is removed.

**Writes.** `idleMs` after the last edit, `maxMs` at most since the first unflushed one, on the last client leaving,
on `flush`/`flushAll` (Play, `/api/tree`, `/api/file`, `commit-all`, shutdown): `level.id = name` →
`writeLevel` → `changed(contributors, content/levels/<name>.json)`. In `server.ts`: `markDirty` per contributor,
then `feed.record([path])` once — disk before the feed, so the mirror always reads the new file. When the last
client leaves, `onDocClosed(contributors)` commits each contributor's session (the level's equivalent of a lock
release). A restart loses at most `maxMs` of edits; clients reconnect and take the fresh snapshot.

The dev editor (`tools/editor/vite.config.ts`) mounts the same `createLive` over the repo's `content/levels` with
`changed: () => {}`; the watcher ignores `content/levels/**`.

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

Box: Hetzner CX23 (2 vCPU, 4 GB) `2.28.227.20`, Ubuntu 26.04; cloudflared installed by the dashboard's tunnel
command, `editor.playgorbo.com → localhost:8080`; Access application `Editor` with two policies: `Team` (Allow,
emails, One-time PIN login) and `Sync` (Service Auth, the `content-sync` service token, `content-sync.md`).
Dashboard names as of setup: Cloudflare One → *Access controls* (applications, service credentials),
*Integrations → Identity providers* (One-time PIN). Nothing listens publicly. State in `/var/lib/editor-server/`.

## Staging game — `dev.playgorbo.com` (ADR 0085)

| Unit | Runs | Port |
| --- | --- | --- |
| `mp-relay.service` | `tsx packages/server/src/main.ts` | 9200 |
| `mp-game-keyboard.service` | `vite --host 127.0.0.1 --port 5177 --strictPort` in `modes/keyboard` — the **dev server**; with `MP_BASE` set it does **not** watch `content/levels/**` and proxies `/api` → `:8080`, and the page reads its level at boot from `GET /api/levels/<name>` (`pickLevel`, ADR 0089), so a save never reloads a player | 5177 |

The game runs with `MP_BASE=/play/keyboard/` and is reached **through this server** at
`editor.playgorbo.com/play/keyboard/` (ADR 0086): every request under a configured `games[].path` is proxied
to its `target` (HTTP and upgrade), `/relay` upgrades go to `config.relay`, and a request whose `Host` is a
game's `host` (`dev.playgorbo.com`) is redirected to its path, query kept. The editor's Play frames that URL
(`editor.md`). Tunnel hostname `dev.playgorbo.com → http://localhost:5177` still works too: Vite redirects its
root to the base. Both units are installed by `setup.sh` and restarted by `update.sh`. Keyboard only; another
game is another unit, a `games` entry and a hostname.

## Open

- `content/games/<game>.json` writes are lock-gated but never locked by the editor: two adoptions in the same
  second could drop one. Append-only set; the merge story is the rule that only the editor writes it (ADR 0083).
- Contributors' names come from `auth.users`, edited by hand on the box.
- No merge driver for `games.json`; ADR 0083 records the option.
