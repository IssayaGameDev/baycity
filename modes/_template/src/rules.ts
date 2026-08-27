import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/character'
import { createRegistry, ENGINE_COMPONENTS, Hazard, PLAYER_COMPONENTS } from '@mp/components'
import type { LoadedLevel } from '@mp/content'
import { spawnFrom, type ModeSession, type ModeSessionOptions } from '@mp/mode'

/**
 * The smallest set of rules a game can have, and the thing to copy when starting one.
 *
 * Headless on purpose: no renderer, no persistence, no DOM. That is what lets the editor play-test a game by
 * running these rather than a second hand-written copy of them (ADR 0052), and it is the property a new game
 * most easily loses by reaching for a package it does not need.
 */

/**
 * What this game's levels may contain: the engine's components, plus `Hazard` so a level can have a kill plane
 * under it (ADR 0053) and a fall is survivable authoring rather than an infinite drop.
 *
 * **Composed, not inherited.** Add `Checkpoint`, `Goal`, `Bumper` or your own from `@mp/components` as the
 * game needs them; the editor offers exactly what is listed here and nothing else.
 */
export const TEMPLATE_REGISTRY = createRegistry([...ENGINE_COMPONENTS, Hazard, ...PLAYER_COMPONENTS])

/** How far above a spawn node the character's origin sits — half the capsule, plus its cap. */
export const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS

/**
 * Where a player starts: the level's spawn marker, or above the origin if it has none.
 *
 * The placement itself is shared (`@mp/mode`) — it was the same function in every game. What is this game's
 * is the stand-off height, which is its character's, not the platform's.
 */
export const spawnOf = spawnFrom(STAND_OFFSET)

/**
 * A session with no progression: you spawn, you can die, you respawn where you started.
 *
 * `progress` is always `-1` and `onProgress` is never called, so the client saves nothing — which is correct
 * for a game with nothing to save yet, and is where a checkpoint rule would go. Compare `modes/parkour`, whose
 * session is the same shape with a checkpoint index threaded through it.
 */
export const templateSession = (loaded: LoadedLevel, _opts: ModeSessionOptions = {}): ModeSession => {
  const spawn = spawnOf(loaded)
  let killed = false
  return {
    effects: {
      kill: () => {
        killed = true
      },
      progress: () => {
        // Nothing to progress through. A game with checkpoints records the node here.
      },
    },
    respawnAt: () => spawn,
    takeDeath: () => {
      const died = killed
      killed = false
      return died
    },
    progress: () => -1,
  }
}
