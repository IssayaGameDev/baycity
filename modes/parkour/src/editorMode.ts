import { DEFAULT_TUNING, createLocomotion } from '@mp/humanoid'
import { Bumper, Checkpoint, Death, Goal, Hazard } from '@mp/components'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { PARKOUR_REGISTRY, STAND_OFFSET, parkourSession, spawnOf } from './rules'

/**
 * Parkour as the platform sees it (ADR 0052) — what a tool loads to author or play-test a parkour level.
 *
 * Separate from `rules.ts`, which stays headless: this file names gizmo colours, so it reaches into the
 * renderer's debug palette and could not live beside logic a bot has to be able to run.
 *
 * **The whole file is the contract.** Adding a game means writing one of these, not editing the editor or
 * anything under `packages/`. That is what dependency law 3 asks for, and what the editor's hardcoded
 * `DEFAULT_REGISTRY` and hardcoded checkpoint progression made impossible.
 */
export const PARKOUR_MODE: ModeDescriptor = {
  name: 'parkour',
  label: 'Parkour',
  registry: PARKOUR_REGISTRY,
  tuning: DEFAULT_TUNING,
  standOffset: STAND_OFFSET,
  /**
   * Which colour a tool draws over each rule's node.
   *
   * The game's table, not the renderer's: `MARKER_COLORS` covers exactly these four because they were the only
   * rules that existed, so a new game's rule could not have got a marker at all. The palette stays shared so
   * two games' checkpoints look alike, but the mapping is each game's own.
   */
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
   * choice** rather than something every game runs. Swapping it out is how a game gets different mechanics and not just different numbers.
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
  session: parkourSession,
}
