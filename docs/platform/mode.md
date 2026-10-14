# `@mp/mode` — what a game contributes to the tools

Package `packages/mode` (`@mp/mode`). Headless: no renderer import; gizmo colours are numbers. Deps: `@mp/components`, `@mp/content`, `@mp/core`, `@mp/humanoid`, `@mp/physics`. Source: `packages/mode/src/index.ts`, `spawn.ts`, `actions.ts`. ADR 0052 (descriptor), ADR 0065 (membership rule: a field lives here only when more than one consumer — editor, client — reads it).

## `ModeDescriptor` — `packages/mode/src/index.ts`

| field | type | meaning |
|---|---|---|
| `name` | `string` | Stable id; matches `LevelConfig.mode.name`. Never shown. |
| `label` | `string` | Picker text. |
| `registry` | `Registry` | Engine + shared (from `content/<name>/game.json`) + own components. Composed, not inherited (see `docs/platform/components/api.md`). |
| `dataTypes?` | `readonly DataTypeDef[]` | The data types this game declares (ADR 0181): what New data offers in its library, what its data assets are read against. Absent = none. |
| `tuning` | `CharacterTuning` (`packages/humanoid/src/groundController.ts`) | Starting locomotion numbers; the client copies them. |
| `gizmos` | `Readonly<Record<string, number>>` | Component type → `0xrrggbb` marker colour a tool draws over the rule's node. |
| `facingGizmos?` | `Readonly<Record<string, number>>` | Component type → colour of a marker with an arrow along the node's forward (+Z, `yawOf`): a place a player is put, and the way they face (ADR 0202). On every node carrying it, collider or not (`allNodes`). Absent = none. |
| `surfaceGrid?` | `(components, size: Vec3, settings) => SurfaceGrid \| null` (`src/surface.ts`) | What this game would tile onto a box surface, for a tool to draw before the game runs (ADR 0120). Returns the **grid** (`cols`, `rows`, `pitch`, `size`, `startX`, `startZ`), never geometry — six numbers whatever the cell count, so a tool may ask per drag frame, and `@mp/mode` stays headless. The game reads the node's own components, so a tool never learns what one means. Helpers: `gridCells`, `gridMargin`. Absent = nothing generated on this game's surfaces. |
| `spawn` | `(loaded: LoadedLevel, seed?: number) => Vec3` | Start position. `seed` = player id in a game, absent in a tool. |
| `player?` | `readonly ComponentData[]` | Components the player carries at runtime, validated against `registry` (ADR 0059). Absent = none. |
| `playerDefs?` | `(host: PlayerHost) => readonly ComponentDef[]` | Session-bound definitions for the `player` list, closing over the live character (ADR 0061). Must agree with `player` by type — a mismatch logs `console.error` in `createComponentRuntime`. Absent = player components are data only (`Death`). |
| `actions?` | `ActionBindings` | Game's own controls. Absent = move + jump only. |
| `session` | `(loaded: LoadedLevel, opts?: ModeSessionOptions) => ModeSession` | Begin the rules over one loaded level. |

No level-settings block: a rule is a component (ADR 0053).

## `ModeSession`

```ts
interface ModeSession {
  readonly effects: Effects                    // hand to createComponentRuntime; kill/progress land here
  readonly respawnAt: () => Vec3               // moves with progress
  readonly takeDeath: () => boolean            // consume-on-read, once per tick
  readonly progress: () => number              // -1 = none; what a client persists
  readonly takeTeleport?: () => Teleport | null  // consume-on-read; a rule relocated the player (ADR 0073); optional
}
interface Teleport {
  readonly position: Vec3
  readonly yaw?: number                         // yawOf convention: the player turns to it, the camera swings behind (ADR 0202)
}
interface ModeSessionOptions {
  readonly from?: number                                        // resume progress
  readonly onProgress?: (progress: number, node: WorldNode) => void   // client persists; editor ignores
}
```

A game may extend `ModeSessionOptions` (e.g. `KeyboardSessionOptions` in `modes/keyboard/src/rules.ts` adds `onCashOut`, `onTreadmill`, `onStepPad`); the descriptor's `session` still satisfies the base signature.

## `PlayerHost` (ADR 0061, ADR 0066)

All getters — none exists when `playerDefs` is called, and the character is replaced on respawn.

