# ADR 0174 — One component per file

Status: accepted.

## Context

The built-in components sat in two files by set: `engine.ts` (five) and `gameplay.ts` (six, the shared rules and
`Death`, with Boss's helpers among them). A component was already self-contained — its parameters and its hooks in
one `defineComponent` — but finding one meant knowing which file its set lived in, and a game's own components were
mixed in with its HUD, rules and balance files. Kodjo expected Unity's shape: one script, one component.

## Decision

- `packages/components/src/` holds one folder per set, one file per component, and an `index.ts` per folder with
  the set's list: `engine/` (`ENGINE_COMPONENTS`), `shared/` (`SHARED_COMPONENTS`, and the by-name lookup that was
  `shared.ts`), `player/` (`PLAYER_COMPONENTS`). A component's private helpers live in its file (Boss's math).
- `GAMEPLAY_COMPONENTS` is renamed `SHARED_COMPONENTS`: it is exactly the set a game opts into by name (ADR 0077),
  and the folder says so.
- A game's own components live in `modes/<game>/src/components/`, one per file. Keyboard's `Keyboard` definition
  moved out of `keycaps.ts`, which keeps the drawing.
- `@mp/components`' public surface is unchanged apart from the rename.

## Rejected

- **A folder per game inside `@mp/components`.** A game's own components are in its own package already; the
  shared package holds what any game can use as is. Boss stays shared (Kodjo): nothing in it is Keyboard's.
