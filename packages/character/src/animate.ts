import { axisAngleToQuat, clamp, conjQuat, mulQuat, quat, rotateVec3, slerpQuat, vec3, type Quat, type Vec3 } from '@mp/core'

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
  /**
   * Contralateral asymmetry in the **arms** while rising (0 for a symmetric jump, 1 the tuned
   * amount). The arm opposite the lead leg swings wider and higher; the other tucks in. Carried
   * mostly by the outward roll rather than the pitch, because a raised arm pointing forward is
   * nearly invisible from a camera behind the character — the same reason the walk needed a splay,
   * and the reason this is the half of the effect that actually reads.
   */
  airAsymArm: number
  /**
   * The same for the **legs**: the lead knee tucks higher and reaches further forward, the trailing
   * one drops and trails. Worth less than the arms from the default camera, where fore/aft is
   * foreshortened and the torso hides much of the knee's travel.
   */
  airAsymLeg: number

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
  /** Response half-life (s) — how loose the body is once it has been told to move. */
  inertiaHalfLife: number
  /**
   * The window the acceleration is *measured* over (s). Separate from the response half-life, and it
   * has to be: one knob doing both jobs is what made this layer nearly invisible for the motion that
   * matters most. The controller reaches full speed in 0.1 s, so a 0.12 s measurement window is wider
   * than the entire event and averages it away — the layer saw 6° of arm lag on a hard start where it
   * should see tens. A platform ramps over about a second, which is why the fault only ever showed up
   * away from platforms.
   *
   * Keep it at or below the 33 ms sim tick that feeds it. Shorter is more faithful and more twitchy;
   * `inertiaHalfLife` is where twitch is meant to be taken out, *after* the measurement.
   */
  inertiaSampleHalfLife: number
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

  // --- head. Every head term used to be a torso term times a constant, so the head could only ever
  // read as a slightly lazier torso — welded, however it was tuned. What follows is the set of
  // signals it has *of its own*. Note that from the default camera, behind the character, head yaw
  // and pitch are heavily foreshortened; the counter-bob and the roll carried by stabilization are
  // what actually read from there.
  /**
   * How much of the torso's rotation the head cancels. 0 welds it; 1 holds it level and facing
   * where the character faces, with the torso turning underneath. This replaces three separate
   * counter-fractions, and cancels the *whole* base rotation rather than the terms someone
   * remembered to negate.
   */
  headStabilize: number
  /**
   * Half-life of the head's own facing smoother (s). Shorter than `yawHalfLife` and the head
   * arrives first — it leads into a turn, which is what reads as looking where you are going.
   * Longer and it trails instead, which reads as being thrown around. One knob, either behaviour.
   */
  headYawHalfLife: number
  /** Cap on how far the head may lead or trail the body (radians) — a flick must not spin it off. */
  headYawMax: number
  /** Chin lift while rising (radians). */
  headRise: number
  /** Downward look while falling (radians) — the landing is down there. */
  headFall: number
  /** Nod on impact (radians). Decays with the landing crouch. */
  headLand: number
  /** Forward pitch at top speed (radians) — looking down the run. */
  headSprint: number

  // --- joint lag. Secondary motion as *translation*: the neck and the two shoulders interpolate toward
  // the **world** position of the point they attach to, so each is simply late to wherever the body went.
  // One mechanism, two pairs of knobs. Everything drives it with no term of its own — walking, starting,
  // stopping, turning, jumping, the bob, a landing, a platform's jolt all move that point through the
  // world, and that is the only input it takes.
  /**
   * **How far behind the head is.** Half-life (s) of the interpolation toward the neck point's world
   * position. 0 welds the head to the torso; raise it and the head both lags the character's motion and
   * rides the stride's bob less, since attenuating the bob and trailing the travel are the same filter
   * seen from two directions. Bounded by `headLagMax`.
   */
  headLagHalfLife: number
  /** Furthest the head may sit from its neck (m). */
  headLagMax: number
  /**
   * **How far behind the arms are.** Same quantity for each shoulder. 0 pins the arms rigidly to the
   * torso; raise it and they trail further behind everything the character does.
   *
   * Steady-state trail against a target at constant velocity is `speed × halfLife / ln2`, so at 5.5 m/s:
   * 0.005 s ≈ 40 mm, 0.01 s ≈ 79 mm, 0.03 s ≈ 240 mm. It saturates at `armLagMax` rather than growing
   * without limit.
   */
  armLagHalfLife: number
  /** Furthest an arm may sit from its shoulder (m). The stop that keeps a fast move from detaching it. */
  armLagMax: number

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
  airAsymArm: 1,
  airAsymLeg: 1,
  idleSettle: 0.025,
  breathPeriod: 2,
  breathDepth: 0.02,
  idleShiftPeriod: 2,
  idleSway: 0.015,
  idleRoll: 0.015,
  inertiaStrength: 1,
  inertiaHalfLife: 0.12,
  inertiaSampleHalfLife: 0.03,
  inertiaBody: 0.35,
  inertiaHead: 0.15,
  inertiaUpperArm: 1,
  inertiaLowerArm: 0.6,
  inertiaHip: 0.05,
  // Scaled by 55/9.81 when `G_REF` became the sim's real gravity. Unlike every other weight here,
  // these two are fed by the *vertical* signal, and locomotion is planar — so their only driver is
  // still a platform, and leaving them alone would have quietly made an elevator 5.6× weaker.
  inertiaVertical: 0.34,
  inertiaFloat: 1.95,
  headStabilize: 0.7,
  headYawHalfLife: 0.03,
  headYawMax: 0.7,
  headRise: 0.2,
  headFall: 0.25,
  headLand: 0.3,
  headSprint: 0.06,
  // A little tighter than the arms, so the head reads as the steadiest thing on the body while still
  // being on the same clock as them. ~55 mm of trail at top speed.
  headLagHalfLife: 0.007,
  headLagMax: 0.09,
  // ~79 mm of trail at top speed, saturating at 110. Deliberately large enough to be unmistakable
  // before it is tuned down: every previous attempt at this effect was too subtle to confirm at all.
  armLagHalfLife: 0.01,
  armLagMax: 0.11,
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
 * Reference gravity for the inertial layer (m/s²) — the simulation's own, and the honest choice now
 * that the layer sees the character's own locomotion.
 *
 * This was 9.81 while the only input was `carry`, motion the character did *not* ask for: platform
 * rides and shoves accelerate gently, and normalizing them against 55 made every response five times
 * too small to see. Feeding locomotion in inverts that argument completely. The controller reaches
 * full speed in 0.1 s and stops in 0.08, which is 55 m/s² and 69 m/s² — 5.6 g and 7 g — so against
 * 9.81 every start and stop pins `atan(a/g)` near 90° and the character is thrown flat. Normalizing
 * against the gravity the world actually has puts a hard start at 45° of apparent tilt, which is what
 * the formula means, and `inertiaStrength` scales from there.
 */
