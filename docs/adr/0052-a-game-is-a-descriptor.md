# ADR 0052 — A game is a descriptor the tools take as an argument

Status: accepted. Makes dependency law 3 ("needing to modify `packages/` for a mode is a stack gap") true of
the editor, which was the one place it was not.

## Context

The stack is meant to host several games — "an extremely simplified Roblox" — sharing one character controller,
one renderer, one netcode and one level editor. Everything below the editor was already mode-agnostic: the
loader reads only engine components and hands a mode every component on the node you touched, components own
their own `onContact`, and the editor imports no game.

The editor was not. An audit found twelve places where it answered a question only a game can answer:

- **`DEFAULT_REGISTRY` hardcoded at 11 sites**, so a game's own components could never appear in the Add
  Component menu without editing `packages/components`.
- **Play-in-place implemented parkour's rules**: it imported `Checkpoint` by name, built an ordered checkpoint
  list, and defined progress as "later index wins".
- **Death was parkour's death**, and *wrong*: `killed || p.y < fallY`, ignoring `fallBehavior`. A
  `physical-fall` tower killed you in the editor and let you fall in the game. Neither copy was tested.
- New levels were born `{ fallBehavior: 'respawn-checkpoint', fallY: -10 }`; the prefab wrapper fabricated
  `physical-fall` with a distant `fallY` purely to stop parkour's kill plane deleting the test character.
- Rule gizmos came from `RULE_KINDS`, a table in `@mp/components` covering exactly parkour's four.
- One character controller (`DEFAULT_TUNING`), one stand offset (`CHAR_HALF_HEIGHT + CHAR_RADIUS`).
- `content/levels/` was flat, so every game's levels would appear in every game's picker.

Kodjo's framing: *"the level editor currently is by default on parkour mode."* Exactly right — the game was
**implicit**, and every one of those twelve is what an implicit answer looks like.

## Decision

### One object answers all of it

```ts
interface ModeDescriptor {
  name; label
  registry            // engine components + the shared ones it wants + its own
  config: ParamDecls  // its level settings, declared like a component's parameters
  tuning; standOffset // how a character moves here, and how tall it is
  gizmos              // its rule components -> marker colour
  spawn(loaded)       // where a player starts
  session(loaded, …)  // effects, respawn point, and whether this tick was a death
}
```

Four of those retire six discrepancies at once, because **play-in-place was a parkour client** and everything
mode-shaped in the editor hung off it.

New package `@mp/mode` holds the contract. **Headless**: gizmo colours are plain numbers rather than
render-three's `GizmoKind`, and nothing mentions a scene — so a game's rules stay runnable by a bot.

### The registry is composed, not inherited

`DEFAULT_REGISTRY` was `[...ENGINE, ...GAMEPLAY]`, handed to everything. That is what made the editor
implicitly parkour: every game was force-fed all four rules whether they meant anything to it.

Parkour now composes `[...ENGINE_COMPONENTS, Checkpoint, Goal, Hazard, Bumper, Track]`. A racing game with no
use for `Bumper` omits it and the editor stops offering it.

**Nothing moved.** `Checkpoint`/`Goal`/`Hazard`/`Bumper` stay in `packages/components` as a shared library,
because Kodjo is right that several games will want checkpoints and goals. The mistake was never *where they
live*; it was that opting in was not a choice. `DEFAULT_REGISTRY` survives as the fallback for a level naming
a game this build does not have, and as a default for tests.

### `LevelConfig` splits

The engine keeps what it reads: `environment`. Everything a game needs moves to `config.mode = { name, params }`,
checked by that game's declaration through the **same `readParams`** a component's parameters go through — so a
new knob costs no editor code and no schema change.

`fallBehavior` and `fallY` became parkour's. `gravity` did **not** come along: nothing ever read it (gravity
comes from `tuning.gravity`) and no authored level set it, so it was dead schema. A declared knob with no
reader is worse than no knob.

All six levels migrated. Three write no `params` at all, because they matched parkour's declared defaults.

### Rules come out of the game's client

`modes/parkour/src/rules.ts` is headless: the config declaration, the composed registry, checkpoint indexing,
and `parkourSession`. `main.ts` and the editor now run **the same function**, so they cannot drift — which they
already had. What stays in `main.ts` is what a *client* does about a death: ragdoll, persistence, assembly.

`ModeSession` is deliberately narrow — `effects`, `respawnAt()`, `takeDeath(position)`, `progress()`. It is the
rules, not the play loop, because a level editor must not have persistence or ragdolls.

### Descriptors are globbed from the games

`tools/editor/src/modes.ts` collects `modes/*/src/editorMode.ts` with `import.meta.glob`, the mechanism already
used for levels and assets. Adding a game means adding that one file **to the game**: nothing in `packages/`,
nothing in the editor.

