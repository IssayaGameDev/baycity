import { DEFAULT_TUNING } from '@mp/character'
import { Bumper, Checkpoint, Death, Goal, Hazard } from '@mp/components'
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
  /**
   * The player's own components (ADR 0059) — what this game gives whoever is playing, as opposed to what a
   * level authors. Swing is the newer game and the place to try one.
   *
   * `Death` is data the client reads: whether the rig falls apart, and the timing of it dropping back in.
   * Its defaults are what the client hardcoded for every game, so declaring it changes nothing until a
   * parameter is changed.
   */
  player: [{ id: 'death', type: Death.type, params: {} }],
  spawn: spawnOf,
  session: swingSession,
}