const G_REF = 55

// Magnitudes of the jump's lead/trail asymmetry at amount 1, so the two pane knobs stay unitless
// amounts rather than one being radians and the other metres.
/** Extra outward roll on the raised arm (radians), and as much taken off the other. */
const ARM_ASYM_OUT = 0.35
/** Extra pitch on the raised arm (radians). Smaller than the roll — foreshortened from behind. */
const ARM_ASYM_PITCH = 0.35
/**
 * Fore/aft foot split (m). Large enough that the trailing leg rakes visibly backward: straight and
 * angled back is the shape, and at this size the target is just out of reach so the IK holds the leg
 * dead straight and points it there — the clamp doing exactly the right thing for once.
 */
const LEG_ASYM_FWD = 0.18

/**
 * The joints that lag: the neck and the two shoulders — one per attachment to the torso, and nothing
 * below. A forearm inherits its shoulder, so each arm travels as a unit rather than coming apart at the
 * elbow, and the same holds for anything else hung off a lagging joint.
 *
 * The body and the legs are excluded by construction: the body's travel is `bodyOffset`, which the leg
 * IK is solved against, and the legs' feet are planted — displacing either would slide a foot, which is
 * the one thing this whole design exists to prevent.
 */
const LAG_PARTS = ['head', 'upperArmL', 'upperArmR'] as const
type LagPart = (typeof LAG_PARTS)[number]

/**
 * One lagging joint: where it currently is in **world** space (`p`), and where its attachment point was
 * last frame (`t`).
 *
 * World, not root, and this is the crux of the whole layer. A joint's position in the body's own frame
 * never changes — a shoulder is bolted to the torso — so interpolating it there converges instantly and
 * renders nothing at all. The attachment point only moves when the *character* moves: walking, turning,
 * jumping, bobbing. That is world motion, and it is what there is to be late to.
 *
 * The previous target is kept so the target's velocity can be measured, which is what makes the trail
 * frame-rate independent — see `follow`.
 */
