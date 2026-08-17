import { axisAngleToQuat, clamp, vec3, type Vec3 } from '@mp/core'

import { FOOT_Y, HIP_HEIGHT, LIMB_LENGTH, restPose, type PartName, type Pose } from './rig'

/**
 * Procedural character animation — no clips, no skinning, no art. Pure math: it takes what the
 * game knows about a character this frame and returns joint rotations, so it is unit-testable
 * headlessly and a renderer only has to apply the result.
 *
 * Three things make it read as smooth rather than as a loop being played:
 *
 * 1. **Stride phase advances with distance travelled, not with time.** Feet then plant correctly at
 *    any speed with no per-speed tuning, and it stays right while riding a moving platform.
 * 2. **Feet are placed, not posed.** The foot follows a parametric path and a closed-form two-bone
 *    solve derives hip and knee. Controlling the foot is what removes skating by construction; the
 *    alternative — hand-tuned joint curves — only shrinks it.
 * 3. **Every driven value passes through a half-life smoother**, which is frame-rate independent.
 *    The view this replaces eased facing by a fixed fraction *per frame*, so it smoothed faster at
 *    144 fps than at 60.
 */
export interface AnimationInput {
  /** Root position (capsule centre) this frame. */
  position: Vec3
  /** Facing target, radians. Movement direction — the controller has no independent aim. */
  yaw: number
  /** Planar speed, m/s, **excluding** any platform carrying the character. */
  speed: number
  grounded: boolean
  rising: boolean
}

export interface GaitTuning {
  /** Stride length at walking pace (m) — one full cycle covers two of these. */
  strideWalk: number
  /** Stride length at top speed (m). */
  strideRun: number
  /** Speed at which `strideRun` is reached (m/s). */
  runSpeed: number
  /** Peak foot lift during swing (m). */
  footLift: number
  /** Vertical bob amplitude at top speed (m). */
  bob: number
  /** Forward lean at top speed (radians). */
  lean: number
  /** Arm swing amplitude at top speed (radians). */
  armSwing: number
  /** Half-life of the facing smoother (s). */
  yawHalfLife: number
  /** Half-life of the gait/air blend smoothers (s). */
  blendHalfLife: number
  /** Knee bend depth on landing (radians) at the reference impact speed. */
  landCrouch: number
}

export const DEFAULT_GAIT: GaitTuning = {
  strideWalk: 0.9,
  strideRun: 1.7,
  runSpeed: 5.5,
  footLift: 0.28,
  bob: 0.06,
  lean: 0.16,
  armSwing: 0.9,
  yawHalfLife: 0.06,
  blendHalfLife: 0.08,
  landCrouch: 0.5,
}

export interface Animator {
  /** Advance and return this frame's pose. Call once per rendered frame. */
  step: (input: AnimationInput, dt: number) => Pose
}

const TAU = Math.PI * 2
const LN2 = Math.LN2

/** Frame-rate-independent smoothing: `cur` moves half the remaining distance every `halfLife`. */
const smooth = (cur: number, target: number, dt: number, halfLife: number): number =>
  halfLife <= 0 ? target : target + (cur - target) * Math.exp((-dt * LN2) / halfLife)

/** Shortest-arc version of the same, for angles. */
const smoothAngle = (cur: number, target: number, dt: number, halfLife: number): number => {
  let d = ((target - cur + Math.PI) % TAU) - Math.PI
  if (d < -Math.PI) d += TAU
  return smooth(cur, cur + d, dt, halfLife)
}

/**
 * Two-bone IK in the sagittal plane. Given a target `forward`/`up` offset from the joint, returns
 * the parent and child pitch that put the tip there. Closed form — the law of cosines — so there is
 * no solver, no iteration, and no failure mode beyond an unreachable target, which is clamped.
 *
 * Angles are pitch about the local X axis: positive swings the limb's tip forward (+z).
 */
export const solveTwoBone = (forward: number, up: number, a: number, b: number, bendForward: boolean): { parent: number; child: number } => {
  const reach = Math.hypot(forward, up)
  const d = clamp(reach, Math.abs(a - b) + 1e-4, a + b - 1e-4)
  // Interior angle at the middle joint, then the offset between the limb's chord and its first bone.
  const kneeInterior = Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1))
  const offset = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1))
  // Direction of the chord, measured as pitch from straight down.
  const chord = Math.atan2(forward, -up)
  const bend = Math.PI - kneeInterior
  return bendForward
    ? { parent: chord + offset, child: -bend }
    : { parent: chord - offset, child: bend }
}

/** Foot target for one leg, in the character's local frame (x = right, z = forward, y = up). */
const footTarget = (phase: number, stride: number, lift: number, groundY: number): { forward: number; y: number } => {
  const p = ((phase % 1) + 1) % 1
  if (p < 0.5) {
    // Stance: the foot is planted, so it travels backward under the character at a constant rate.
    const t = p / 0.5
    return { forward: stride / 2 - stride * t, y: groundY }
  }
  // Swing: forward again, lifted through an arc that starts and ends on the ground.
  const t = (p - 0.5) / 0.5
  return { forward: -stride / 2 + stride * t, y: groundY + Math.sin(t * Math.PI) * lift }
}

