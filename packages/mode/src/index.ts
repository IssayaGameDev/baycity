import type { CharacterState, CharacterTuning, PlatformPoseLookup } from '@mp/humanoid'
import type { PhysicsWorld } from '@mp/physics'
import type { ComponentDef, DataTypeDef, Effects, Registry } from '@mp/components'
import type { ComponentData, LoadedLevel, WorldNode } from '@mp/content'
import type { Vec3 } from '@mp/core'

import type { ActionBindings } from './actions'
import type { SettingDecls } from './settings'
import type { SurfaceGridOf } from './surface'

/**
 * `@mp/mode` — what a **game** contributes to the platform, as one object.
 *
 * The stack hosts several games (SEED: "an extremely simplified Roblox"), and every tool that opens a level
 * has to know things only the game can answer: which components exist, what its level config means, how a
 * character moves, and what dying is. Before this, the editor answered all of them *as parkour* — hardcoded
 * registry, hardcoded checkpoint progression, hardcoded fall plane — so a second game could not have been
 * authored in it (ADR 0052).
 *
 * A `ModeDescriptor` is that answer, and it is the only thing a tool needs. Adding a game means writing one,
 * not editing a tool or a package.
 *
 * **Headless on purpose.** Rules run in the sim, so this imports no renderer: gizmo colours are plain numbers
 * rather than a render-three type, and the descriptor never mentions a scene. That keeps a game's rules usable
 * by the editor, the viewer, a bot and the game itself.
 */

/**
 * A live rules session over one loaded level: the reactions a component may ask for, and what the host has to
 * ask back each tick.
 *
 * Deliberately narrow. It is **the rules**, not the play loop — a game's own client also does persistence,
 * ragdolls and cameras, and none of that belongs in a level editor. What is shared is exactly the part that
 * decides *what happened*.
 */
export interface ModeSession {
  /** Hand this to `createComponentRuntime`, so a component's `onContact` reaches the game's rules. */
  readonly effects: Effects
  /** Where a spawn or respawn puts the character. Moves as progress is made. */
  readonly respawnAt: () => Vec3
  /**
   * Did the player die on this tick? **Consumes** the flag, so a host that calls it once per tick cannot see
   * one death twice.
   *
   * Takes nothing, because every death is a rule firing. It used to take the player's position so a game
   * could check a fall plane, which is exactly the thing that should have been a component: a hazard on a
   * large flat collider under the level *is* a kill plane, and needs no code at all (ADR 0053).
   */
  readonly takeDeath: () => boolean
  /** How far this session has progressed, for a host that persists it. `-1` for no progress yet. */
  readonly progress: () => number
  /**
   * Did a rule move the player this tick? Returns where to, **once**, then `null` — the same consume-on-read
   * shape as `takeDeath`, so a host asking once per tick cannot apply one teleport twice (ADR 0073).
   *
   * Separate from death on purpose: dying ragdolls, waits for a click and reassembles, and a rule that just
   * relocates the player (cashing out at the end of a stage, a portal) must not look like any of that.
   *
   * Optional, because most sessions never move anybody: a game with no such rule leaves it undefined and the
   * host never asks.
   */
  readonly takeTeleport?: () => Teleport | null
}

/** Where a rule moves the player: the character's origin, and — when the rule says — the way they then face. */
export interface Teleport {
  readonly position: Vec3
  /**
   * The character's yaw (`yawOf`: forward = `(sin yaw, 0, cos yaw)`): they turn to it and the camera swings
   * behind them (ADR 0202). Absent: they keep facing as they were, the camera where it was.
   */
  readonly yaw?: number
}

/** How a session starts: where the player left off, and a hook for saving when they get further. */
export interface ModeSessionOptions {
  /** Progress to resume from, as `ModeSession.progress` last reported it. */
  readonly from?: number
  /** Called when progress advances. A game's client persists; the editor ignores it. */
  readonly onProgress?: (progress: number, node: WorldNode) => void
}

/**
 * What a host can offer a game's player components, as getters (ADR 0061).
 *
 * Getters throughout, because none of it exists when `playerDefs` is called for a session that is still being
 * built, and because the character can be replaced (a respawn) without the definitions being rebuilt.
 *
 * Deliberately small: these are the things the **host** owns. A game needing anything else closes over it in
 * `playerDefs`, which is its own code.
 */
