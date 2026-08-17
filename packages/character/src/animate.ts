import { axisAngleToQuat, clamp, conjQuat, mulQuat, rotateVec3, vec3, type Vec3 } from '@mp/core'

import { FOOT_Y, HIP_HEIGHT, LIMB_LENGTH, RIG, restPose, type PartName, type Pose } from './rig'

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
  /**
   * World velocity the character is receiving *without* asking for it — a platform carrying it, a
   * piece shoving it, a wall stopping it (`CharacterState.carry`). Omit for none.
   *
   * The inertial layer responds to this signal's **derivative**, so a platform moving at a steady
   * speed produces nothing: standing on a train at line speed feels like standing still, and only
   * the starts, stops and corners are felt.
   */
  carry?: Vec3
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
  /**
   * Constant outward splay of the arms (radians). The default camera sits *behind* the character,
   * where pure forward/back swing is foreshortened to almost nothing — holding the arms off the
   * body is what makes the swing legible from there.
   */
  armOutward: number
  /** Elbow bend held at all times (radians) — a straight arm reads as a mannequin. */
  elbowBase: number
  /** Extra elbow fold as the arm swings forward (radians). */
  elbowFold: number
  /** Shoulders counter-rotating against the hips (radians at top speed). */
  torsoTwist: number

  // --- air pose. Rising and falling are deliberately different shapes: tucked and compact on the
  // way up, extended and reaching on the way down. Both hold the arms well **out to the side**,
  // because the camera sits behind the character and fore/aft motion is foreshortened to nothing
  // from there — the same reason the walk needed a splay.
  /** Arm pitch while rising (radians, forward-positive). */
  airArmRise: number
  /** Arm pitch while falling. */
  airArmFall: number
  /** Outward arm roll while rising. */
  airArmOutRise: number
  /** Outward arm roll while falling — wider, so a descent reads clearly from behind. */
  airArmOutFall: number
  /** Elbow bend while rising (compact). */
  airElbowRise: number
  /** Elbow bend while falling (straighter, reaching for the ground). */
  airElbowFall: number
  /** Foot lift while rising — knees up. */
  airTuckRise: number
  /** Foot lift while falling — legs nearly straight, feeling for the floor. */
  airTuckFall: number

  // --- idle. Standing still is not the absence of animation, it is its own layer, and it runs on a
  // *time* clock rather than the distance clock the gait uses — there is no distance.
  /**
   * How far the hips drop when standing (m), unlocking the knees. Not cosmetic: the hip line is
   * exactly two bone lengths above the sole, so a character standing at rest has its legs at full
   * extension and *nothing* can move without pulling a foot off the floor. This is the slack
   * everything else in the idle layer spends.
   */
  idleSettle: number
  /** Breathing cycle length (s). */
  breathPeriod: number
  /** Breathing amplitude (m). Must stay under `idleSettle`, or an inhale lifts the feet. */
  breathDepth: number
  /** How long the weight rests on one leg before shifting (s). */
  idleShiftPeriod: number
  /** Lateral hip travel at full weight shift (m). */
  idleSway: number
  /** Torso counter-roll against the hip shift (radians) — contrapposto, on one rigid torso. */
  idleRoll: number

  // --- inertia. A character being *moved* rather than moving has no locomotion to animate, but it
  // still has mass. Each part lags the root by its own weight; parts inherit their parent's lag, so
  // these are increments down the chain and the loose end of a limb ends up lagging most.
  /** Overall response. 0 disables the layer. */
  inertiaStrength: number
  /**
   * Response half-life (s) — how loose the body is. Also the window the acceleration itself is
   * measured over, so a longer value is both slower to react and less twitchy.
   */
  inertiaHalfLife: number
  /** Torso lag weight. */
  inertiaBody: number
  /** Head lag weight. Low by default: a real head stabilizes itself and keeps looking level. */
  inertiaHead: number
  /** Upper arm lag weight — the loosest part of the body, and the most visible. */
  inertiaUpperArm: number
  /** Forearm lag weight, on top of the upper arm's. */
  inertiaLowerArm: number
  /**
   * How far the hips lag (m at full apparent tilt). The legs do **not** take a rotation: their feet
   * are planted, so the lower body's inertia has to arrive as hip travel that the IK then absorbs
   * into unequal knee bends. Grounded only.
   */
  inertiaHip: number
  /** Body compression on upward acceleration (m) — an elevator starting up. */
  inertiaVertical: number
  /** Arms floating up as apparent weight drops (radians) — an elevator starting down. */
  inertiaFloat: number

  /**
   * How much each *movement* differs from the last (0 disables it entirely). Variation is rolled
   * per event — per footfall, per jump, per landing — and held for that movement's duration, so no
   * two steps or jumps are identical while nothing changes mid-stride.
   *
   * Deliberately not per *character*: this is variation in the movement, not a personality. It is
   * also derived locally rather than shared, which is safe because nothing across clients can be
   * compared against it.
   *
   * 1 is the life-like amount. Above that is exaggeration for seeing the effect at all while
   * tuning; past ~3 the poses start clipping, because the varied bob and crouch ask for more drop
   * than the legs have length and the IK clamps.
   */
  variation: number
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
  footLift: 0.3,
  bob: 0.12,
  lean: 0.18,
  armSwing: 1.4,
  armOutward: 0.16,
  elbowBase: 0.3,
  elbowFold: 0.95,
  torsoTwist: 0.14,
  airArmRise: 2.2,
  airArmFall: 0.7,
  airArmOutRise: 0.5,
  airArmOutFall: 1.0,
  airElbowRise: 1.2,
  airElbowFall: 0.2,
  airTuckRise: 0.36,
  airTuckFall: 0.05,
  idleSettle: 0.025,
  breathPeriod: 2,
  breathDepth: 0.02,
  idleShiftPeriod: 2,
  idleSway: 0.015,
  idleRoll: 0.015,
  inertiaStrength: 1,
  inertiaHalfLife: 0.12,
  inertiaBody: 0.35,
  inertiaHead: 0.15,
  inertiaUpperArm: 1,
  inertiaLowerArm: 0.6,
  inertiaHip: 0.05,
  inertiaVertical: 0.06,
  inertiaFloat: 0.35,
  variation: 1,
  yawHalfLife: 0.06,
  blendHalfLife: 0.08,
  landCrouch: 0.5,
}

