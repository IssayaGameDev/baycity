# ADR 0077 — A game's shared components are data the editor adds to

Status: accepted. Amends ADR 0076. A game's registry is its own code components plus a list of shared
components in `content/games/<game>.json`. When a level needs a shared component the game lacks — a prefab
placed, a component added, or a level opened that already uses one — the editor appends it to that file and
carries on.

## Context

ADR 0076 made the editor refuse a prefab whose components the game's registry lacked, so a level the game
could not load could not be authored. Kodjo's reaction was the right one: placing a trampoline into a game
should **give the game trampolines**, not refuse. The refusal was my design, not a constraint — every shared
component (`Bumper`, `Checkpoint`, `Goal`, `Hazard`, `Track`) ships in every build and works in every game.

Two things stood in the way. The registry was TypeScript, so the editor could not write to it. And a level
that already used the missing component would not open in the editor at all, because it was validated against
the game before opening — the one tool that could fix the file refused the file.

## Decision

### Registry = code + data

Each game's `rules.ts` composes its registry from the engine's components, the player's, its own (`Keyboard`,
`WinsPad`, `Swing`), and `sharedComponents(game.components)`, where `game` is the imported
`content/games/<game>.json`:

```json
{ "components": ["Bumper", "Checkpoint", "Goal", "Hazard", "Track"] }
```

Only shared components may appear there; `sharedComponents` throws on anything else, because a registry
silently missing a type is the failure this ADR exists to end. `Hazard` moved into the data too — it was shared
already, listed in code in every game.

### The editor adopts on demand

The editor reads every game's file live over `/api/games/<name>` at boot and merges it with the game's code
registry, so the working registry is always what is on disk now. Then, at each door:

- **Placing a prefab** that needs a shared component the game lacks: the game's file is appended to, the
  document is rebuilt against the grown registry, the prefab is armed. One status line: `added Bumper to
  Keyboard`.
- **Add Component** (Inspector button and context menu) lists the shared components the game lacks as
  `Bumper (adds to game)`. Picking one adopts, then adds.
- **Opening a level** that already uses a shared component the game lacks adopts it and opens. The level that
  locked Kodjo out opens now.

What still cannot be adopted is another game's **private** component — `Swing` in keyboard — because its code is
not in this game. Those keep ADR 0076's greying and refusal, which is what that ADR was right about.

### The editor does not reload itself

Every game's `rules.ts` imports its data file, and the editor bundles every game (`modes.ts`), so a write to
`content/games` would be a full page reload of the editor — losing undo — right after the editor wrote it. The
editor's Vite ignores that directory and trusts the live `/api/games` list instead. The **game's** dev server
does watch it, and its reload is the one that matters: the game picks up the component it was just given.

## Consequences

- Placing the trampoline in keyboard adds `Bumper` to `content/games/keyboard.json` and works. The game
  reloads with it.
- Each game's data file is committed content, like a level. `git diff` on it says what a game grew.
- Parkour and swing carry `Bumper, Checkpoint, Goal, Hazard, Track`; keyboard and `_template` carry `Hazard`.
  Registries are unchanged in content.
- 3 tests on the lookup, 4 on the editor's type walkers.

## Rejected

**Every game gets every shared component.** Proposed by me, rejected by Kodjo: a game's registry is the game's
list, and it should grow when the game grows, not start full.

**The editor editing `rules.ts`.** Writing TypeScript from a tool is fragile and unreviewable.

**Adopting into the level rather than the game.** A per-level component list would make the same prefab
placeable in one keyboard level and not the next.

## Known open

- **Paste** across games is still unchecked (ADR 0076). The load path now adopts what it can, so the game
  refuses less; a pasted private component is still a load error.
- Nothing removes a shared component from a game's file when its last use is deleted. Hand-edit the JSON.
