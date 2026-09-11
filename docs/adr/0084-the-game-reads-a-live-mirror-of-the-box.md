# ADR 0084 — The game reads a live mirror of the box

Status: accepted. `pnpm sync:content` mirrors the hosted editor's `content/` into `.content-live/` on Kodjo's
PC in near real time; the browser apps bundle content through an `@content` alias that points at the mirror
when `.env` says so. Tests and the dev editor keep the repo's `content/`.

## Context

ADR 0083 moved authoring to `editor.playgorbo.com`. Kodjo's loop was `pnpm dev:editor` + `pnpm dev:keyboard`:
save in the editor, the game reloads at once. The games bundle `content/` from disk with `import.meta.glob`;
the hosted editor writes to the box's disk, committing per session on `content`. His save now reached his
game only after a commit, a push and a pull — minutes, and only when a lock was released. "This is not good
enough."

## Options

- **Pull `content` in a loop.** Latency is the commit granularity, which is per session. Dead on arrival.
- **Games fetch content from the box at runtime.** Changes how the game loads content for production too, and
  a browser tab cannot carry an Access login for another origin. Large.
- **Mirror the box's files onto the PC, live.** The server already knows every write's paths. A long-poll feed
  plus a file route, a small tool, and the games read the mirror. Chosen.

## Decisions (Kodjo's)

- **The mirror is a separate folder**, `.content-live/`, git-ignored, and the games read it through an alias.
  Writing straight into `content/` would keep his master tree permanently dirty with files that are not his,
  make every merge of `content` need a reset first, and force the agent's commits to dodge the folder.
- **He edits in the browser tab.** The dev editor on `content/` stays for editor development.
- **A service token**, not an email code, logs the tool in. Created once in Cloudflare One, kept in `.env`.

## Details that mattered

- **Folder moves and deletes are fed as files.** A mirror cannot act on "the folder moved".
- **A client ahead of the feed gets a full sync.** The server's sequence restarts at 0 on every restart; a
  mirror polling with yesterday's number would otherwise wait forever and never see another change.
- **Tests read master's `content/`** whatever `.env` says: `levels.test.ts` validates what will be merged, not
  what a friend is mid-editing. Per vitest project, because a project inherits none of the root's `resolve`.
- **The banner.** Not running the sync means a stale mirror and nothing else says so; each dev server logs
  which root it bundles and how old the mirror's stamp is.
- The tool refuses to mirror into the repo's own `content/`.

## Consequences

- Kodjo's routine: `pnpm dev:server`, `pnpm dev:keyboard`, `pnpm sync:content`; edit at
  `editor.playgorbo.com`; merge `content` into master when good; the agent redeploys after code changes.
- `content/` on master is merged, never edited, while the hosted editor is in use. CLAUDE.md says so.
- A `.env` on his PC holds the service token. Its expiry is the one silent failure; the tool shouts, the game
  does not.
