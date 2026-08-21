import { DEFAULT_TUNING } from '@mp/character'
import { Bumper, Checkpoint, Goal, Hazard } from '@mp/components'
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
  spawn: spawnOf,
  session: parkourSession,
}
