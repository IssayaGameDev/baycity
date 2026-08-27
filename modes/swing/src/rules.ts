import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/character'
import { Bumper, Checkpoint, createRegistry, ENGINE_COMPONENTS, Goal, Hazard, PLAYER_COMPONENTS, Track } from '@mp/components'
import type { LoadedLevel } from '@mp/content'
import { spawnFrom, type ModeSession, type ModeSessionOptions } from '@mp/mode'

/**
 * Swing's rules, which are so far only the ones every game needs: spawn somewhere, be able to die, respawn.
 * Copied from `modes/_template` (ADR 0056) and not yet grown.
 *
 * Headless on purpose: no renderer, no persistence, no DOM. That is what lets the editor play-test the game by
 * running these rather than a second hand-written copy of them (ADR 0052), and it is the property a new game
 * most easily loses by reaching for a package it does not need. Whatever swinging turns out to be — a grapple
 * component, a rope constraint — it starts here.
 */

/**
 * What Swing's levels may contain: the engine's components plus the whole shared gameplay library.
 *
 * **Composed, not inherited** (ADR 0052) — the list is the choice. Swing takes all of it because its first
 * level is a copy of parkour's, which uses movers, a trampoline, checkpoints and a goal; a game that wants
 * none of those simply does not list them and the editor stops offering them.
 *
 * Note what this does *not* imply: `Checkpoint` and `Goal` are authorable and touchable, but `swingSession`
 * below keeps no progress, so reaching one does nothing yet. The rule is where progression lives, not the
 * component.
 */
export const SWING_REGISTRY = createRegistry([...ENGINE_COMPONENTS, Checkpoint, Goal, Hazard, Bumper, Track, ...PLAYER_COMPONENTS])

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
 * `progress` is always `-1` and `onProgress` is never called, so the client saves nothing — correct for a
 * game with nothing to save yet, and where a checkpoint rule would go. Compare `modes/parkour`, whose session
 * is the same shape with a checkpoint index threaded through it.
 */
export const swingSession = (loaded: LoadedLevel, _opts: ModeSessionOptions = {}): ModeSession => {
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
