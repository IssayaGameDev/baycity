import { quat, vec3, type Quat, type Vec3 } from '@mp/core'

import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from './character'

/**
 * Blocky character rig — 10 rigid parts, no skinning, no art (Kodjo's call). Geometry is data here
 * and realized by a renderer (`@mp/render-three`), the same split `@mp/content` uses for levels.
 *
 * Everything is expressed in **root space, origin at the capsule's centre**, because that is what
 * the simulation reports as the character's position. Feet therefore sit at `-(halfHeight + radius)`
 * and the total height matches the collider exactly — the visual cannot drift from what collides.
 */
export const CHAR_HEIGHT = (CHAR_HALF_HEIGHT + CHAR_RADIUS) * 2 // 2.0 m
export const CHAR_WIDTH = CHAR_RADIUS * 2 // 0.8 m
/** Root-space y of the sole. */
export const FOOT_Y = -(CHAR_HALF_HEIGHT + CHAR_RADIUS)

export type PartName =
  | 'body'
  | 'head'
  | 'upperArmL'
  | 'lowerArmL'
  | 'upperArmR'
  | 'lowerArmR'
  | 'upperLegL'
  | 'lowerLegL'
  | 'upperLegR'
  | 'lowerLegR'

export interface RigPart {
  /** Parent part, or `null` for the root-attached body. */
  parent: PartName | null
  /** Joint position, relative to the parent's joint (root space when `parent` is null). */
  pivot: Vec3
  /** Box dimensions. */
  size: Vec3
  /**
   * Where the box sits relative to its joint. Limbs hang downward from their joint, so this is
   * `-size.y / 2` on y — which is what makes setting a joint rotation swing the limb rather than
   * spin it about its middle.
   */
  meshOffset: Vec3
  style: 'skin' | 'shirt' | 'trousers'
}

// Proportions: head 0.5 + torso 0.75 + leg 0.75 = 2.0 m, matching the capsule. Shoulders span
// 0.5 torso + 2 x 0.15 arm = 0.8 m, matching its diameter.
const TORSO_H = 0.75
const HEAD = 0.5
const LIMB = 0.375 // each half of an arm or leg
const HIP_Y = FOOT_Y + LIMB * 2 // -0.25
const SHOULDER_Y = HIP_Y + TORSO_H - 0.1

const arm = (side: -1 | 1): Record<string, RigPart> => {
  const s = side === -1 ? 'L' : 'R'
  return {
    [`upperArm${s}`]: {
      parent: 'body',
      pivot: vec3(side * 0.325, SHOULDER_Y - HIP_Y, 0),
      size: vec3(0.15, LIMB, 0.15),
      meshOffset: vec3(0, -LIMB / 2, 0),
      style: 'skin',
    },
    [`lowerArm${s}`]: {
      parent: `upperArm${s}` as PartName,
      pivot: vec3(0, -LIMB, 0),
      size: vec3(0.15, LIMB, 0.15),
      meshOffset: vec3(0, -LIMB / 2, 0),
      style: 'skin',
    },
  }
}

const leg = (side: -1 | 1): Record<string, RigPart> => {
  const s = side === -1 ? 'L' : 'R'
  return {
    [`upperLeg${s}`]: {
      parent: 'body',
      pivot: vec3(side * 0.14, 0, 0), // body's joint is the hip line
      size: vec3(0.2, LIMB, 0.2),
      meshOffset: vec3(0, -LIMB / 2, 0),
      style: 'trousers',
    },
    [`lowerLeg${s}`]: {
      parent: `upperLeg${s}` as PartName,
      pivot: vec3(0, -LIMB, 0),
      size: vec3(0.2, LIMB, 0.2),
      meshOffset: vec3(0, -LIMB / 2, 0),
      style: 'trousers',
    },
  }
}

// Insertion order is load-bearing: a renderer walks it once and needs every part's parent to
// already exist, so the body comes first and each limb's upper half precedes its lower.
const PARTS: Record<string, RigPart> = {
  // Body's joint is the hip line, so a bob or lean moves the hips and the legs' IK absorbs it.
  body: { parent: null, pivot: vec3(0, HIP_Y, 0), size: vec3(0.5, TORSO_H, 0.3), meshOffset: vec3(0, TORSO_H / 2, 0), style: 'shirt' },
  head: { parent: 'body', pivot: vec3(0, TORSO_H, 0), size: vec3(HEAD, HEAD, HEAD), meshOffset: vec3(0, HEAD / 2, 0), style: 'skin' },
  ...arm(-1),
  ...arm(1),
  ...leg(-1),
  ...leg(1),
}

/** The rig, as data. A renderer builds one nested node per entry and poses it by joint rotation. */
export const RIG = PARTS as Record<PartName, RigPart>

export const PART_NAMES = Object.keys(RIG) as PartName[]

/** Segment lengths the pose solver's two-bone IK works with. */
export const LIMB_LENGTH = LIMB
/** Hip joint height in root space — where the legs hang from before any bob. */
export const HIP_HEIGHT = HIP_Y

/** One frame of animation: the character's facing, each joint's local rotation, and a body offset
 * for bob and crouch. Everything a renderer needs, with no renderer types in it. */
export interface Pose {
  yaw: number
  rotation: Record<PartName, Quat>
  bodyOffset: Vec3
}

export const restPose = (): Pose => ({
  yaw: 0,
  rotation: Object.fromEntries(PART_NAMES.map((n) => [n, quat()])) as Record<PartName, Quat>,
  bodyOffset: vec3(0, 0, 0),
})
