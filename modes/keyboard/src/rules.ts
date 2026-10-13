import { LOCOMOTION_DEF, CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/humanoid'
import { createRegistry, componentOn, ENGINE_COMPONENTS, PLAYER_COMPONENTS, sharedComponents } from '@mp/components'
import type { LoadedLevel, WorldNode } from '@mp/content'
import { spawnFrom, type ModeSession, type ModeSessionOptions, type Teleport } from '@mp/mode'

import { Keyboard } from './components/keyboard'
import { keyGeometryFrom, type KeyGeometry } from './keycaps'
import { StepPad, type StepPadOffer } from './components/stepPad'
import { Obstacle } from './components/obstacle'
import { StageGate } from './components/stageGate'
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
 * add to it when a level here needs a `Bumper` or a `Checkpoint` the game did not have yet.
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

export const KEYBOARD_REGISTRY = createRegistry([...ENGINE_COMPONENTS, ...PLAYER_COMPONENTS, LOCOMOTION_DEF, STEPPER_DEF, Keyboard, WinsPad, Treadmill, StepPad, StageGate, Obstacle, ...sharedComponents(game.components)])

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
  /** Standing on a `Treadmill` this tick (ADR 0080). Once per tick, for as long as you stand there. */
  readonly onTreadmill?: (on: TreadmillTick) => void
  /** Standing on a `StepPad` this tick (ADR 0082): what it offers. The game holds the Wins and decides. */
  readonly onStepPad?: (offer: StepPadOffer, node: WorldNode) => void
  /**
   * A teleport the game asks for — the teleport window, to a stage gate or the start (ADR 0202). Asked when the
   * host takes a teleport and nothing of the rules' own is waiting; it hands its request over once.
   */
  readonly requested?: () => Teleport | null
  /**
   * An `Obstacle`'s trigger was walked into (ADR 0211): its checkpoint is reached. Every tick spent inside it; the
   * game saves it once.
   */
  readonly onReached?: (node: WorldNode) => void
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
export const keyboardSession = (loaded: LoadedLevel, opts: KeyboardSessionOptions = {}): ModeSession => {
  const spawn = spawnOf(loaded)
  let killed = false
  /** Where the next tick should put us, or `null`. Set by a pad, cleared by the host reading it. */
  let teleport: Teleport | null = null
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
        opts.onCashOut?.(pad.wins, node)
      },
    },
    respawnAt: () => spawn,
    takeDeath: () => {
      const died = killed
      killed = false
      return died
    },
    // A cash-out first; a request waits for the tick after, rather than being lost under it.
    takeTeleport: () => {
      const to = teleport ?? opts.requested?.() ?? null
      teleport = null
      return to
    },
    progress: () => -1,
  }
}
