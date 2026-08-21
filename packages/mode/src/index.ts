import type { CharacterTuning } from '@mp/character'
import type { Effects, Registry } from '@mp/components'
import type { LoadedLevel, WorldNode } from '@mp/content'
import type { Vec3 } from '@mp/core'

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
  readonly spawn: (loaded: LoadedLevel) => Vec3
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