export interface PlayerHost {
  /** The live character, or `null` before a session has one. */
  readonly character: () => CharacterState | null
  /** The game's live tuning — the same object a debug pane is bound to, so it stays one source. */
  readonly tuning: () => CharacterTuning
  /** Where the level's clock-driven pieces are this tick, so a rider is carried. */
  readonly platforms: () => PlatformPoseLookup | undefined
  /**
   * The physics world this session runs in, or `null` before there is one (ADR 0066).
   *
   * The whole of it: cast against it, add bodies to it, remove them again. **The platform learns nothing** by
   * handing this over, which is the difference between this and a descriptor field — a rope, a grapple, a
   * portal and a laser all want exactly `castSphere` and `addDynamicBody`, and none of them is a concept the
   * stack has to hold.
   *
   * Not a new coupling: `character()` already returns a `CharacterState` whose `body` is a physics type, so
   * this contract has always leaked `@mp/physics`. It is now honest about it.
   */
  readonly world: () => PhysicsWorld | null
  /**
   * The instantiated level, or `null` before one is loaded (ADR 0066).
   *
   * `nodeOf(colliderHandle)` is the reason this is here: a cast returns a collider, and asking "what did I
   * hit, and what is authored on it" is how a game acts on **tagged** geometry rather than on any surface at
   * all. `markers`, `allNodes` and `findNode` are the rest of the same question.
   */
  readonly level: () => LoadedLevel | null
}

/**
 * One game, as the **tools** see it.
 *
 * That is the whole membership rule since ADR 0065, and it is why this shrank from fifteen fields to ten. A
 * field belongs here when more than one consumer needs it: the editor authors levels for a game and play-tests
 * them in place, the viewer inspects them, and the client runs them. `gait`, `animator`, `states`,
 * `playerStates` and `standOffset` had exactly one reader each — the client — and existed as fields only
 * because `startGameClient` was the sole door into it. They are `TpsClientOptions` now (`@mp/tps`), which is
 * an argument list rather than a contract, and a game that wants something else changes its own `main.ts`
 * instead of asking for a sixteenth field.
 *
 * `registry` is **composed**, not inherited: the engine's components plus whichever of the shared gameplay
 * library this game wants plus its own. A racing game that has no use for `Bumper` simply does not list it,
 * and the editor then does not offer it. `DEFAULT_REGISTRY` force-fed all of them to everything, which is the
 * thing that made the editor implicitly parkour.
 */
