import { LOCOMOTION_DEF, CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/humanoid'
import { createRegistry, componentOn, ENGINE_COMPONENTS, Hazard, PLAYER_COMPONENTS } from '@mp/components'
import type { LoadedLevel, WorldNode } from '@mp/content'
import type { Vec3 } from '@mp/core'
import { spawnFrom, type ModeSession, type ModeSessionOptions } from '@mp/mode'

import { Keyboard } from './keycaps'
import { WinsPad } from './wins'

/**
 * Keyboard Escape's rules: spawn, die, and cash out.
 *
 * Headless on purpose: no renderer, no persistence, no DOM. That is what lets the editor play-test a game by
 * running these rather than a second hand-written copy of them (ADR 0052), and it is the property a new game
 * most easily loses by reaching for a package it does not need.
 */

/**
 * What this game's levels may contain: the engine's components, `Hazard` for a kill plane under the level
 * (ADR 0053), **`Keyboard`**, which turns a platform's top face into keycaps (ADR 0069), and **`WinsPad`**,
 * the end of a stage (ADR 0073).
 *
 * **Composed, not inherited.** Add `Checkpoint`, `Goal`, `Bumper` or your own from `@mp/components` as the
 * game needs them; the editor offers exactly what is listed here and nothing else.
 */
export const KEYBOARD_REGISTRY = createRegistry([...ENGINE_COMPONENTS, Hazard, ...PLAYER_COMPONENTS, LOCOMOTION_DEF, Keyboard, WinsPad])

/** How far above a spawn node the character's origin sits — half the capsule, plus its cap. */
export const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS

/**
 * Where a player starts: the level's spawn marker, or above the origin if it has none.
 *
 * The placement itself is shared (`@mp/mode`) — it was the same function in every game. What is this game's
 * is the stand-off height, which is its character's, not the platform's.
 */
export const spawnOf = spawnFrom(STAND_OFFSET)

/** The shared options, plus the one thing this game's rules report that the platform has no word for. */
export interface KeyboardSessionOptions extends ModeSessionOptions {
  /** A `WinsPad` paid out. The client banks and shows it; the editor's play-test passes nothing. */
  readonly onCashOut?: (wins: number, node: WorldNode) => void
}

/**
 * A session with one rule beyond spawning and dying: **stand on a `WinsPad` and you cash out** — its `wins`
 * are reported, and the next tick puts you back at the spawn (ADR 0073).
 *
 * Falling is also back at the spawn. No checkpoints, nothing locks a stage: `respawnAt` never moves, which is
 * Kodjo's design and the reason a higher speed cap is worth earning.
 *
 * `progress` is always `-1` and `onProgress` is never called, so the client saves nothing through the
 * platform's save shape. Wins and Experience are the game's own stats and the game saves them itself.
 */
export const keyboardSession = (loaded: LoadedLevel, opts: KeyboardSessionOptions = {}): ModeSession => {
  const spawn = spawnOf(loaded)
  let killed = false
  /** Where the next tick should put us, or `null`. Set by a pad, cleared by the host reading it. */
  let teleport: Vec3 | null = null
  return {
    effects: {
      kill: () => {
        killed = true
      },
      // Every contact with a rule-bearing node lands here; only a pad means anything to this game. Standing on
      // one reports every tick, so a cash-out already waiting to be applied is not paid a second time.
      progress: (node) => {
        if (teleport !== null) return
        const pad = componentOn(node.components, WinsPad)
        if (pad === undefined) return
        teleport = spawn
        opts.onCashOut?.(pad.wins, node)
      },
    },
    respawnAt: () => spawn,
    takeDeath: () => {
      const died = killed
      killed = false
      return died
    },
    takeTeleport: () => {
      const to = teleport
      teleport = null
      return to
    },
    progress: () => -1,
  }
}
