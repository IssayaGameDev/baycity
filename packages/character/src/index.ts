/**
 * @mp/character — kinematic character-controller library (stack-level, mode-agnostic).
 * Roblox-like locomotion; feel is data. Run by each client for its own body and by
 * bots. See ADR 0012 (controller) and the content-pipeline ADR (layering).
 */
export const CHARACTER_VERSION = '0.0.0' as const

export type { CharacterTuning, CharacterState, MovementBase, PlatformFrame, PlatformPoseLookup } from './character'

// Blocky 10-part rig + procedural animation (no skinning, no art).
export type { PartName, RigPart, Pose, PartTransform } from './rig'
export { RIG, PART_NAMES, CHAR_HEIGHT, CHAR_WIDTH, FOOT_Y, HIP_HEIGHT, LIMB_LENGTH, restPose, partTransforms } from './rig'
export type { AnimationInput, GaitTuning, Animator } from './animate'
export { createAnimator, solveTwoBone, DEFAULT_GAIT } from './animate'
export {
  TICK_RATE_HZ,
  TICK_DT,
  CHAR_RADIUS,
  CHAR_HALF_HEIGHT,
  DEFAULT_TUNING,
  playerSpawn,
  addCharacter,
  stepCharacter,
} from './character'
