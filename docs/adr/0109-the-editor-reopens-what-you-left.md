# ADR 0109 — The editor reopens what you left

Status: accepted. A boot-order detail on top of [ADR 0108](0108-a-game-is-a-folder.md).

## Context

Reloading the editor opened whichever level came first in the listing, so coming back to what you were editing
meant finding it in the tree every time. Kodjo asked for the last one instead.

## Decision

`tools/editor/src/lastOpen.ts`. `openFile` remembers the qualified `<game>/<name>` in `localStorage` after the
open succeeds; `openFirstLevel` prefers it.

**Per browser, not per user on the server.** It is a fact about where this window was looking, not about the
content — and two people sharing a box would fight over one server-side value. Best-effort throughout, like
`packages/game-client/src/persistence.ts`: a blocked or full store falls back to the old behaviour rather than
stopping the editor from booting.

**Remembered only after a successful load**, and only honoured if the name is still in the listing. A level
deleted, renamed, or in a game this build no longer installs would otherwise make the editor boot into a load
error on every reload, and the stale name is the one thing the person cannot see in order to fix it.

## Rejected

- **Store it on the server, per user.** Follows you between machines, at the price of a route, a file and a
  write on every open — for a preference that is wrong the moment you sit at a different desk anyway.
- **Put the level in the editor's URL.** Would make a link to a level shareable, which is worth having, but it
  is a different feature: a URL is a thing you send someone, not a thing that remembers you.
