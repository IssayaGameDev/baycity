import { mulQuat, quat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'

import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from './groundController'

/**
 * **One** skeleton: a blocky biped of 11 rigid parts, no skinning, no art (Kodjo's call). Geometry is data
 * here and realized by a renderer (`@mp/render-three`), the same split `@mp/content` uses for levels.
 *
 * This file was `rig.ts` and this constant is `RIG` — a name that reads as "the rig the platform has"
 * rather than "the one this avatar happens to be" (ADR 0062). `PartName` is a closed union of these eleven,
 * so a differently-shaped avatar is a different rig and not a variation on this one.
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
  | 'chest'
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
/**
 * Height of the waist joint above the hip line — where the torso splits in two. The lower part
 * (`body`) carries the legs, the upper (`chest`) carries the arms and head, so a twist above the waist
 * turns the shoulders while the hips stay square. Without this joint they were the same box, and
 * `torsoTwist` could only turn the whole torso including the hip sockets.
 *
 * 0.3 of 0.75 puts it a little below the middle, roughly at a navel — the same place R15 splits its
 * lower and upper torso. It is geometry rather than feel, so it is a constant and not a gait knob;
 * how much *bending* happens up there is the knob (`spineChestShare`).
 */
const WAIST_Y = 0.3
const BODY_H = WAIST_Y
const CHEST_H = TORSO_H - WAIST_Y

const arm = (side: -1 | 1): Record<string, RigPart> => {
  const s = side === -1 ? 'L' : 'R'
  return {
    [`upperArm${s}`]: {
      parent: 'chest',
      pivot: vec3(side * 0.325, SHOULDER_Y - HIP_Y - WAIST_Y, 0),
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
// already exist, so the torso comes first, chest before head and arms, and each limb's upper half
// precedes its lower.
const PARTS: Record<string, RigPart> = {
  // Body's joint is the hip line, so a bob or lean moves the hips and the legs' IK absorbs it. It is
  // the lower torso: the legs hang off it, and it ends at the waist.
  body: { parent: null, pivot: vec3(0, HIP_Y, 0), size: vec3(0.5, BODY_H, 0.3), meshOffset: vec3(0, BODY_H / 2, 0), style: 'shirt' },
  // Upper torso, hinged at the waist. Arms and head hang off this, so anything it does they inherit —
  // which is the point of the split: shoulders that can turn without taking the hips with them.
  chest: { parent: 'body', pivot: vec3(0, WAIST_Y, 0), size: vec3(0.5, CHEST_H, 0.3), meshOffset: vec3(0, CHEST_H / 2, 0), style: 'shirt' },
  head: { parent: 'chest', pivot: vec3(0, CHEST_H, 0), size: vec3(HEAD, HEAD, HEAD), meshOffset: vec3(0, HEAD / 2, 0), style: 'skin' },
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

/** One frame of animation: the character's facing, each joint's local rotation, and translations for
 * the two joints that need one. Everything a renderer needs, with no renderer types in it. */
export interface Pose {
  yaw: number
  rotation: Record<PartName, Quat>
  bodyOffset: Vec3
  /**
   * Each joint's translation away from its pivot, in the **parent's** frame — the frame a joint's
   * position lives in. Secondary motion needs parts to *move*, not only to turn: a rotation cannot
   * express a head lagging a bob or an arm still arriving after the body has stopped.
   *
   * Two groups are permanently zero. The body's travel is `bodyOffset`, which the leg IK is solved
   * against; and the four leg parts' feet are planted, so anything that moved them would slide them.
   */
  jointOffset: Record<PartName, Vec3>
}

/** Where a part's **box** sits in the world: the centre of the drawn solid, and its orientation. */
export interface PartTransform {
  position: Vec3
  rotation: Quat
}

/**
 * Forward-kinematic the whole rig: the world transform of every part's box under `pose`, for a
 * character rooted at `origin`.
 *
 * This is the same walk a renderer does — pivot, offsets, parent rotation, then `meshOffset` to reach
 * the box's centre rather than its joint — pulled out because a ragdoll needs it too. A death has to
 * hand one rigid body per part the exact pose the animated rig was in, or the parts jump at the moment of
 * transition. Kept here with the rig data rather than in a renderer so it stays headless and testable.
 *
 * Parts come out in `PART_NAMES` order, which lists every parent before its children, so one pass
 * suffices.
 */
export const partTransforms = (pose: Pose, origin: Vec3): Record<PartName, PartTransform> => {
  const rootQ = quatFromY(pose.yaw)
  const jointPos = {} as Record<PartName, Vec3>
  const jointRot = {} as Record<PartName, Quat>
  const out = {} as Record<PartName, PartTransform>
  for (const name of PART_NAMES) {
    const part = RIG[name]
    const parent = part.parent
    const parentPos = parent === null ? origin : jointPos[parent]
    const parentRot = parent === null ? rootQ : jointRot[parent]
    // The body carries `bodyOffset` on top of its `jointOffset`; every other part has only the latter.
    const extra = pose.jointOffset[name]
    const bob = name === 'body' ? pose.bodyOffset : ZERO
    const local = vec3(part.pivot.x + extra.x + bob.x, part.pivot.y + extra.y + bob.y, part.pivot.z + extra.z + bob.z)
    const moved = rotateVec3(parentRot, local)
    const pos = vec3(parentPos.x + moved.x, parentPos.y + moved.y, parentPos.z + moved.z)
    const rot = mulQuat(parentRot, pose.rotation[name])
    jointPos[name] = pos
    jointRot[name] = rot
    const centre = rotateVec3(rot, part.meshOffset)
    out[name] = { position: vec3(pos.x + centre.x, pos.y + centre.y, pos.z + centre.z), rotation: rot }
  }
  return out
}

const ZERO = vec3(0, 0, 0)
const quatFromY = (yaw: number): Quat => quat(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2))

export const restPose = (): Pose => ({
  yaw: 0,
  rotation: Object.fromEntries(PART_NAMES.map((n) => [n, quat()])) as Record<PartName, Quat>,
  bodyOffset: vec3(0, 0, 0),
  jointOffset: Object.fromEntries(PART_NAMES.map((n) => [n, vec3(0, 0, 0)])) as Record<PartName, Vec3>,
})
