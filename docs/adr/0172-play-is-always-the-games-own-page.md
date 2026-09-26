# ADR 0172 — Play is always the game's own page

Status: accepted. Amends ADR 0086 (play in place as the fallback) and ADR 0052's play-in-place running a game's rules.

## Context

The editor's Play had two paths: the real game in a frame (ADR 0086), for a game the server hosts a page for, and
**play in place** for anything else — the editor's own scene running the game's rules, locomotion, player components,
actions and camera through a second loop. It was a copy of each game inside the editor, and it drifted until it no
longer worked; only games with no hosted page reached it. With Parkour and Swing gone (ADR 0171), every game the
stack has is hosted, and the frame is the only path anyone uses.

Kodjo: remove it.

## Decision

- Play is the game's page in a frame, and nothing else. `play.ts` owns the frame; `PlayHost` shrank from 23 getters to
  13. A level with no page — a prefab, a game not in the editor, a game the server hosts no page for — is refused
  with a toast saying which.
- Remote edits are no longer held back while playing: the frame's game has its own world, so repainting the editor's
  behind it disturbs nothing.
- Keyboard's descriptor loses the editor-only `playerDefs` (a Stepper bound to a bundled curve with nowhere to
  report); the client binds its own. The editor drops `@mp/camera`, `@mp/client` and `@mp/humanoid`.

## Rejected

- **Rebuilding play in place to outdo the frame.** A second copy of every game drifts every time a game changes;
  that is what broke this one.
- **Keeping it for prefabs.** A prefab alone has no rules, spawn or game around it; the level it is placed in is
  where it plays.