```ts
interface PlayerHost {
  readonly character: () => CharacterState | null        // live character
  readonly tuning: () => CharacterTuning                  // the live tuning object (debug pane binds to it)
  readonly platforms: () => PlatformPoseLookup | undefined   // clock-driven piece poses this tick (rider carry)
  readonly world: () => PhysicsWorld | null               // whole physics world: cast, add/remove bodies
  readonly level: () => LoadedLevel | null                // nodeOf / markers / allNodes / findNode
}
```

Anything else a player component needs, the game closes over inside `playerDefs`.

## Spawn — `packages/mode/src/spawn.ts`

```ts
standingAt(at: Vec3, standOffset: number): Vec3                       // at.y + standOffset
spawnFrom(standOffset: number): (loaded: Pick<LoadedLevel, 'markers'>, seed?: number) => Vec3
```

`spawnFrom`: first `spawn` marker; none → `(0, 3, 0)`; `seed` given → golden-angle fan (`2.399963` rad) at radius 2 around the marker. Games call `spawnFrom(CHAR_HALF_HEIGHT + CHAR_RADIUS)` and export it as `spawnOf`.

## Actions — `packages/mode/src/actions.ts`

```ts
type ActionBindings = Readonly<Record<string, readonly string[]>>   // action name → physical KeyboardEvent.code list
actionsHeld(bindings: ActionBindings | undefined, keys: ReadonlySet<string>): ReadonlySet<string>   // any code down = held; undefined → empty set
```

Result fills `InputCommand.actions` (`packages/core/src/input.ts`); the game's locomotion component reads back its own names.

## `PLAYER_NODE_ID = 'player'`

The `self.node.id` the local player's components see.

## Where a descriptor lives and how tools find it

- Each game exports one from `modes/<game>/src/editorMode.ts` under any export name (e.g. `KEYBOARD_MODE`, `modes/keyboard/src/editorMode.ts`). Rules stay in `modes/<game>/src/rules.ts`, the game's own components in `modes/<game>/src/components/`, one per file (ADR 0174); `editorMode.ts` assembles them with tuning, gizmos and player lists.
- `tools/editor/src/modes.ts`: `import.meta.glob('../../../modes/*/src/editorMode.ts', { eager: true })`; structural check `isDescriptor` (`name: string`, `registry: object`, `session: function`); directories starting with `_` skipped; duplicate `name` warns and keeps the first. Exports `MODES` (by name), `MODE_LIST` (label order), `modeOf(level)` (`config.mode?.name` → descriptor or `undefined`), `soleMode()`.

## What the editor uses (`tools/editor/src/main.ts`)

| descriptor field | use |
|---|---|
| `name`, `registry` | `registryFor(mode)` — registry plus live `content/<name>/game.json` extras; `adopt` writes that file |
| `label` | picker; status text; Play's refusal |
| `gizmos` | marker colours over rule nodes |
| `facingGizmos?` | the same disc and post, plus an arrow turned to the node's yaw, over every node carrying the type (`itemMeshes.ts` `facingGizmo`) |
| `surfaceGrid?` | the `Keys` overlay: cells drawn in each item's mesh holder, built-in box and rounded box only (ADR 0120) |

The rest — `spawn`, `session`, `player`, `playerDefs`, `tuning`, `actions` — is the game client's; the editor plays a
level in the game's own page (ADR 0172).

## Settings (ADR 0087)

`ModeDescriptor.settings?: SettingDecls` — `Record<key, NumberSetting | CurveSetting | TableSetting>`:

```ts
NumberSetting { kind?: 'number'; label; default: number; min?; max?; step?; hint? }
CurveSetting  { kind: 'curve'; label; hint?; xLabel; yLabel; interpolation: 'linear' | 'ratio'; beyond: 'hold' | 'extend'; logY?; yMin?; default: CurvePoint[] }
TableSetting  { kind: 'table'; label; hint?; columns: { [column]: { label; default; min?; max?; step? } }; default: rows }   // ADR 0222
readSettings(decls, raw): SettingValues   // a file's `settings` block over the defaults; wrong shape → default; a table's
                                          // rows each column a finite number or its default, else the declared rows
sampleCurve(points, x, { interpolation, beyond })   // before the first point: its y; between: linear or constant ratio; after: hold or extend
normalizePoints(raw): CurvePoint[] | null  // sorted, deduped, finite
```

Stored in `content/<game>/game.json` → `settings`; edited in the editor's games window, Settings (a graph per curve, `editor.md`, ADR 0162). Keyboard: `CURVE_SETTINGS`, five curves, and `PAD_SETTINGS`, the step-pad table (`docs/games/keyboard/balance.md`, ADR 0087/0088, ADR 0222).
