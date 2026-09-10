import { LOCOMOTION_DEF, CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/humanoid'
import { createRegistry, ENGINE_COMPONENTS, Hazard, PLAYER_COMPONENTS } from '@mp/components'
import type { LoadedLevel } from '@mp/content'
import { spawnFrom, type ModeSession, type ModeSessionOptions } from '@mp/mode'

import { Keyboard } from './keycaps'

/**
 * Keyboard Escape's rules: none yet beyond spawning and dying.
 *
 * Headless on purpose: no renderer, no persistence, no DOM. That is what lets the editor play-test a game by
 * running these rather than a second hand-written copy of them (ADR 0052), and it is the property a new game
 * most easily loses by reaching for a package it does not need.
 */

/**
 * What this game's levels may contain: the engine's components, `Hazard` for a kill plane under the level
 * (ADR 0053), and **`Keyboard`** — the component that turns a platform's top face into keycaps (ADR 0069).
 *
 * **Composed, not inherited.** Add `Checkpoint`, `Goal`, `Bumper` or your own from `@mp/components` as the
 * game needs them; the editor offers exactly what is listed here and nothing else.
 */
export const KEYBOARD_REGISTRY = createRegistry([...ENGINE_COMPONENTS, Hazard, ...PLAYER_COMPONENTS, LOCOMOTION_DEF, Keyboard])

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
 * A session with no progression yet: you spawn, you can die, you respawn where you started.
 *
 * Falling puts you back at the stage start, which is what `respawnAt` already does with no checkpoints — the
 * design Kodjo picked, and the reason a higher speed cap is worth earning.
 *
 * `progress` is always `-1` and `onProgress` is never called, so the client saves nothing — which is correct
 * for a game with nothing to save yet, and is where a checkpoint rule would go. Compare `modes/parkour`, whose
 * session is the same shape with a checkpoint index threaded through it.
 */
export const keyboardSession = (loaded: LoadedLevel, _opts: ModeSessionOptions = {}): ModeSession => {
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
