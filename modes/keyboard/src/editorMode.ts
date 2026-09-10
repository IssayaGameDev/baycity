import { Death, Hazard } from '@mp/components'
import { DEFAULT_TUNING, createLocomotion } from '@mp/humanoid'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { KEYBOARD_REGISTRY, keyboardSession, spawnOf } from './rules'
import { WinsPad } from './wins'

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
   * The **starting** tuning. `moveSpeed` here is what you run at before the first frame writes Max Speed into
   * the client's live copy (`client.tuning`, ADR 0071) — the client copies this object on the way in
   * (ADR 0057), so nothing written here after startup reaches the character.
   *
   * `groundAccelTime`, `groundStopTime` and `airControl` are times and ratios, so they scale with `moveSpeed`:
   * left alone, a character at 30 m/s steers exactly like one at 5 — total control, no momentum. The two caps
   * (m/s², ADR 0078) are what stop that: below a cap nothing changes, above it reversing takes `speed / cap`
   * seconds and a turn at speed is an arc. Ground high for snap, air low for momentum — one cap for both made
   * the ground heavy. First values; the Progression folder has both sliders.
   */
  tuning: { ...DEFAULT_TUNING, groundMaxAccel: 150, airMaxAccel: 40 },
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
