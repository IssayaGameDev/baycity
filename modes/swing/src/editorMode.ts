import { DEFAULT_TUNING, createLocomotion } from '@mp/humanoid'
import { Bumper, Checkpoint, Death, Goal, Hazard } from '@mp/components'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { SWING_REGISTRY, spawnOf, swingSession } from './rules'

/**
 * Swing, as the platform sees it (ADR 0052) — and the whole of what it contributes.
 *
 * The second game on the platform, and the thing that proved the client is a package: it was made by copying
 * `modes/_template`, renaming three identifiers and pointing a level at it. The character controller, its
 * procedural animation, the camera, the netcode and the editor all came for free.
 *
 * The swing itself is in `swing.ts` and `rope.ts`, wired in `main.ts` — not here, because none of it is
 * something a *tool* needs (ADR 0065): the editor authors levels and play-tests them, and the rope is neither
 * a level's content nor a rule. What is here is the one part the editor does need, the key binding, so a
 * play-test holds the rope with the same key the game does (ADR 0061).
 */
export const SWING_MODE: ModeDescriptor = {
  name: 'swing',
  label: 'Swing',
  registry: SWING_REGISTRY,
  /**
   * Hold to swing (ADR 0067). Two codes, so it is the same gesture on either side of the keyboard.
   *
   * Held rather than toggled: letting go releases the rope with the momentum you had, the release timing is the
   * skill, and nothing can get stuck attached. The name is this game's and the platform never learns it —
   * `actionsHeld` maps the codes, and `createSwing` reads back the name it declared.
   */
  actions: { swing: ['ShiftLeft', 'ShiftRight'] },
  // The shared Roblox-like feel (ADR 0012). A game with a different character overrides these.
  tuning: DEFAULT_TUNING,
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
    /**
     * **`Swing`, not `Locomotion`** — this game's movement *is* the swing (ADR 0067).
     *
     * These two lists have to agree: this one says which components the player carries, and `playerDefs` below
     * says what those types mean. Leaving `Locomotion` here while `playerDefs` supplied `Swing` gave a
     * character that could turn on the spot and not move: the declared type had no definition, and the supplied
     * definition had no instance.
     */
    { id: 'swing', type: 'Swing', params: {} },
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
