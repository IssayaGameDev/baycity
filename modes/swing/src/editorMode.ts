import { DEFAULT_TUNING } from '@mp/character'
import { Bumper, Checkpoint, Goal, Hazard } from '@mp/components'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { STAND_OFFSET, SWING_REGISTRY, spawnOf, swingSession } from './rules'

/**
 * Swing, as the platform sees it (ADR 0052) — and the whole of what it contributes.
 *
 * The second game on the platform, and the thing that proved the client is a package: it was made by copying
 * `modes/_template`, renaming three identifiers and pointing a level at it. The character controller, its
 * procedural animation, the camera, the netcode and the editor all came for free.
 *
 * Nothing swinging is built yet. `registry` is where its components go, and `session` is where their rules
 * go.
 */
export const SWING_MODE: ModeDescriptor = {
  name: 'swing',
  label: 'Swing',
  registry: SWING_REGISTRY,
  // The shared Roblox-like feel (ADR 0012). A game with a different character overrides these.
  tuning: DEFAULT_TUNING,
  standOffset: STAND_OFFSET,
  /** The palette is shared so two games' checkpoints look alike; the mapping is each game's own. */
  gizmos: {
    [Checkpoint.type]: MARKER_COLORS.checkpoint,
    [Goal.type]: MARKER_COLORS.goal,
    [Hazard.type]: MARKER_COLORS.hazard,
    [Bumper.type]: MARKER_COLORS.bumper,
  },
  spawn: spawnOf,
  session: swingSession,
}