export interface Animator {
  /** Advance and return this frame's pose. Call once per rendered frame. */
  step: (input: AnimationInput, dt: number) => Pose
}

/**
 * mulberry32 — a small deterministic PRNG. Seeded so the variation is reproducible in tests; local
 * to each animator, because per-movement variation is cosmetic and there is nothing across clients
 * to compare it against.
 */
const rng = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAU = Math.PI * 2
const LN2 = Math.LN2

/**
 * Reference gravity for the inertial layer (m/s²) — deliberately **not** the simulation's. Sim
 * gravity is 55, five and a half times Earth's, so that jumps are snappy; normalizing apparent tilt
 * against it would make every inertial response five times too small to see. This number is for
 * feel, and `inertiaStrength` scales it.
 */
const G_REF = 9.81

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

export const createAnimator = (tuning: GaitTuning = DEFAULT_GAIT, seed = 1): Animator => {
  const pose = restPose()
  const random = rng(seed)
  let phase = 0
  let yaw = 0
  let airBlend = 0
  let riseBlend = 0
  let crouch = 0
  let prev: Vec3 | null = null
  let wasGrounded = true
  let lastSpeed = 0
  // Idle state. Its clock is time, not distance, and only advances while actually idle.
  let breathPhase = 0
  let shiftSide = 1
  let shiftEase = 0
  let shift = 0
  let idleTimer = 0
  // Inertia: the smoothed carry velocity, and the acceleration derived from it.
  let carryX = 0
  let carryY = 0
  let carryZ = 0
  let accX = 0
  let accY = 0
  let accZ = 0

  // Per-movement variation. Each of these is a multiplier around 1, rolled on an event and then
  // eased toward, so a new step or jump differs from the last without anything popping.
  //
  // Note what is *not* here: stride length. Phase advances as distance / stride, so changing stride
  // while a foot is planted slides that foot — the skating this design exists to remove. Everything
  // varied below is free of ground contact.
  const vary = { footLift: 1, armSwing: 1, twist: 1, bob: 1, airTuck: 1, airSplay: 1, crouch: 1, idleSway: 1 }
  const target = { ...vary }
  /**
   * Roll a multiplier of roughly ±`spread`, scaled by the tuning's variation amount. The amount is
   * not capped at 1: the per-quantity spreads are only ±14–30%, which is hard to *see* while
   * tuning, so the debug slider runs well past life-like.
   *
   * Rolled in log space, which is why it survives that. A linear `1 + u * spread * amount` goes
   * negative once the amount is large enough, and a negative multiplier inverts the motion — a foot
   * that lifts into the floor, a bob that rises on the footfall — which reads as a bug rather than
   * as variation. Clamping the result at zero fixes the sign but then skews every quantity larger on
   * average, so the knob stops meaning "more variation" and starts meaning "bigger". An exponential
   * cannot change sign and is symmetric in ratio at any amount, so 0.5× is exactly as likely as 2×.
   * At small amounts the two agree to within a fraction of a percent.
   */
  const roll = (spread: number): number => Math.exp((random() * 2 - 1) * spread * Math.max(0, tuning.variation))
  let lastBeat = -1

  const X = vec3(1, 0, 0)
  const Y = vec3(0, 1, 0)
  const Z = vec3(0, 0, 1)

  /**
   * Pose a part that extends **upward** from its joint (body, head). A rotation about +x carries its
   * top toward +z, so positive `forward` leans forward. `twist` turns it about its own axis, `roll`
   * tips it sideways (positive toward −x at the top).
   */
  const setUpright = (part: PartName, forward: number, twist = 0, roll = 0): void => {
    pose.rotation[part] = mulQuat(mulQuat(axisAngleToQuat(X, forward), axisAngleToQuat(Y, twist)), axisAngleToQuat(Z, roll))
  }

  /**
   * Pose a part that hangs **downward** from its joint (every arm and leg segment). The same
   * rotation carries its tip toward *−z*, so the pitch sign flips. Sharing one helper between the
   * two kinds is what produced a moonwalk: the legs swung backward while the character moved
   * forward, and the planted foot slid along at twice its speed.
   *
   * `outward` splays the limb away from the body (already signed by the caller's side) and is
   * applied *before* the swing, so the arm swings in a plane tilted out from the torso.
   */
  const setLimb = (part: PartName, forward: number, outward = 0): void => {
    pose.rotation[part] = mulQuat(axisAngleToQuat(X, -forward), axisAngleToQuat(Z, outward))
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

      // --- per-movement variation ---------------------------------------------------------
      // Rolled on events, never per frame: per-frame randomness reads as noise, not as life.
      const beat = Math.floor(phase * 2) // two footfalls per cycle
      if (input.grounded && beat !== lastBeat) {
        lastBeat = beat
        target.footLift = roll(0.22)
        target.armSwing = roll(0.14)
        target.twist = roll(0.18)
        target.bob = roll(0.16)
      }
      if (wasGrounded && !input.grounded) {
        // Takeoff: this jump's shape.
        target.airTuck = roll(0.2)
        target.airSplay = roll(0.18)
      }
      if (!wasGrounded && input.grounded) target.crouch = roll(0.3) // landing depth
      for (const k of Object.keys(vary) as (keyof typeof vary)[]) vary[k] = smooth(vary[k], target[k], dt, 0.1)

      // --- smoothed drivers ---------------------------------------------------------------
      yaw = smoothAngle(yaw, input.yaw, dt, tuning.yawHalfLife)
      airBlend = smooth(airBlend, input.grounded ? 0 : 1, dt, tuning.blendHalfLife)
      // Which half of the arc we are in. This is what `STATE_RISING` is on the wire for — vertical
      // velocity crosses zero at the apex, so a viewer cannot tell ascent from descent reliably.
      riseBlend = smooth(riseBlend, input.rising ? 1 : 0, dt, tuning.blendHalfLife)
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

      // --- inertia ------------------------------------------------------------------------
      // A character being *moved* has no locomotion to animate but still has mass. The response is
      // to acceleration, not velocity, so a platform running at a steady speed produces nothing —
      // standing on a train at line speed feels like standing still.
      const hl = Math.max(tuning.inertiaHalfLife, 1e-3)
      const cx = input.carry?.x ?? 0
      const cy = input.carry?.y ?? 0
      const cz = input.carry?.z ?? 0
      // Acceleration without differencing anything. For an exponential smoother the derivative of
      // the smoothed value is exactly `(raw − smoothed) · ln2 / halfLife`, so the *gap* between the
      // two is already a low-passed derivative. A plain difference would be hopeless: carry updates
      // at the 30 Hz sim rate while this runs per rendered frame, so differencing it yields a
      // staircase of spikes and zeroes.
      // Sampled at the midpoint of the frame — the average of the gap before and after this frame's
      // update. Reading it only before (or only after) leaves a one-frame bias that scales with dt,
      // which is precisely the frame-rate dependence this construction exists to avoid: 144 fps and
      // 60 fps disagreed by 4% on it.
      const rate = LN2 / hl
      const gapX = cx - carryX
      const gapY = cy - carryY
      const gapZ = cz - carryZ
      carryX = smooth(carryX, cx, dt, hl)
      carryY = smooth(carryY, cy, dt, hl)
      carryZ = smooth(carryZ, cz, dt, hl)
      accX = smooth(accX, (gapX + (cx - carryX)) * 0.5 * rate, dt, hl)
      accY = smooth(accY, (gapY + (cy - carryY)) * 0.5 * rate, dt, hl)
      accZ = smooth(accZ, (gapZ + (cz - carryZ)) * 0.5 * rate, dt, hl)
      // Into the character's own frame, so "forward" means where it is facing.
      const yawCos = Math.cos(yaw)
      const yawSin = Math.sin(yaw)
      const aRight = accX * yawCos - accZ * yawSin
      const aFwd = accX * yawSin + accZ * yawCos
      // `atan(a/g)` is the angle a pendulum hangs at under that acceleration — the right shape, and
      // it saturates rather than exploding when a platform reverses direction in a single tick.
      // Negative because a part lags *against* the acceleration: both pose helpers take positive to
      // mean "tip toward +z", so one sign serves upright parts and hanging limbs alike.
      const lagFwd = -Math.atan2(aFwd, G_REF) * tuning.inertiaStrength
      const lagRight = -Math.atan2(aRight, G_REF) * tuning.inertiaStrength
      const lagUp = Math.atan2(accY, G_REF) * tuning.inertiaStrength
      // Accelerating upward compresses the body. Downward is **not** allowed to lift the hips —
      // standing legs are at full extension and it cannot be solved — so lost weight goes to the
      // arms floating up instead.
      const compress = Math.max(0, lagUp) * tuning.inertiaVertical
      const floatUp = Math.max(0, -lagUp) * tuning.inertiaFloat

      // --- idle ---------------------------------------------------------------------------
      // The gait scales every amplitude by speed, so at a standstill it contributes exactly nothing
      // and the character is a statue. Idle is a separate layer with its own **time** clock — there
      // is no distance to drive a phase with — faded in as the gait fades out.
      const idleBlend = ground0 * (1 - clamp(lastSpeed / 1.2, 0, 1))
      // The shift clock only runs while idle, so a shift never fires mid-run and then pops into view
      // the moment the player stops.
      idleTimer -= dt * idleBlend
      if (idleTimer <= 0) {
        // A weight shift is a movement, so it rolls its own variation like a step or a jump does.
        shiftSide = -shiftSide
        idleTimer = tuning.idleShiftPeriod * roll(0.35)
        target.idleSway = roll(0.25)
      }
      if (tuning.breathPeriod > 0) breathPhase += dt / tuning.breathPeriod
      const breath = Math.sin(breathPhase * TAU)
      // Two smoothers in series. One alone is ease-*out* only, so the transfer starts with a jerk;
      // chained, they give an S — slow to leave one leg, slow to arrive on the other.
      shiftEase = smooth(shiftEase, shiftSide, dt, 0.35)
      shift = smooth(shift, shiftEase, dt, 0.35)
      // Breathing lowers the hips and never raises them. The hip line is exactly two bone lengths
      // above the sole, so a character standing at rest has its legs at **full extension**: lifting
      // the hip asks for reach that does not exist and the feet leave the floor. `idleSettle` is the
      // slack that makes the whole layer solvable.
      const idleDrop = (tuning.idleSettle - breath * tuning.breathDepth) * idleBlend
      const sway = shift * tuning.idleSway * vary.idleSway * idleBlend

      // --- body ---------------------------------------------------------------------------
      // Bob peaks twice per cycle (once per footfall).
      const bob = -Math.abs(Math.sin(phase * TAU)) * tuning.bob * intensity * vary.bob
      const crouchDrop = -crouch * tuning.landCrouch * 0.25 * vary.crouch
      // Hip lag is how the *legs* show inertia. They cannot rotate for it — their feet are planted —
      // so the lower body's mass arrives as hip travel and the IK turns it into unequal knee bends.
      // Grounded only: in the air there is nothing to lag against.
      const hipLag = tuning.inertiaHip * ground0
      pose.bodyOffset = vec3(sway + lagRight * hipLag, bob + crouchDrop - idleDrop - compress, lagFwd * hipLag)
      // Shoulders turn against the stride. Costs one rotation and does more for liveliness than any
      // amount of extra limb amplitude; the head counter-turns so the face still leads.
      const twist = -Math.sin(phase * TAU) * tuning.torsoTwist * intensity * vary.twist
      // Hips travel toward the weighted leg and the torso tips the other way — contrapposto, as far
      // as a single rigid torso can express it. The head counter-rolls to stay level.
      const tilt = -shift * tuning.idleRoll * idleBlend
      // Inertia is additive on top. Roll is negated for upright parts and not for limbs: a positive
      // roll carries an upward part's *top* toward −x but a hanging limb's *tip* toward +x. Sharing
      // one sign between the two kinds is the mistake that produced the moonwalk, so the test for
      // this asserts world-space displacement for all ten parts rather than any angle convention.
      setUpright('body', tuning.lean * intensity + crouch * 0.15 - breath * 0.012 * idleBlend + lagFwd * tuning.inertiaBody, twist, tilt - lagRight * tuning.inertiaBody)
      setUpright('head', -tuning.lean * intensity * 0.7 + lagFwd * tuning.inertiaHead, -twist * 0.6, -tilt * 0.6 - lagRight * tuning.inertiaHead)

      // --- legs ---------------------------------------------------------------------------
      // The legs hang off the body, so the body's lean and twist rotate the frame they are solved in.
      // Solving as though that frame were upright drives the feet through the floor as soon as the
      // lean is more than tiny, and the error grows with both the lean and how far forward the foot
      // reaches. So: decide where the foot belongs in root space, bring that target back into the
      // leg's *actual* parent frame, and solve there.
      const bodyQ = pose.rotation.body
      const invBody = conjQuat(bodyQ)
      const hipLineY = HIP_HEIGHT + pose.bodyOffset.y
      for (const side of [-1, 1] as const) {
        const s = side === -1 ? 'L' : 'R'
        const legPhase = phase + (side === -1 ? 0 : 0.5)
        // Lift varies per step; stride deliberately does not — see the note on `vary`.
        const gait = footTarget(legPhase, stride, tuning.footLift * vary.footLift, 0)
        // Ground gait, and an airborne pose, blended. The air pose itself differs by arc half:
        // knees up and split on the way up, legs together and nearly straight on the way down.
        const airFwd = riseBlend * (side === -1 ? 0.16 : -0.08) + (1 - riseBlend) * (side === -1 ? -0.04 : 0.06)
        const airLift = (tuning.airTuckRise * riseBlend + tuning.airTuckFall * (1 - riseBlend)) * vary.airTuck
        const forward = gait.forward * moveBlend + airFwd * airBlend
        const lift = gait.y * moveBlend + airLift * airBlend

        // Hip in root space, after the body has bobbed, swayed, tilted and turned.
        const pivot = RIG[`upperLeg${s}` as PartName].pivot
        const hipOffset = rotateVec3(bodyQ, pivot)
        const hip = vec3(pose.bodyOffset.x + hipOffset.x, hipLineY + hipOffset.y, pose.bodyOffset.z + hipOffset.z)
        // Foot target in root space. Laterally it stays under the hip's **rest** x, not its current
        // one: that is what "planted" means once the body can sway and tilt. Solving with the lateral
        // offset assumed to be zero — as this did — means the feet slide sideways with the hips, and
        // a weight shift becomes impossible to express at all.
        const toTarget = vec3(pivot.x - hip.x, FOOT_Y + lift - hip.y, forward - hip.z)
        const local = rotateVec3(invBody, toTarget)

        // Two bones with only a pitch each reach a plane, not a volume. So roll the whole leg about
        // z until the target lies in its sagittal plane, then solve in that plane. The roll goes on
        // the *outside* of the upper leg's pitch (`Z * X`, not the limbs' usual `X * Z`) so the knee
        // inherits it and the leg stays rigid — `Z·X(p1)·X(p2)` is the flat solution turned bodily,
        // which is a hip abducting. The other order bends the leg out of its own plane.
        const abduct = Math.atan2(local.x, -local.y)
        // `bendForward: true` puts the thigh ahead of the chord and the shin behind it — a human
        // knee. The other branch is the same length solution mirrored, and walks on bird legs.
        const { parent, child } = solveTwoBone(local.z, -Math.hypot(local.x, local.y), LIMB_LENGTH, LIMB_LENGTH, true)
        pose.rotation[`upperLeg${s}` as PartName] = mulQuat(axisAngleToQuat(Z, abduct), axisAngleToQuat(X, -parent))
        setLimb(`lowerLeg${s}` as PartName, child)
      }

      // --- arms ---------------------------------------------------------------------------
      // Opposite the legs, splayed off the body so the swing reads from behind, and raised forward
      // while airborne. The elbow keeps a bend at all times and folds further on the forward swing —
      // a straight arm swinging from the shoulder alone is what reads as a mannequin.
      const airArm = tuning.airArmRise * riseBlend + tuning.airArmFall * (1 - riseBlend)
      const airArmOut = (tuning.airArmOutRise * riseBlend + tuning.airArmOutFall * (1 - riseBlend)) * vary.airSplay
      const airElbow = tuning.airElbowRise * riseBlend + tuning.airElbowFall * (1 - riseBlend)
      for (const side of [-1, 1] as const) {
        const s = side === -1 ? 'L' : 'R'
        const raw = Math.sin((phase + (side === -1 ? 0.5 : 0)) * TAU)
        const swing = raw * tuning.armSwing * intensity * vary.armSwing
        const fold = (tuning.elbowBase + Math.max(0, raw) * tuning.elbowFold * intensity) * (1 - airBlend)
        // Outward roll is what makes any of this visible from a camera behind the character; in the
        // air it is the dominant term, since a raised arm pointing forward is nearly invisible there.
        const outward = tuning.armOutward * (1 - airBlend) + airArmOut * airBlend
        // Idle: arms drift out a little on the inhale (mirrored, so inside the `side` factor), and
        // hang more vertically than the tilted torso does (unmirrored, so outside it) — the torso
        // carries them and gravity does not.
        const breathOut = breath * 0.015 * idleBlend
        const hang = shift * tuning.idleRoll * 0.6 * idleBlend
        // Arms are the loosest thing on the body and the most visible, so they carry the most lag.
        // `floatUp` is mirrored (inside the `side` factor) and the lateral lag is not — one is the
        // body losing weight, the other is a direction in the world.
        setLimb(`upperArm${s}` as PartName, swing + airArm * airBlend + lagFwd * tuning.inertiaUpperArm, side * (outward + breathOut + floatUp) + hang + lagRight * tuning.inertiaUpperArm)
        // Pitch only: the forearm's lateral lag arrives by inheriting the shoulder's, and an elbow
        // is a hinge — rolling it sideways bends the arm in a direction it does not have.
        setLimb(`lowerArm${s}` as PartName, fold + airElbow * airBlend + lagFwd * tuning.inertiaLowerArm)
      }

      pose.yaw = yaw
      return pose
    },
  }
}
