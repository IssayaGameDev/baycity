import { Death, Hazard } from '@mp/components'
import { DEFAULT_TUNING, createLocomotion, type CharacterTuning } from '@mp/humanoid'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { KEYBOARD_REGISTRY, keyboardSession, spawnOf } from './rules'
import { WinsPad } from './wins'

/** Live, shared between the descriptor, the debug pane and `main.ts`'s per-frame Max Speed write. */
export const keyboardTuning: CharacterTuning = { ...DEFAULT_TUNING }

/**
 * Keyboard Escape, as the tools see it (ADR 0052, ADR 0065).
 *
 * A clone of Roblox's `+1 Speed Keyboard Escape`, which is an **incremental simulator** wearing an obby's
 * clothes: every step earns Experience, Experience buys Levels, and a Level raises the speed cap. The tension
 * is that being fast also makes the character hard to steer.
 *
 * The game being cloned calls its currency "Speed". Here it is **Experience**, so that "speed" means the one
 * thing that is a velocity (ADR 0071).
 *
 * `registry` carries `Keyboard`, which is what makes a platform's top face a board of keys (ADR 0069), and
 * `WinsPad`, which ends a stage (ADR 0073). Nothing about the *look* of the keys is here: it is not a rule, not
 * level content and not something a tool needs, so it is wired in `main.ts` against `@mp/tps`'s scene handle.
 */
export const KEYBOARD_MODE: ModeDescriptor = {
  name: 'keyboard',
  label: 'Keyboard',
  registry: KEYBOARD_REGISTRY,
  /**
   * This game's live tuning, and **`moveSpeed` is Level's to write** (ADR 0071).
   *
   * Its own object rather than `DEFAULT_TUNING` because `main.ts` sets `moveSpeed` from Max Speed every frame,
   * and writing into the shared default would change every other game in the build.
   *
   * The debug pane binds this same object, so its `move speed` slider is the one control here that does
   * nothing — Level overwrites it on the next frame. Every other slider still works, and one dead slider beats
   * two owners quietly fighting over one field (ADR 0057).
   *
   * `groundAccelTime`, `groundStopTime` and `airControl` stay fixed on purpose: leaving them alone while
   * `moveSpeed` climbs is what makes a fast character floaty and hard to turn, which is the game's skill curve.
   */
  tuning: keyboardTuning,
  /**
   * The palette is shared so two games' hazards look alike; the mapping is each game's own. A `WinsPad` is
   * where a stage ends, which is what the shared palette calls a goal.
   */
  gizmos: { [Hazard.type]: MARKER_COLORS.hazard, [WinsPad.type]: MARKER_COLORS.goal },
  /** No abilities of its own yet — the shipped locomotion, whose `moveSpeed` Level writes. */
  player: [
    { id: 'loco', type: 'Locomotion', params: {} },
    { id: 'death', type: Death.type, params: {} },
  ],
  playerDefs: (host) => [createLocomotion(host)],
  spawn: spawnOf,
  session: keyboardSession,
}
