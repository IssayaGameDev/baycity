/**
 * `@mp/humanoid` — **one** avatar: a blocky eleven-part biped, animated procedurally, moved by a
 * Roblox-like capsule controller for a third-person camera.
 *
 * It was `@mp/character`, and its header said "stack-level, mode-agnostic". It was neither (ADR 0062). Every
 * name in it claimed to be the general case — `rig.ts` was one skeleton, `animate.ts` was one gait,
 * `character.ts` was one ground controller — while ADR 0059 had already decided the platform must not know
 * what a character is made of. A game with no character at all still imported this to find the tick rate.
 *
 * **A game opts in by depending on this package.** Which is the point of the name: parkour and swing want a
 * blocky third-person biped, so they list it; a 2D game or a board game does not, and the platform does not
 * hand them one.
 *
 * Nothing general lives here. `solveTwoBone` has exactly one caller — the gait — and the rig *types*
 * (`Pose`, `RigPart`, `PartTransform`) describe this rig's shape rather than rigs in the abstract. When a
 * second avatar exists, what they share will be obvious; inventing it now would be guessing.
 *
 * See ADR 0012 (the controller), ADR 0018 (the gait), ADR 0061 (locomotion as a component), ADR 0062 (this).
 */
export const HUMANOID_VERSION = '0.0.0' as const

export type { LocomotionDeps } from './locomotion'
export { LOCOMOTION_DEF, createLocomotion } from './locomotion'

export type { CharacterTuning, CharacterState, MovementBase, PlatformFrame, PlatformPoseLookup } from './groundController'

// Blocky 11-part rig + procedural animation (no skinning, no art).
export type { PartName, RigPart, Pose, PartTransform } from './humanoidRig'
export { RIG, PART_NAMES, CHAR_HEIGHT, CHAR_WIDTH, FOOT_Y, HIP_HEIGHT, LIMB_LENGTH, restPose, partTransforms } from './humanoidRig'
export type { AnimationInput, Animator, AnimatorFactory, GaitTuning } from './bipedGait'
export { createAnimator, solveTwoBone, DEFAULT_GAIT } from './bipedGait'
export {
  CHAR_RADIUS,
  CHAR_HALF_HEIGHT,
  DEFAULT_TUNING,
  playerSpawn,
  addCharacter,
  releaseFooting,
  stepCharacter,
} from './groundController'
