# ADR 0086 — Play in the editor is the real game

Status: accepted. The editor's Play button, on a level, saves and then shows the **actual game page** in a
frame over the viewport: HUD, progression, other players, on the level being edited. Stop returns to editing.
On a prefab, Play is still the editor's own rules-only loop.

## Context

The editor's Play ran the game's rules and components inside the editor: no HUD, no XP, no relay. The
content people could not test what they built as the game (ADR 0085 gave them `dev.playgorbo.com`, but not
"play *this* level from here"). Kodjo: reuse the Play button, and have it play the game "with everything not
stripped down".

## Options

- **Run the game in-process in the editor.** Cleaner, but a game is a page, not a function; its level and
  asset loading is bundled at build time, so a hosted editor would play the content of the last deploy; two
  engines in one page. A refactor across `game-client`, `tps` and every game.
- **Frame the game page.** The staging game is a Vite dev server on the box watching the files the editor
  writes. Zero refactor, always current, exact parity with what the collaborators play. Chosen; in-process
  stays the possible upgrade and nothing here blocks it.

## Decision

- **Same origin.** The editor server reverse-proxies each staging game under its own origin
  (`/play/keyboard/` → `127.0.0.1:5177`) and `/relay` to the relay, HTTP and WebSocket
  (`tools/editor-server/src/proxy.ts`, `node:http` + `node:net`, no dependency). A cross-origin frame to
  `dev.playgorbo.com` would depend on third-party cookies for the Access login; same-origin does not.
- **The game's `base` is the path.** `MP_BASE=/play/keyboard/` on the box (`base: process.env.MP_BASE ?? '/'`
  in the game's Vite config); locally `/`. Vite prefixes every module URL, so the proxy forwards paths unchanged.
- **The server tells the editor where games play** (`/api/me` → `games`): hosted, the proxied path; the dev
  editor, `http://localhost:<port>/` from `SHARED_GAMES` — `pnpm dev:<game>` must be running.
- **Save first.** The page reads the file. A refused save (read-only, locked) means no play.
- **Stop is the toolbar button.** Esc inside the frame is the game's pause. The editor's pointer-lock exit no
  longer ends a framed play.
- `dev.playgorbo.com` keeps working: a `host` on the game's config redirects its root to the game path.

## Consequences

- `config.games` and `config.relay` in the editor server; `mp-game-keyboard.service` sets `MP_BASE`.
- Prefabs keep the old in-editor Play: they have no level to load.
- The pause-menu level picker is not built; the open level is the one that plays.