export interface ModeDescriptor {
  /** Stable id, matching `LevelConfig.mode.name`. Never shown to a person. */
  readonly name: string
  /** What a picker shows. */
  readonly label: string
  /** Engine components + the shared ones this game uses + its own. */
  readonly registry: Registry
  /**
   * The data types this game declares (ADR 0181): what **New data** offers in its library, and what its data assets
   * are read against. A data asset of one lives only in this game's library. Absent = none.
   */
  readonly dataTypes?: readonly DataTypeDef[]
/**
   * How a character moves here. A game with different locomotion supplies different numbers.
   *
   * Stays a field because the **editor** play-tests in place and needs it. A client-only value would have
   * moved to `TpsClientOptions` with the rest (ADR 0065).
   */
  readonly tuning: CharacterTuning
  /**
   * Component type → gizmo colour (`0xrrggbb`), for the markers a tool draws over a rule's node.
   *
   * The game's, because a rule is the game's. `MARKER_COLORS` in the renderer covered exactly parkour's four
   * and nothing else could get a marker at all.
   */
  readonly gizmos: Readonly<Record<string, number>>
  /**
   * Component type → gizmo colour, for a marker with an **arrow along the node's forward** (+Z): a place a player
   * is put, and the way they will face (ADR 0202). Drawn on every node carrying it, collider or not — a place to
   * stand is not something to touch.
   */
  readonly facingGizmos?: Readonly<Record<string, number>>
  /**
   * What this game would tile onto a box surface, for a tool to preview before the game has run (ADR 0120).
   *
   * The same seam as `gizmos` and for the same reason — a tool draws what only the game can describe — one
   * step further along: a colour per component type, against a grid per surface. Keyboard's caps are
   * generated at load, so without this an author places platforms with no way to see where the keys land.
   *
   * Absent means a game whose surfaces hold nothing generated, which is every game but keyboard.
   */
  readonly surfaceGrid?: SurfaceGridOf
  /** Where the character starts, before any progress. */
  /**
   * Where a player starts. `seed` spreads arrivals so two players do not stack — a player id in the game,
   * absent in a tool, which has exactly one body to place.
   */
  readonly spawn: (loaded: LoadedLevel, seed?: number) => Vec3
  /**
   * Components the **player** carries, attached at runtime rather than authored in a level (ADR 0059).
   *
   * The seam for an ability the player *has*, as opposed to a pad they touch. A level authors the world; it
   * does not author who is playing, so this is the game's to declare and the same registry above validates it.
   *
   * Absent means a player with no components of its own, which is every game today. What one of these can do
   * is read the character and push it (`Ctx.character`) — see `CharacterAccess`.
   *
   * A field rather than a client argument because the editor's play-test attaches these too (ADR 0065).
   */
  readonly player?: readonly ComponentData[]
  /**
   * The game's tunable numbers, edited in the editor's games window (Settings) and stored in `content/<game>/game.json`
   * under `settings` (ADR 0087). Absent means the game has none. What the game does with them is its own:
   * keyboard reads its progression curve off them (`curveFrom`).
   */
  readonly settings?: SettingDecls
  /**
   * This game's own controls, as action name → the physical key `code`s that hold it (ADR 0061).
   *
   * The names are the game's and the platform never learns what one means: a host fills
   * `InputCommand.actions` from these, and the game's own locomotion component reads back the names it
   * declared. Physical codes, so a binding is the same key on any keyboard layout.
   *
   * Absent means move and jump are the whole control scheme, which is every game the stack ships.
   */
  readonly actions?: ActionBindings
  /**
   * Build this game's player component definitions for one session (ADR 0061).
   *
   * The seam that makes locomotion the game's. A host calls this when a level is joined and hands the result
   * to `createComponentRuntime`, so a definition can close over the live character — which does not exist
   * when the registry is built.
   *
   * **The game supplies its own access.** What the host offers is only what the host owns (the character, the
   * level's platform poses, the feel); anything else a game's component needs, the game closes over itself,
   * because the game is what runs this function. That is why `Ctx` does not grow a field per capability.
   *
   * Absent means this game's player components are all data the host reads (`Death`) rather than behaviour.
   */
  readonly playerDefs?: (host: PlayerHost) => readonly ComponentDef[]
  /**
   * **Gone since ADR 0065**: `gait`, `animator`, `states`, `playerStates`, `standOffset`.
   *
   * Each had one reader — the client — and each is now a parameter of `startTpsClient` in `@mp/tps`, passed
   * from the game's own `main.ts`. `standOffset` had no reader at all: every game declared it and then handed
   * its own `STAND_OFFSET` to its own `spawnOf`, so the field was never read by anything.
   *
   * The rule that removed them: a field here is a contract shared with two tools that do not care about
   * animation. An argument to the game a `main.ts` calls is not.
   */
  /** Begin a rules session over this level. */
  readonly session: (loaded: LoadedLevel, opts?: ModeSessionOptions) => ModeSession
}

/**
 * A game declares **no level settings**, and that is a decision rather than an omission (ADR 0053).
 *
 * There was a `config: ParamDecls` here, plus a `modeParams` that read `LevelConfig.mode.params` through it.
 * Its only user was parkour's `fallBehavior`/`fallY` — and those were a *rule* wearing a setting's clothes.
 * A rule is a component in this system, so the kill plane became a `Hazard` on a collider and the settings
 * block emptied out.
 *
 * Re-add it the day a game has something that genuinely is a level-wide *value* rather than a rule: a lap
 * count, a time limit. Until then it would be an untested seam with no callers.
 */

export { spawnFrom, standingAt } from './spawn'
export { readSettings, readSetting, isCurveSetting, isTableSetting, type SettingDecl, type SettingDecls, type SettingValues, type NumberSetting, type CurveSetting, type TableSetting, type TableColumn, type TableRows } from './settings'
export { sampleCurve, normalizePoints, lastRatio, RATIO_FLOOR, type CurvePoint, type CurveShape, type Interpolation, type Beyond } from './curve'

/**
 * The node id the local player's components see as `self.node.id` (ADR 0059).
 *
 * One constant rather than a string typed at each host, so a `nodeRef` authored against the player means the
 * same thing in the game and in the editor's play-test.
 */
export const PLAYER_NODE_ID = 'player'

export type { ActionBindings } from './actions'
export { actionsHeld } from './actions'

export { gridCells, gridMargin, type SurfaceGrid, type SurfaceGridOf } from './surface'
