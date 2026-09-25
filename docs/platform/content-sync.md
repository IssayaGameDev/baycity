# Content sync — `tools/content-sync` and `content-root.ts`

The hosted editor writes to the box's disk; the browser apps bundle `content/` from **this** disk at dev time
(`virtual:game-content`, below, and a few direct imports). `pnpm sync:content` bridges the two: a live, one-way mirror of the box's `content/` into
`.content-live/`, and `content-root.ts` points every dev server at it (ADR 0084). Save on
`editor.playgorbo.com`, the local game reloads within a second.

## `content-root.ts` (repo root)

```ts
export const REPO_ROOT: string            // fileURLToPath(new URL('.', import.meta.url))
export const REPO_CONTENT: string         // <repo>/content
export const contentRoot = (): string     // $MP_CONTENT_ROOT (resolved against the repo) if it exists, else REPO_CONTENT with a warning
export const contentAlias = (root = contentRoot()): Record<string, string>   // { '@content': root }
export const contentBanner = (root = contentRoot()): Plugin                  // logs "content: <root> (live mirror, synced 12s ago)"
```

Loads the root `.env` (`process.loadEnvFile`) on import. Imported by **relative path** from each `vite.config.ts`
(a root file, not a package; Vite bundles it into the config).

| Consumer | Alias root |
| --- | --- |
| `modes/*/vite.config.ts`, `tools/viewer/vite.config.ts` | `contentAlias()` + `contentBanner()` — the mirror when configured |
| `tools/editor/vite.config.ts` | `contentAlias(REPO_CONTENT)` — the dev editor edits the repo's folder, never the mirror |
| `vitest.config.ts` (per project) | `contentAlias(REPO_CONTENT)` + `gameContent(null, REPO_CONTENT)` — tests validate master's content, all of it, whatever `.env` says |
| `tsconfig.base.json` | `paths: { "@content/*": ["./content/*"] }` for typecheck |

Every content import is `@content/...`: `virtual:game-content` for `packages/game-client/src/{levels,assets}.ts`,
`modes/*/src/rules.ts` (`@content/<game>/game.json`), `tools/viewer/src/registry.ts`.

## `game-content.ts` (repo root, ADR 0161)

```ts
gameContent(game: string | null, root = contentRoot())       // the Vite plugin: `virtual:game-content`
gameContentFiles(root, game, 'library' | 'used'): { levels, assets }   // paths from content/
gameContentModule(files): string                              // one @content import per file; LEVELS METAS MATERIALS PREFABS URLS
```

Each game's `vite.config.ts` passes its name. A game carries **its own levels** and assets from **its own library and
Shared's**, never another game's. Served (`vite`, the staging game on the box): the whole of both libraries, since a
page reads its level live at boot (ADR 0089) and may use an asset placed seconds ago; a file added to or removed from
a library or the levels folder rebuilds the module and reloads the page, unless `watch.ignored` covers it. Built
(`vite build`): only what its levels and `game.json` use (`usage.ts`) plus `CODE_ASSETS`. `null` (the tests): every
library, every game's levels. Keyboard today: its own levels are 872 KB of the 986 KB of all games', so a build is
~46 KB smaller for leaving the others out; the build is 4.8 MB, 3.8 MB of it code and 0.86 MB the sky.

## `pnpm sync:content` — `tools/content-sync/src/main.ts`

| Step | Route | Behaviour |
| --- | --- | --- |
| full sync | `GET /api/tree` | `planSync(remote, local)`: download differing/missing by sha1, delete what the server lacks |
| loop | `GET /api/changes?since=<seq>&timeout=25000` | long-poll; each path → `GET /api/file?path=` → write, or delete on 404 |
| 410 | | fell behind, or the server restarted (its `seq` restarts at 0) → full sync |
| error | | log, back off 2 s … 30 s, full sync every fifth failure; 401/403 named as an expired or unlisted service token |
| stamp | | `.content-live/.sync.json` `{ at, seq, url }` after every step; `contentBanner` reads `at` |

Auth: Cloudflare Access **service token** headers `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every
request; Access turns them into a JWT with `common_name`, which the server accepts (`editor-server.md`). Never an
email code. Refuses to run when the mirror resolves to the repo's own `content/` (`isRepoContent`).

Pure parts (`src/index.ts`, tested): `planSync`, `readEnv`, `isRepoContent`.

## `.env` (root, git-ignored; `.env.example` is the template)

| Variable | Meaning |
| --- | --- |
| `MP_EDITOR_URL` | `https://editor.playgorbo.com` |
| `MP_ACCESS_CLIENT_ID`, `MP_ACCESS_CLIENT_SECRET` | the service token (Cloudflare One → Access controls → Service credentials); the Editor application needs a **Service Auth** policy including it |
| `MP_CONTENT_ROOT` | mirror folder, relative to the repo; default `.content-live`; unset = the repo's `content/` |

## Rules

- `.content-live/` is a mirror. Never edited by hand, never committed (`.gitignore`).
- The repo's `content/` on master changes only by merging the `content` branch. Nobody edits it locally while
  the hosted editor is in use; the dev editor on it is for editor development.
- Not running the sync = the game bundles a stale mirror. The banner is the only tell.
