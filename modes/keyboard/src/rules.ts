import { LOCOMOTION_DEF, CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/humanoid'
import { createRegistry, componentOn, ENGINE_COMPONENTS, PLAYER_COMPONENTS, sharedComponents } from '@mp/components'
import type { LoadedLevel, WorldNode } from '@mp/content'
import { spawnFrom, type ModeSession, type ModeSessionOptions, type Teleport } from '@mp/mode'

import { Keyboard } from './components/keyboard'
import { keyGeometryFrom, type KeyGeometry } from './keycaps'
import { StepPad, type StepPadOffer } from './components/stepPad'
import { Obstacle } from './components/obstacle'
import { STEPPER_DEF } from './components/steps'
import { Treadmill, type TreadmillTick } from './components/treadmill'
import { WinsPad } from './components/wins'
import game from '@content/keyboard/game.json'

import { curveFrom, type ProgressCurve } from './progression'

/**
 * Keyboard Escape's rules: spawn, die, and cash out.
 *
 * Headless on purpose: no renderer, no persistence, no DOM. That is what lets the editor play-test a game by
 * running these rather than a second hand-written copy of them (ADR 0052), and it is the property a new game
 * most easily loses by reaching for a package it does not need.
 */

/**
 * What this game's levels may contain (ADR 0077): the engine's components, the player's, this game's own code
 * components, and **the shared components named in `content/keyboard/game.json`** — a data file, so the editor can
 * add to it when a level here needs a `Bumper` the game did not have yet.
 */
/** The curve as `content/keyboard/game.json` sets it (ADR 0087) — what the game and the editor's play run on. */
export const GAME_CURVE: ProgressCurve = curveFrom((game as { settings?: unknown }).settings)

/**
 * The key geometry the whole game shares (ADR 0115), from the same settings file.
 *
 * One pitch for the level, not one per platform: a level is thousands of platforms, and two that disagree
 * about the pitch cannot align however the grid is anchored. A number the file has not set falls back to the
 * declared default.
 */
export const GAME_KEYS: KeyGeometry = keyGeometryFrom((game as { settings?: Record<string, unknown> }).settings)

export const KEYBOARD_REGISTRY = createRegistry([...ENGINE_COMPONENTS, ...PLAYER_COMPONENTS, LOCOMOTION_DEF, STEPPER_DEF, Keyboard, WinsPad, Treadmill, StepPad, Obstacle, ...sharedComponents(game.components)])

/** How far above a spawn node the character's origin sits — half the capsule, plus its cap. */
export const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS

/**
 * Where a player starts: the level's spawn marker, or above the origin if it has none.
 *
 * The placement itself is shared (`@mp/mode`) — it was the same function in every game. What is this game's
 * is the stand-off height, which is its character's, not the platform's.
 */
export const spawnOf = spawnFrom(STAND_OFFSET)

/** A teleport the game asks for, and the checkpoint it lands on — `null` for Start (ADR 0212). */
export interface KeyboardTeleport extends Teleport {
  readonly obstacle?: WorldNode | null
}

/** The shared options, plus the one thing this game's rules report that the platform has no word for. */
export interface KeyboardSessionOptions extends ModeSessionOptions {
  /** A `WinsPad` paid out. The client banks and shows it; the editor's play-test passes nothing. */
  readonly onCashOut?: (wins: number, node: WorldNode) => void
  /** Standing on a `Treadmill` this tick (ADR 0080). Once per tick, for as long as you stand there. */
  readonly onTreadmill?: (on: TreadmillTick) => void
  /** Standing on a `StepPad` this tick (ADR 0082): what it offers. The game holds the Wins and decides. */
  readonly onStepPad?: (offer: StepPadOffer, node: WorldNode) => void
  /**
   * A teleport the game asks for — the teleport window, to a checkpoint or the start (ADR 0202). Asked when the
   * host takes a teleport and nothing of the rules' own is waiting; it hands its request over once.
   */
  readonly requested?: () => KeyboardTeleport | null
  /**
   * An `Obstacle`'s trigger was walked into (ADR 0211): its checkpoint is reached. Every tick spent inside it; the
   * game saves it once.
   */
  readonly onReached?: (node: WorldNode) => void
  /**
   * Where a respawn — after a death, or the pause menu's Restart — puts the player instead of the spawn, given the
   * obstacle they were on (`null` from the spawn); `null` for the spawn. Keyboard's debug pane only: the game respawns at
   * the spawn (Kodjo's design).
   */
  readonly respawnTo?: (on: WorldNode | null) => KeyboardTeleport | null
}

/** The platform's session, plus what this game's rules know that the platform has no word for. */
export interface KeyboardSession extends ModeSession {
  /**
   * The obstacle the player is on (ADR 0212, Kodjo's call): the node of the last `Obstacle` whose trigger was walked
   * into, or of the checkpoint teleported to. `null` from the spawn — after a death, a cash-out, a respawn or a
   * teleport to Start. The player's own only: it is not sent.
   */
  readonly currentObstacle: () => WorldNode | null
}

/**
 * A session with one rule beyond spawning and dying: **stand on a `WinsPad` and you cash out** — its `wins`
 * are reported, and the next tick puts you back at the spawn (ADR 0073).
 *
 * Falling is also back at the spawn. No checkpoints, nothing locks a stage: `respawnAt` never moves, which is
 * Kodjo's design and the reason a higher speed cap is worth earning.
 *
 * `progress` is always `-1` and `onProgress` is never called, so the client saves nothing through the
 * platform's save shape. Wins, Experience and reached checkpoints are the game's own, saved through its own adapter
 * (`save.ts`).
 */
export const keyboardSession = (loaded: LoadedLevel, opts: KeyboardSessionOptions = {}): KeyboardSession => {
  const spawn = spawnOf(loaded)
  let killed = false
  /** Where the next tick should put us, or `null`. Set by a pad, cleared by the host reading it. */
  let teleport: Teleport | null = null
  /** See `KeyboardSession.currentObstacle`. */
  let current: WorldNode | null = null
  /** The obstacle a death came on, for the respawn after it — the death itself puts `current` back to the spawn. */
  let diedOn: WorldNode | null = null
  return {
    effects: {
      kill: () => {
        killed = true
      },
      // Every contact with a rule-bearing node lands here; only a pad means anything to this game. Standing on
      // one reports every tick, so a cash-out already waiting to be applied is not paid a second time.
      progress: (node) => {
        // An obstacle's trigger (ADR 0211): its checkpoint is reached. Moves nobody.
        if (componentOn(node.components, Obstacle) !== undefined) {
          current = node
          opts.onReached?.(node)
          return
        }
        // A step pad is a stay too (ADR 0082): the offer is reported every tick; the game takes it once.
        const stepPad = componentOn(node.components, StepPad)
        if (stepPad !== undefined) {
          opts.onStepPad?.({ perStep: stepPad.perStep, requiresWins: stepPad.requiresWins }, node)
          return
        }
        // A treadmill is a stay: every tick you stand on it is a report (ADR 0080).
        const mill = componentOn(node.components, Treadmill)
        if (mill !== undefined) {
          opts.onTreadmill?.({ multiplier: mill.multiplier })
          return
        }
        if (teleport !== null) return
        const pad = componentOn(node.components, WinsPad)
        if (pad === undefined) return
        teleport = { position: spawn }
        current = null
        opts.onCashOut?.(pad.wins, node)
      },
    },
    // A respawn and the pause menu's Restart both ask here, and both are back at the spawn — unless the game says
    // otherwise (`respawnTo`), which also turns the player its way, through the next tick's teleport.
    respawnAt: () => {
      const on = diedOn ?? current
      diedOn = null
      const back = opts.respawnTo?.(on) ?? null
      current = back?.obstacle ?? null
      if (back === null) return spawn
      if (teleport === null) teleport = { position: back.position, ...(back.yaw === undefined ? {} : { yaw: back.yaw }) }
      return back.position
    },
    takeDeath: () => {
      const died = killed
      killed = false
      if (died) {
        diedOn = current
        current = null
      }
      return died
    },
    // A cash-out first; a request waits for the tick after, rather than being lost under it.
    takeTeleport: () => {
      if (teleport !== null) {
        const to = teleport
        teleport = null
        return to
      }
      const asked = opts.requested?.() ?? null
      if (asked !== null) current = asked.obstacle ?? null
      return asked
    },
    progress: () => -1,
    currentObstacle: () => current,
  }
}
