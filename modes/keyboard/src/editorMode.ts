import { Death, Hazard } from '@mp/components'
import { DEFAULT_TUNING, createLocomotion } from '@mp/humanoid'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { KEYBOARD_REGISTRY, keyboardSession, spawnOf } from './rules'

/**
 * Keyboard Escape, as the tools see it (ADR 0052, ADR 0065).
 *
 * A clone of Roblox's `+1 Speed Keyboard Escape`, which is an **incremental simulator** wearing an obby's
 * clothes: every step is +1 speed, more speed clears bigger gaps, and the tension is that speed also makes the
 * character hard to steer. None of that is here yet — this slice is the platform-and-keycaps surface only.
 *
 * `registry` carries `Keyboard`, which is what makes a platform's top face a board of keys (ADR 0069). Nothing
 * about the *look* of those keys is here: it is not a rule, not level content and not something a tool needs,
 * so it is wired in `main.ts` against `@mp/tps`'s scene handle.
 */
export const KEYBOARD_MODE: ModeDescriptor = {
  name: 'keyboard',
  label: 'Keyboard',
  registry: KEYBOARD_REGISTRY,
  /**
   * The shipped feel, for now.
   *
   * It will not stay: speed is a **per-player number** in this game, so `moveSpeed` becomes a value that grows
   * from stepping rather than a constant. `groundAccelTime`, `groundStopTime` and `airControl` stay where they
   * are on purpose — leaving them fixed while `moveSpeed` climbs is what makes a fast character floaty and hard
   * to turn, which is the game's whole skill curve.
   */
  tuning: DEFAULT_TUNING,
  /** The palette is shared so two games' hazards look alike; the mapping is each game's own. */
  gizmos: { [Hazard.type]: MARKER_COLORS.hazard },
  /** No abilities of its own yet — the shipped locomotion, until speed drives it. */
  player: [
    { id: 'loco', type: 'Locomotion', params: {} },
    { id: 'death', type: Death.type, params: {} },
  ],
  playerDefs: (host) => [createLocomotion(host)],
  spawn: spawnOf,
  session: keyboardSession,
}
