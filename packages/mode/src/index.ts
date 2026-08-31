import type { AnimatorFactory, CharacterState, CharacterTuning, GaitTuning, PlatformPoseLookup } from '@mp/humanoid'
import type { ComponentDef, Effects, Registry } from '@mp/components'
import type { ComponentData, LoadedLevel, WorldNode } from '@mp/content'
import type { Vec3 } from '@mp/core'

import type { ActionBindings } from './actions'

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
}

/**
 * One game, as the platform sees it.
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
  /** How a character moves here. A game with different locomotion supplies different numbers. */
  readonly tuning: CharacterTuning
  /**
   * How far above a spawn or checkpoint node the character's origin sits. A rig-shape constant, so a game
   * with a differently-sized character is not stuck with the capsule's.
   */
  readonly standOffset: number
  /**
   * Component type → gizmo colour (`0xrrggbb`), for the markers a tool draws over a rule's node.
   *
   * The game's, because a rule is the game's. `MARKER_COLORS` in the renderer covered exactly parkour's four
   * and nothing else could get a marker at all.
   */
  readonly gizmos: Readonly<Record<string, number>>
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
   */
  readonly player?: readonly ComponentData[]
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
   * How this game's characters are animated (ADR 0063).
   *
   * `gait` is the feel of the shared biped cycle — stride, bob, lean, arm swing — and was one object for
   * every game on the platform, live on the debug pane and reachable by nobody else. Absent keeps the shipped
   * numbers.
   *
   * `animator` is the seam: a factory the host calls per character. Absent uses the shared procedural gait,
   * which is what every game does today. A game with movement of its own supplies its own — normally by
   * wrapping `createAnimator` and overriding the pose for a state the shared cycle has never heard of.
   *
   * **Nothing was added to `AnimationInput` for that**, deliberately: the factory is the game's own code, so
   * it closes over the game's own state (ADR 0061's trick), and the platform never carries a flag it cannot
   * interpret. The cost is that such a state is **local only** — component state is not serialized, so a
   * peer's dash shows as an ordinary run until whatever it does goes on the wire.
   */
  readonly gait?: GaitTuning
  readonly animator?: AnimatorFactory
  /**
   * States of this game's own that have to reach **other players** (ADR 0064), in order, at most five.
   *
   * A game-supplied animator reads the local player's state by closure (ADR 0063), and cannot do that for a
   * peer — component state never goes on the wire (ADR 0059) — so a peer mid-dash was drawn running. These
   * names claim the spare bits of the state byte, which are already being sent: order is the bit order, so
   * **appending is safe and reordering is not**.
   *
   * Five because that is what is spare. A sixth needs a wider field and real bytes, which is a budget
   * decision rather than a free one.
   *
   * The platform never learns what a name means. It asks `playerStates` which are set, packs them, and hands
   * the set back for a peer — see `AnimatorFactory`, which is where they are read.
   */
  readonly states?: readonly string[]
  /**
   * Which of `states` are true for the local player right now.
   *
   * Called once per outgoing state message. A game closes over whatever it needs, the same way `playerDefs`
   * does — usually its own component's flag.
   */
  readonly playerStates?: () => ReadonlySet<string>
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

/**
 * The node id the local player's components see as `self.node.id` (ADR 0059).
 *
 * One constant rather than a string typed at each host, so a `nodeRef` authored against the player means the
 * same thing in the game and in the editor's play-test.
 */
export const PLAYER_NODE_ID = 'player'

export type { ActionBindings } from './actions'
export { actionsHeld } from './actions'
