import { DEFAULT_TUNING, createLocomotion } from '@mp/humanoid'
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
   * The player's own components (ADR 0059, ADR 0061).
   *
   * `Locomotion` is the stack's `stepCharacter` wearing a component, which is what makes it **this game's
   * choice** rather than something every game runs. Swing is the newer game and the place to try a different one.
   *
   * `Death` is data the client reads: whether the rig falls apart, and the timing of it dropping back in.
   * Both default to exactly what the client hardcoded, so declaring them changed nothing.
   */
  player: [
    { id: 'loco', type: 'Locomotion', params: {} },
    { id: 'death', type: Death.type, params: {} },
  ],
  /**
   * Built per session, closing over the live character (ADR 0061) — it does not exist when the registry is.
   * A game with its own movement returns its own definition here and the platform is none the wiser.
   */
  playerDefs: (host) => [createLocomotion(host)],
  spawn: spawnOf,
  session: swingSession,
}