export const createAnimator = (tuning: GaitTuning = DEFAULT_GAIT): Animator => {
  const pose = restPose()
  let phase = 0
  let yaw = 0
  let airBlend = 0
  let crouch = 0
  let prev: Vec3 | null = null
  let wasGrounded = true
  let lastSpeed = 0

  /**
   * Pitch a part that extends **upward** from its joint (body, head). A rotation about +x carries
   * its top toward +z, so positive leans forward.
   */
  const setUprightPitch = (part: PartName, forward: number): void => {
    pose.rotation[part] = axisAngleToQuat(vec3(1, 0, 0), forward)
  }

  /**
   * Pitch a part that hangs **downward** from its joint (every arm and leg segment). The same
   * rotation carries its tip toward *−z*, so the sign flips. Sharing one helper between the two
   * kinds is what produced a moonwalk: the legs swung backward while the character moved forward,
   * and the planted foot slid along at twice its speed.
   */
  const setLimbPitch = (part: PartName, forward: number): void => {
    pose.rotation[part] = axisAngleToQuat(vec3(1, 0, 0), -forward)
  }

  return {
    step: (input, dt) => {
      const speed = Math.max(0, input.speed)
      const t = tuning.runSpeed > 0 ? clamp(speed / tuning.runSpeed, 0, 1) : 0
      const stride = tuning.strideWalk + (tuning.strideRun - tuning.strideWalk) * t

      // --- phase from distance, not time -------------------------------------------------
      // Horizontal distance actually covered this frame. Using the position delta rather than
      // `speed * dt` means a character carried by a platform does not accrue stride while standing
      // still on it, as long as the caller reports locomotion speed rather than world speed.
      if (prev !== null && input.grounded) {
        const moved = Math.hypot(input.position.x - prev.x, input.position.z - prev.z)
        // One cycle is two strides (left then right).
        if (stride > 0) phase += Math.min(moved, speed * dt * 1.5) / (stride * 2)
      }
      prev = { ...input.position }

      // --- smoothed drivers ---------------------------------------------------------------
      yaw = smoothAngle(yaw, input.yaw, dt, tuning.yawHalfLife)
      airBlend = smooth(airBlend, input.grounded ? 0 : 1, dt, tuning.blendHalfLife)
      // Landing: the impact is the vertical speed lost on touchdown, approximated by how fast the
      // character was descending. Kick the crouch, then let it decay.
      if (input.grounded && !wasGrounded) crouch = 1
      crouch = smooth(crouch, 0, dt, 0.12)
      wasGrounded = input.grounded
      lastSpeed = smooth(lastSpeed, speed, dt, tuning.blendHalfLife)

      // --- blends -------------------------------------------------------------------------
      // Two separate scales, because they must not be the same one. `moveBlend` fades the gait in
      // out of idle and reaches full below walking pace: scaling *foot travel* by speed would make
      // the feet cover less ground than the character does, which is the skating this design exists
      // to prevent. `intensity` scales the flourishes — bob, lean, arm swing — which may grow with
      // speed without affecting where a foot is planted.
      const ground0 = 1 - airBlend
      const moveBlend = clamp(lastSpeed / 1.2, 0, 1) * ground0
      const intensity = clamp(lastSpeed / tuning.runSpeed, 0, 1) * ground0

      // --- body ---------------------------------------------------------------------------
      // Bob peaks twice per cycle (once per footfall).
      const bob = -Math.abs(Math.sin(phase * TAU)) * tuning.bob * intensity
      const crouchDrop = -crouch * tuning.landCrouch * 0.25
      pose.bodyOffset = vec3(0, bob + crouchDrop, 0)
      setUprightPitch('body', tuning.lean * intensity + crouch * 0.15)
      setUprightPitch('head', -tuning.lean * intensity * 0.7) // hold the head level against the lean

      // --- legs ---------------------------------------------------------------------------
      // Vertical budget for the IK: hip height *after* the body has moved, down to the sole. A bob
      // lowers the hip, so the leg has to shorten — adding the offset instead of subtracting it
      // pushes the target past the leg's reach and drives the foot through the floor.
      const hipToFoot = HIP_HEIGHT + pose.bodyOffset.y - FOOT_Y
      for (const side of [-1, 1] as const) {
        const s = side === -1 ? 'L' : 'R'
        const legPhase = phase + (side === -1 ? 0 : 0.5)
        const gait = footTarget(legPhase, stride, tuning.footLift, 0)
        // Ground gait, and an airborne tuck, blended.
        const airTuck = { forward: side === -1 ? 0.12 : -0.05, y: 0.34 }
        const forward = gait.forward * moveBlend + airTuck.forward * airBlend
        const lift = gait.y * moveBlend + airTuck.y * airBlend
        // `bendForward: true` puts the thigh ahead of the chord and the shin behind it — a human
        // knee. The other branch is the same length solution mirrored, and walks on bird legs.
        const { parent, child } = solveTwoBone(forward, -(hipToFoot - lift), LIMB_LENGTH, LIMB_LENGTH, true)
        setLimbPitch(`upperLeg${s}` as PartName, parent)
        setLimbPitch(`lowerLeg${s}` as PartName, child)
      }

      // --- arms ---------------------------------------------------------------------------
      // Opposite the legs, and raised forward while airborne.
      for (const side of [-1, 1] as const) {
        const s = side === -1 ? 'L' : 'R'
        const swing = Math.sin((phase + (side === -1 ? 0.5 : 0)) * TAU) * tuning.armSwing * intensity
        setLimbPitch(`upperArm${s}` as PartName, swing + airBlend * 2.1)
        setLimbPitch(`lowerArm${s}` as PartName, Math.abs(swing) * 0.35 + airBlend * 0.6)
      }

      pose.yaw = yaw
      return pose
    },
  }
}
