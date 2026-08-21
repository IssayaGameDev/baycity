import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/character'
import { Bumper, Checkpoint, ENGINE_COMPONENTS, Goal, Hazard, Track, createRegistry, hasComponent } from '@mp/components'
import type { LoadedLevel, WorldNode } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'
import type { ModeSession, ModeSessionOptions } from '@mp/mode'

/**
 * Parkour's rules, headless (ADR 0052).
 *
 * Extracted from `main.ts` because the editor needs them too. Before this, `main.ts` and the editor's
 * play-in-place each hand-wrote `kill`/`progress` and each filtered checkpoints their own way — and they had
 * already drifted: the editor died on any fall, ignoring the level's fall setting, so a tower level killed you
 * in the editor and let you fall in the game.
 *
 * No renderer, no persistence, no ragdoll. Those are the game client's, and a level editor must not have them.
 * What is here is only what decides *what happened*.
 */

/**
 * Parkour declares **no level settings**, and the kill plane is why (ADR 0053).
 *
 * It used to declare `fallBehavior` and `fallY` — before that they were required fields of *every* level of
 * every game. But "falling past this height kills you" is a **rule**, and every other rule here is a
 * component. A `Hazard` on a wide flat collider under the level is that rule, with no code: you touch it, you
 * die. So the settings went, and with them the `physical-fall` enum — a tower is simply a level with no plane
 * under it.
 *
 * What that bought: the plane is visible, draggable, and can cover part of a level instead of all of it.
 */

/**
 * Every component a parkour level may use: the engine's, plus the shared rules this game wants.
 *
 * **Composed, not inherited.** `DEFAULT_REGISTRY` was engine-plus-everything, so every game was force-fed all
 * four rules whether they meant anything to it. A game that has no use for `Bumper` leaves it out and the
 * editor stops offering it.
 */
export const PARKOUR_REGISTRY = createRegistry([...ENGINE_COMPONENTS, Checkpoint, Goal, Hazard, Bumper, Track])

/**
 * Markers sit on a surface, so the capsule's *centre* must clear it by its stand height — otherwise the player
 * spawns half-sunk into the pad.
 */
export const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS

/** Nodes carrying a `Checkpoint`, in tree order. Only touchable ones: an unreachable checkpoint is not a step. */
export const checkpointsOf = (loaded: LoadedLevel): readonly WorldNode[] => loaded.nodes.filter((n) => hasComponent(n.components, Checkpoint))

/** Standing height above a node's own origin. */
const standingAt = (at: Vec3): Vec3 => vec3(at.x, at.y + STAND_OFFSET, at.z)

/** The level's spawn marker, or a fallback above the origin when it has none. */
export const spawnOf = (loaded: LoadedLevel, seed?: number): Vec3 => {
  const marker = loaded.markers.find((m) => m.kind === 'spawn')?.position
  if (marker === undefined) return vec3(0, 3, 0)
  if (seed === undefined) return standingAt(marker)
  // The golden-angle step keeps two arrivals from stacking inside each other.
  const a = seed * 2.399963
  return vec3(marker.x + Math.cos(a) * 2, marker.y + STAND_OFFSET, marker.z + Math.sin(a) * 2)
}

/**
 * A parkour session: progress is a checkpoint index, and death is any hazard firing — a pad, or the hazard
 * plane under the level that used to be a `fallY` setting (ADR 0053).
 *
 * `from` resumes a persisted checkpoint; `onProgress` is how a client saves one. The editor passes neither, so
 * it gets the same rules with no memory — which is what a play-test wants.
 */
export const parkourSession = (loaded: LoadedLevel, opts: ModeSessionOptions = {}): ModeSession => {
  const checkpoints = checkpointsOf(loaded)
  let reached = opts.from ?? -1
  let killed = false

  // Resuming: stand on the checkpoint that was reached, if it is still in this level.
  const resumed = reached >= 0 && reached < checkpoints.length ? checkpoints[reached]!.position : undefined
  let respawn = resumed === undefined ? spawnOf(loaded) : standingAt(resumed)

  return {
    effects: {
      // A flag rather than a call, so the host asks once per tick and gates it on already being dead in one
      // place rather than at every rule that can kill.
      kill: () => void (killed = true),
      // Progress only advances: touching an earlier checkpoint never lowers your saved index.
      progress: (node) => {
        const i = checkpoints.indexOf(node)
        if (i < 0 || i <= reached) return
        reached = i
        respawn = standingAt(node.position)
        opts.onProgress?.(i, node)
      },
    },
    respawnAt: () => respawn,
    takeDeath: () => {
      // Every death is a rule firing now — a hazard pad, or the hazard plane under the level that replaced
      // the fall check (ADR 0053). Nothing here needs to know where the player is.
      const died = killed
      killed = false
      return died
    },
    progress: () => reached,
  }
}