interface Lag {
  p: Vec3
  t: Vec3
}

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
  // The head's own facing smoother. Same target as `yaw`, its own half-life, so it arrives at a new
  // heading before (or after) the body does and the difference is a lead (or a trail).
  let headYaw = 0
  let airBlend = 0
  let riseBlend = 0
  let crouch = 0
  // Which side leads this jump. Flips at every takeoff, so consecutive jumps mirror each other. Not
  // seeded: the side is the feature, not the variation, and starting every character on the same one
  // costs nothing because the *magnitude* is rolled per jump on top.
  let airLead: -1 | 1 = 1
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
  // Lagging joints, in world space. Seeded on the first frame from wherever the joints actually are:
  // starting them at the origin would fling every one of them across the world on frame one.
  const lag = Object.fromEntries(LAG_PARTS.map((n) => [n, { p: vec3(0, 0, 0), t: vec3(0, 0, 0) }])) as Record<LagPart, Lag>
  let lagPrimed = false

  // Per-movement variation. Each of these is a multiplier around 1, rolled on an event and then
  // eased toward, so a new step or jump differs from the last without anything popping.
  //
  // Note what is *not* here: stride length. Phase advances as distance / stride, so changing stride
  // while a foot is planted slides that foot — the skating this design exists to remove. Everything
  // varied below is free of ground contact.
  const vary = { footLift: 1, armSwing: 1, twist: 1, bob: 1, airTuck: 1, airSplay: 1, airLead: 1, crouch: 1, idleSway: 1 }
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
   * Rotation for a part that extends **upward** from its joint (body, head). A rotation about +x
   * carries its top toward +z, so positive `forward` leans forward. `twist` turns it about its own
   * axis, `roll` tips it sideways (positive toward −x at the top).
   */
  const uprightQuat = (forward: number, twist = 0, roll = 0): Quat =>
    mulQuat(mulQuat(axisAngleToQuat(X, forward), axisAngleToQuat(Y, twist)), axisAngleToQuat(Z, roll))

  const setUpright = (part: PartName, forward: number, twist = 0, roll = 0): void => {
    pose.rotation[part] = uprightQuat(forward, twist, roll)
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

  /**
   * Interpolate one joint toward the world position of the point it hangs from, and return how far
   * behind it ended up — in world space, and bounded by `max`.
   *
   * Exact for a target moving at a constant velocity across the frame, which is why the previous target
   * is kept. A plain `smooth` toward a *moving* target treats it as jumping at the frame boundary and
   * settles at `v·dt·α/(1−α)`, which depends on `dt`: 42 mm at 60 fps against 62 mm at 144 for the same
   * tuning. This form settles at `v·τ` at any frame rate, which is the continuous answer.
   *
   * First order, so it cannot overshoot: a joint falls behind and catches up, it never swings past. That
   * is the trade this construction makes against a spring, and the reason `max` is a hard stop rather
   * than a damping ratio.
   */
  const follow = (part: LagPart, wx: number, wy: number, wz: number, halfLife: number, max: number, dt: number): Vec3 => {
    const st = lag[part]
    if (!lagPrimed || halfLife <= 0) {
      // Re-seeded while disabled too, so switching the knob back on does not read one enormous velocity.
      st.p = vec3(wx, wy, wz)
      st.t = vec3(wx, wy, wz)
      if (halfLife <= 0) return vec3(0, 0, 0)
    }
    const tau = halfLife / LN2
    const alpha = Math.exp(-dt / tau)
    const vx = dt > 0 ? (wx - st.t.x) / dt : 0
    const vy = dt > 0 ? (wy - st.t.y) / dt : 0
    const vz = dt > 0 ? (wz - st.t.z) / dt : 0
    let ox = -vx * tau + (st.p.x - st.t.x + vx * tau) * alpha
    let oy = -vy * tau + (st.p.y - st.t.y + vy * tau) * alpha
    let oz = -vz * tau + (st.p.z - st.t.z + vz * tau) * alpha
    // Bounded as a vector, so a fast move saturates the trail without skewing its direction. Applied to
    // the stored position as well, or the state keeps running while the render stays pinned.
    const reach = Math.hypot(ox, oy, oz)
    if (reach > max) {
      const f = max / reach
      ox *= f
      oy *= f
      oz *= f
    }
    st.p = vec3(wx + ox, wy + oy, wz + oz)
    st.t = vec3(wx, wy, wz)
    return vec3(ox, oy, oz)
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
        // Takeoff: this jump's shape. The lead side alternates and its strength is rolled, because
        // strict L,R,L,R is only two poses and reads as predictable after a few jumps.
        airLead = airLead === 1 ? -1 : 1
        target.airTuck = roll(0.2)
        target.airSplay = roll(0.18)
        target.airLead = roll(0.3)
      }
      if (!wasGrounded && input.grounded) target.crouch = roll(0.3) // landing depth
      for (const k of Object.keys(vary) as (keyof typeof vary)[]) vary[k] = smooth(vary[k], target[k], dt, 0.1)

      // --- smoothed drivers ---------------------------------------------------------------
      yaw = smoothAngle(yaw, input.yaw, dt, tuning.yawHalfLife)
      headYaw = smoothAngle(headYaw, input.yaw, dt, tuning.headYawHalfLife)
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
      const mhl = Math.max(tuning.inertiaSampleHalfLife, 1e-3)
      // The character's **total** world velocity: what its locomotion asked for, plus what it received
      // without asking. Only the second half used to be here, which meant the layer fired on platforms
      // and nowhere else — your own starts, stops and turns produced nothing at all, and they are by
      // far the larger accelerations. One signal, so one system covers both.
      //
      // From `input.yaw` rather than the smoothed facing: the velocity points where the character is
      // *going*, and the smoother is a rendering choice about where it looks.
      const locoX = Math.sin(input.yaw) * speed
      const locoZ = Math.cos(input.yaw) * speed
      const cx = locoX + (input.carry?.x ?? 0)
      const cy = input.carry?.y ?? 0
      const cz = locoZ + (input.carry?.z ?? 0)
      // Acceleration without differencing anything. For an exponential smoother the derivative of
      // the smoothed value is exactly `(raw − smoothed) · ln2 / halfLife`, so the *gap* between the
      // two is already a low-passed derivative. A plain difference would be hopeless: carry updates
      // at the 30 Hz sim rate while this runs per rendered frame, so differencing it yields a
      // staircase of spikes and zeroes.
      // Sampled at the midpoint of the frame — the average of the gap before and after this frame's
      // update. Reading it only before (or only after) leaves a one-frame bias that scales with dt,
      // which is precisely the frame-rate dependence this construction exists to avoid: 144 fps and
      // 60 fps disagreed by 4% on it.
      // Measured over `mhl`, then the *response* is smoothed over `hl`. Two stages with two purposes:
      // the first has to be short enough to see a 0.1 s acceleration at all, the second is where the
      // resulting twitch is taken out. Sharing one half-life between them meant every window wide
      // enough to be calm was also wide enough to average the event away.
      const rate = LN2 / mhl
      const gapX = cx - carryX
      const gapY = cy - carryY
      const gapZ = cz - carryZ
      carryX = smooth(carryX, cx, dt, mhl)
      carryY = smooth(carryY, cy, dt, mhl)
      carryZ = smooth(carryZ, cz, dt, mhl)
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
      // amount of extra limb amplitude.
      const twist = -Math.sin(phase * TAU) * tuning.torsoTwist * intensity * vary.twist
      // Hips travel toward the weighted leg and the torso tips the other way — contrapposto, as far
      // as a single rigid torso can express it.
      const tilt = -shift * tuning.idleRoll * idleBlend
      // What the gait and idle layers ask of the torso, before inertia. Kept separately because the
      // head stabilizes against *this*: inertia is an additive layer with its own per-part weights,
      // and cancelling a share of it here would quietly rewrite what those weights mean.
      const lean = tuning.lean * intensity + crouch * 0.15 - breath * 0.012 * idleBlend
      const bodyBaseQ = uprightQuat(lean, twist, tilt)
      // Inertia is additive on top. Roll is negated for upright parts and not for limbs: a positive
      // roll carries an upward part's *top* toward −x but a hanging limb's *tip* toward +x. Sharing
      // one sign between the two kinds is the mistake that produced the moonwalk, so the test for
      // this asserts world-space displacement for all ten parts rather than any angle convention.
      setUpright('body', lean + lagFwd * tuning.inertiaBody, twist, tilt - lagRight * tuning.inertiaBody)

      // --- head ---------------------------------------------------------------------------
      // The head used to be three constants times three torso terms, which is a head that can only
      // ever look like a lazier torso. It now gets its own signals, on top of a real stabilization.
      //
      // 1. Cancel a share of everything the torso is doing. At 1 the head holds level in the world
      //    and the torso turns underneath it — a vestibular reflex, and the reason a real walk does
      //    not read as a bobbing skull. Slerping the base rotation's *conjugate* rather than negating
      //    the three terms individually is what makes the cancellation exact: the head's world tilt
      //    comes out at (1 − headStabilize) × the torso's, measured, at every value of the knob.
      //    Negated Euler terms only agree with that to first order, because X·Y·Z does not commute.
      const counter = slerpQuat(quat(), conjQuat(bodyBaseQ), clamp(tuning.headStabilize, 0, 1))
      // 2. Facing, on the head's own clock. Both smoothers chase the same target, so this is zero
      //    except while turning — no drift to correct, and it settles itself.
      let lead = ((headYaw - yaw + Math.PI) % TAU) - Math.PI
      if (lead < -Math.PI) lead += TAU
      lead = clamp(lead, -tuning.headYawMax, tuning.headYawMax)
      // 3. State pitch. Chin up going up, look down at the landing coming down, nod on the impact,
      //    and a little down the run at speed. Positive pitches the head forward, so only the rise
      //    is negated. These are the head's only inputs that no other part shares.
      const headPitch =
        (tuning.headFall * (1 - riseBlend) - tuning.headRise * riseBlend) * airBlend +
        tuning.headLand * crouch +
        tuning.headSprint * intensity +
        lagFwd * tuning.inertiaHead
      // Applied *inside* the counter-rotation, so `counter · own` puts the head's own terms in the
      // stabilized frame rather than in the torso's.
      pose.rotation.head = mulQuat(counter, uprightQuat(headPitch, lead, -lagRight * tuning.inertiaHead))
      // The head's translation — a steadier eyeline than the hips, and a trail behind the character's
      // travel — is not a term here. The joint-lag layer at the end of this function produces both, as
      // two views of the same filter: attenuating the bob and trailing the travel are one thing.

      // --- legs ---------------------------------------------------------------------------
      // The legs hang off the body, so the body's lean and twist rotate the frame they are solved in.
      // Solving as though that frame were upright drives the feet through the floor as soon as the
      // lean is more than tiny, and the error grows with both the lean and how far forward the foot
      // reaches. So: decide where the foot belongs in root space, bring that target back into the
      // leg's *actual* parent frame, and solve there.
      const bodyQ = pose.rotation.body
      const invBody = conjQuat(bodyQ)
      const hipLineY = HIP_HEIGHT + pose.bodyOffset.y

      // This jump's lead/trail asymmetry, shared by the legs and the arms so the two stay
      // contralateral. Faded out with the rise on purpose: the descent extends both legs to feel for
      // the floor, and holding the split through it lands the character visibly one-footed before it
      // snaps back to a two-foot stance.
      const asym = riseBlend * vary.airLead
      // The same thing without the per-jump strength roll, for the one quantity that must not be
      // varied: whether the trailing leg is *straight*. Near full extension the knee angle is savagely
      // nonlinear — 66 mm of residual lift is 46° of visible bend — so a roll that lands under 1 does
      // not make the leg slightly less straight, it makes it bent. A leg either extends or it does not.
      const asymFirm = riseBlend
      for (const side of [-1, 1] as const) {
        const s = side === -1 ? 'L' : 'R'
        const legPhase = phase + (side === -1 ? 0 : 0.5)
        // Lift varies per step; stride deliberately does not — see the note on `vary`.
        const gait = footTarget(legPhase, stride, tuning.footLift * vary.footLift, 0)
        // Ground gait, and an airborne pose, blended. The air pose itself differs by arc half:
        // knees up and split on the way up, legs together and nearly straight on the way down.
        //
        // The split used to be hard-coded to favour the left on every jump of every character. It now
        // follows the lead side, so the two-jump cycle mirrors — and at amount 0 the pose is symmetric
        // rather than reproducing the old left-handed one.
        const legLead = (side === airLead ? 1 : -1) * asym * tuning.airAsymLeg
        const airFwd = riseBlend * 0.04 + (1 - riseBlend) * 0.01 + LEG_ASYM_FWD * legLead
        // One leg folds and the other **extends** — which a ±fraction around the tuck cannot express,
        // since half of a 0.36 m tuck is still a bent knee. So the share is asymmetric by
        // construction: the lead leg takes the whole tuck at any amount, and the trailing one gives up
        // its share until it reaches zero lift, which *is* full extension (the hip line sits exactly
        // two bone lengths above the sole). It saturates there because a leg cannot straighten past
        // straight — and this way `airTuckRise` keeps meaning what it did for the lead knee.
        const tuckLead = (side === airLead ? 1 : -1) * asymFirm * tuning.airAsymLeg
        const tuckShare = tuckLead >= 0 ? 1 : Math.max(0, 1 + tuckLead)
        const airLift = (tuning.airTuckRise * riseBlend + tuning.airTuckFall * (1 - riseBlend)) * vary.airTuck * tuckShare
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
        // Contralateral: the arm opposite the lead *leg* is the one that raises. Same-side pairing
        // reads as a robot; this is the pattern a real jump and a real run both use.
        const armLead = (side === airLead ? -1 : 1) * asym * tuning.airAsymArm
        // Outward roll is what makes any of this visible from a camera behind the character; in the
        // air it is the dominant term, since a raised arm pointing forward is nearly invisible there.
        // Which is also why the asymmetry is carried mostly here rather than in the pitch.
        const outward = tuning.armOutward * (1 - airBlend) + (airArmOut + ARM_ASYM_OUT * armLead) * airBlend
        // Idle: arms drift out a little on the inhale (mirrored, so inside the `side` factor), and
        // hang more vertically than the tilted torso does (unmirrored, so outside it) — the torso
        // carries them and gravity does not.
        const breathOut = breath * 0.015 * idleBlend
        const hang = shift * tuning.idleRoll * 0.6 * idleBlend
        // Arms are the loosest thing on the body and the most visible, so they carry the most lag.
        // `floatUp` is mirrored (inside the `side` factor) and the lateral lag is not — one is the
        // body losing weight, the other is a direction in the world.
        setLimb(`upperArm${s}` as PartName, swing + (airArm + ARM_ASYM_PITCH * armLead) * airBlend + lagFwd * tuning.inertiaUpperArm, side * (outward + breathOut + floatUp) + hang + lagRight * tuning.inertiaUpperArm)
        // Pitch only: the forearm's lateral lag arrives by inheriting the shoulder's, and an elbow
        // is a hinge — rolling it sideways bends the arm in a direction it does not have.
        setLimb(`lowerArm${s}` as PartName, fold + airElbow * airBlend + lagFwd * tuning.inertiaLowerArm)
      }

      // --- joint lag ------------------------------------------------------------------------
      // Secondary motion, as translation. Every joint that attaches to the torso interpolates toward the
      // **world** position of its attachment point instead of sitting on it exactly, so it is simply
      // late to wherever the body went. One mechanism for the neck and both shoulders, differing only in
      // half-life and stop — see `follow` for why world space is the whole trick, and `Lag` for what the
      // two earlier root-space attempts got wrong.
      //
      // Everything the character does drives it, with no term of its own: walking, starting, stopping,
      // turning, jumping, the stride's bob, a landing, a platform's jolt. All of it moves the attachment
      // point through the world, which is the only input this needs.
      const bodyPivot = RIG.body.pivot
      const bodyX = bodyPivot.x + pose.bodyOffset.x
      const bodyY = bodyPivot.y + pose.bodyOffset.y
      const bodyZ = bodyPivot.z + pose.bodyOffset.z
      const cosY = Math.cos(yaw)
      const sinY = Math.sin(yaw)

      for (const part of LAG_PARTS) {
        const halfLife = part === 'head' ? tuning.headLagHalfLife : tuning.armLagHalfLife
        const max = part === 'head' ? tuning.headLagMax : tuning.armLagMax
        // The attachment point in world space: its root-space position, turned by the character's
        // facing, placed at the character's position.
        const attach = rotateVec3(bodyQ, RIG[part].pivot)
        const rx = bodyX + attach.x
        const ry = bodyY + attach.y
        const rz = bodyZ + attach.z
        const o = follow(part, input.position.x + rx * cosY + rz * sinY, input.position.y + ry, input.position.z - rx * sinY + rz * cosY, Math.max(halfLife, 0), max, dt)
        // World → root (undo the facing) → body (undo the torso), since a joint's position is written in
        // its parent's frame, and every lagging joint's parent is the body.
        pose.jointOffset[part] = rotateVec3(invBody, vec3(o.x * cosY - o.z * sinY, o.y, o.x * sinY + o.z * cosY))
      }
      lagPrimed = true

      pose.yaw = yaw
      return pose
    },
  }
}
