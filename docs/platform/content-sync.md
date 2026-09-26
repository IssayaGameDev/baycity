# Content sync — `tools/content-sync` and `content-root.ts`

The hosted editor writes to the box's disk; the browser apps read `content/` from **this** disk at dev time (a game
page through its dev server, `game-content.ts` below; a few direct imports). `pnpm sync:content` bridges the two: a live, one-way mirror of the box's `content/` into
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
| `vitest.config.ts` (per project) | `contentAlias(REPO_CONTENT)` — tests validate master's content, whatever `.env` says; the ones reading a game's levels use `diskContent(REPO_CONTENT, game)` |
| `tsconfig.base.json` | `paths: { "@content/*": ["./content/*"] }` for typecheck |

Every content import is `@content/...`: `modes/*/src/rules.ts` (`@content/<game>/game.json`),
`tools/viewer/src/registry.ts`. A game's levels and assets are never imported: the page fetches them (ADR 0169).

## `game-content.ts` (repo root, ADR 0169)

```ts
gameContent(game: string, opts?: { root?: string; live?: string })   // the Vite plugin; root defaults to contentRoot()
diskContent(root, game): DiskContent          // index(), level(name), needs(name, urlOf), assets(), catalog() — read fresh each call
diskResponse(root, game, rel): { type, body } | null   // what the local dev server answers for content/<rel>
```

A game page reads one level at a time, with only what it uses (`loadLevel`, `client/services.md`), at addresses
relative to itself: `content/<game>/levels.json`, `content/<game>/levels/<name>.needs.json`, then each list entry's
`url` (`@mp/content` `levelNeeds.ts`: `levelIndexOf`, `levelNeeds` over `usage.ts`, `mayUse` — the game's own library
and Shared's only — plus `CODE_ASSETS`). The plugin answers them wherever Vite runs:

| Where | What answers | Reload on a content edit |
| --- | --- | --- |
| `vite build` | files: `buildStart` writes every level and every file some level uses (`assets/<name>-<hash>`); `generateBundle` writes `content/<game>/levels.json` and each level's list, its `url`s the hashed files. No server of ours needed | — |
| `vite`, local | middleware on `<base>content/`: `diskResponse` from `root` — the index, lists (`url` = `content/<path>`), level files, library files; 404 for anything else, another game's included; `cache-control: no-cache` | every add, change or unlink under Shared's library, the game's library or its levels folder: full reload (ADR 0084's loop) |
| `vite`, the box (`live`, set when `MP_BASE` is) | a proxy: `<base>content/*` → `<live>/api/play/*`, `changeOrigin` (the editor server redirects `dev.playgorbo.com` hosts outside the game path) — live copies, `editor-server.md` | none: nothing of `content/` is in the module graph |

A level file that will not parse fails the build. Nothing of `content/` is in a game's code; `game.json` still is,
through `rules.ts`, so editing it on the box reloads open pages.

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
- Not running the sync = the game plays a stale mirror. The banner is the only tell.