The editor depending on every game is the direction that works — a game cannot import a tool without a cycle,
and a tool that authors for N games has to know N of them. It costs a dev build that fails if any game fails to
typecheck, which for a dev tool is a feature. Kodjo chose this over keeping parkour's descriptor inside the
editor as a half-step.

`editorMode.ts` is separate from `rules.ts` because it names gizmo colours and so reaches into the renderer;
`rules.ts` must stay headless. `@mode/parkour` grew an `exports` map so those two are its public surface.

### The game is visible, and per level

A **game picker** in the toolbar: the authoring context. It narrows the level list and decides what a new level
is for. It deliberately does **not** retag the open level.

A **Game row** in the Hierarchy, beside Environment, where reassigning happens — because that is an edit with
consequences (the level's components are validated against the new registry) and it belongs where they are
visible. Under it, the game's settings, generated from its declaration.

The level list narrows on `config.mode.name`, from a listing the dev server now returns as `[{ name, mode }]`.
A level naming **no** game is always offered: it is unassigned, not another game's, and hiding it would make a
file unreachable in the tool meant to fix it.

Opening a level validates it against **its own** game's registry, so a component that game does not declare is
a clear load error instead of a silently broken Inspector. A level naming an uninstalled game still opens,
falling back to everything the build knows, with the Game row saying so — refusing would make a file unopenable
because a sibling app was absent.

## Consequences

- Reusing the character controller and visuals for a second game already worked. Authoring that game's levels
  in the editor now works too, which it did not.
- **The editor's play-in-place got less wrong, not just less coupled.** `physical-fall` now behaves there as it
  does in the game. Pinned by a test that names the drift.
- `addParam` lost its `(doc, at, view)` arguments for a `ParamIo` with two optional capabilities, so one widget
  generator serves both a component's parameters and a level's game settings. A declaration needing a node it
  does not get degrades to a read-only row rather than throwing.
- Reassigning a level's game **rebuilds the document** (`reopenWithRegistry`), because a `Doc` captures its
  registry at construction and the Inspector, the add menu and `effectiveNode` all read it. Rare and
  deliberate, which is why recreating beats making the registry live.
- `RULE_KINDS` is deleted. The viewer takes a descriptor per catalog entry rather than globbing, since its
  catalog is a hand-written list of one.
- The viewer's fall-catcher is a fixed `CATCH_Y`, not a game's kill plane: it inspects geometry and runs no
  game, so what it wants is not to lose the character off the bottom of the world.
- **Nothing changed on the wire**, and the loader is untouched.

## Rejected

**Keeping parkour's descriptor inside the editor** as a half-step, moving it when game 2 arrives. It collapses
the same twelve into one file, which is most of the benefit for an hour's work — but it leaves the editor
knowing parkour and leaves the rules duplicated, and game 2 means doing this anyway.

**Making the editor a library each game mounts** (`modes/parkour/editor/`). It is the only arrangement where
the dependency points from game to tool, which is tidier on paper. Rejected as disproportionate: it means a
dev server, an `index.html` and a Vite config per game, to avoid a dependency that is correct for a tool.

**Moving the four shared rules into `modes/parkour`.** Recommended, and Kodjo rejected it: several games will
want checkpoints and goals. He was right, and the fix was to `DEFAULT_REGISTRY` instead.

**A mode per editor session** (`pnpm dev:editor --mode parkour`). No picker, no filtering, nothing to get
wrong. Rejected because it leaves the game invisible — in a launch flag — which is the original complaint.

**Retagging a level from the toolbar picker.** One control for "what I am authoring for" and "what this file
is" is two meanings, and the second silently revalidates every component in the level.

### The room is one room, for every game

`ParkourRoom` was parkour in **name only** — a pure relay with no simulation and no content, which never learns
what a level is. So it became `GameRoom`, and the game joined the matchmaking filter beside the level it
already had:

```ts
gameServer.define('game', GameRoom).filterBy(['game', 'level'])
```

A room type per game would have meant `packages/server` importing every game, which is the dependency direction
the server exists outside of. A filter needs no such thing: the server still learns nothing about what a game
or a level *is*, only that two clients naming different ones must not share a room.

`level` was already there because geometry and the movement-base index a rider replicates (ADR 0021) are
positional and would disagree. `game` is there because two games may have **different character controllers**,
so mixing their clients would replicate every peer under the wrong locomotion — and because level names are
global, so two games could otherwise collide on one.

I first described this as "moving `ParkourRoom` out of `packages/server`", which was wrong twice: it is not what
Kodjo agreed to, and a generic relay is shared infrastructure that belongs exactly where it is.
