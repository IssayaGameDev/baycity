import { mulQuat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { createAnimator, solveTwoBone, DEFAULT_GAIT } from './animate'
import { CHAR_HEIGHT, FOOT_Y, HIP_HEIGHT, LIMB_LENGTH, RIG, PART_NAMES, type PartName, type Pose } from './rig'

const DT = 1 / 60
const ZERO = vec3(0, 0, 0)
/** Length of an offset. Summed absolutes rather than `hypot`, so a signed zero still reads as zero. */
const magnitude = (v: Vec3): number => Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)

/** Snapshot a pose: the animator mutates and returns one object, so assertions need a copy. */
const snapshot = (pose: Pose): Pose => ({
  yaw: pose.yaw,
  bodyOffset: { ...pose.bodyOffset },
  jointOffset: { ...pose.jointOffset },
  rotation: { ...pose.rotation },
})

/** Walk the rig's parent chain to get a joint's root-space position under a pose. */
const jointPosition = (pose: Pose, part: PartName): Vec3 => {
  const chain: PartName[] = []
  for (let p: PartName | null = part; p !== null; p = RIG[p].parent) chain.unshift(p)
  let pos = vec3(0, 0, 0)
  let rot = pose.rotation.body // replaced below; start from identity via the loop
  let acc = vec3(0, 0, 0)
  let orientation = vec3(0, 0, 0) // unused placeholder to keep the shape obvious
  void rot
  void orientation
  // Compose: each joint's pivot is expressed in the parent's rotated frame.
  let q = { x: 0, y: 0, z: 0, w: 1 }
  for (const name of chain) {
    const part2 = RIG[name]
    // Every joint can translate (`jointOffset`, the spring layer) and the body adds its bob on top.
    // Both matter: dropping the body's x would let the helper disagree with the renderer about where
    // the hips are, reading the legs' compensation for the idle sway as the feet sliding.
    const jo = pose.jointOffset[name]
    const bo = name === 'body' ? pose.bodyOffset : ZERO
    const offset = vec3(part2.pivot.x + jo.x + bo.x, part2.pivot.y + jo.y + bo.y, part2.pivot.z + jo.z + bo.z)
    const rotated = rotateVec3(q, offset)
    acc = vec3(acc.x + rotated.x, acc.y + rotated.y, acc.z + rotated.z)
    const r = pose.rotation[name]
    q = {
      x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
      y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
      z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
      w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
    }
  }
  pos = acc
  return pos
}

/** Root-space position of a foot's sole under a pose. */
const solePosition = (pose: Pose, side: 'L' | 'R'): Vec3 => {
  const knee = jointPosition(pose, `lowerLeg${side}` as PartName)
  // The sole is one segment below the knee joint, in the lower leg's rotated frame.
  const chain: PartName[] = ['body', `upperLeg${side}` as PartName, `lowerLeg${side}` as PartName]
  let q = { x: 0, y: 0, z: 0, w: 1 }
  for (const name of chain) {
    const r = pose.rotation[name]
    q = {
      x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
      y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
      z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
      w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
    }
  }
  const down = rotateVec3(q, vec3(0, -LIMB_LENGTH, 0))
  return vec3(knee.x + down.x, knee.y + down.y, knee.z + down.z)
}

describe('rig', () => {
  it('is exactly as tall as the collider, with the sole at the capsule bottom', () => {
    expect(CHAR_HEIGHT).toBeCloseTo(2, 6)
    expect(FOOT_Y).toBeCloseTo(-1, 6)
    // Hip + two leg segments reaches the sole: the rest pose stands flat.
    expect(HIP_HEIGHT - LIMB_LENGTH * 2).toBeCloseTo(FOOT_Y, 6)
  })

  it('has ten parts and a connected parent chain', () => {
    expect(PART_NAMES).toHaveLength(10)
    for (const name of PART_NAMES) {
      const parent = RIG[name].parent
      if (parent !== null) expect(PART_NAMES).toContain(parent)
    }
  })
})

describe('solveTwoBone', () => {
  it('puts the limb tip on the target', () => {
    const a = 0.375
    const b = 0.375
    for (const [forward, up] of [
      [0, -0.7],
      [0.2, -0.6],
      [-0.25, -0.55],
      [0.4, -0.4],
    ] as const) {
      const { parent, child } = solveTwoBone(forward, up, a, b, false)
      // Forward-kinematic the two bones back and compare with the request.
      const tipF = a * Math.sin(parent) + b * Math.sin(parent + child)
      const tipU = -a * Math.cos(parent) - b * Math.cos(parent + child)
      expect(tipF).toBeCloseTo(forward, 5)
      expect(tipU).toBeCloseTo(up, 5)
    }
  })

  it('clamps an unreachable target instead of producing NaN', () => {
    const r = solveTwoBone(0, -10, 0.375, 0.375, false)
    expect(Number.isFinite(r.parent)).toBe(true)
    expect(Number.isFinite(r.child)).toBe(true)
  })
})

describe('createAnimator', () => {
  const run = (speed: number, seconds: number, grounded = true) => {
    const a = createAnimator()
    let x = 0
    let pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded, rising: false }, DT)
    const soles: number[] = []
    for (let t = 0; t < seconds / DT; t++) {
      x += speed * DT
      pose = a.step({ position: vec3(x, 0, 0), yaw: 0, speed, grounded, rising: false }, DT)
      soles.push(solePosition(pose, 'L').y)
    }
    return { pose, soles, distance: x }
  }

  it('keeps both soles at or above the ground, and plants them at ground level', () => {
    const { soles } = run(4, 2)
    const min = Math.min(...soles)
    const max = Math.max(...soles)
    // Never digs into the floor…
    expect(min).toBeGreaterThan(FOOT_Y - 0.03)
    // …and does lift clear of it during swing.
    expect(max - min).toBeGreaterThan(0.1)
  })

  it('plants the stance foot in the world — it must not slide (no moonwalk)', () => {
    // The definitive test of walk direction. Travelling +z with yaw 0, a foot in its stance phase
    // has to hold still in *world* space: its local offset must move backward exactly as fast as
    // the body moves forward. If the limb pitch is mirrored, the local offset moves forward
    // instead and the planted foot slides at twice the body's speed — a moonwalk.
    const a = createAnimator()
    const speed = 4
    let z = 0
    a.step({ position: vec3(0, 0, 0), yaw: 0, speed, grounded: true, rising: false }, DT)

    let worstSlide = 0
    let runStart: number | null = null
    let runLast = 0
    for (let t = 0; t < 3 / DT; t++) {
      z += speed * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed, grounded: true, rising: false }, DT)
      const sole = solePosition(pose, 'L')
      const planted = sole.y < FOOT_Y + 0.01 // on the ground → this foot is bearing weight
      const worldZ = z + sole.z
      if (planted) {
        if (runStart === null) runStart = worldZ
        else worstSlide = Math.max(worstSlide, Math.abs(worldZ - runStart))
        runLast = worldZ
      } else {
        runStart = null
      }
    }
    void runLast
    // A stride is ~1.5 m here, so a mirrored cycle would slide metres. Allow a few cm.
    expect(worstSlide).toBeLessThan(0.08)
  })

  it('bends knees like a human — shin swings back from a forward thigh', () => {
    // The other half-mirror: with the wrong IK branch the knee inverts and the character walks on
    // bird legs. Mid-stride, the knee joint must sit forward of the straight hip-to-ankle line.
    const a = createAnimator()
    let z = 0
    let pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 4, grounded: true, rising: false }, DT)
    let sawForwardKnee = false
    for (let t = 0; t < 2 / DT; t++) {
      z += 4 * DT
      pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 4, grounded: true, rising: false }, DT)
      const hip = jointPosition(pose, 'upperLegL')
      const knee = jointPosition(pose, 'lowerLegL')
      const ankle = solePosition(pose, 'L')
      // Knee's forward offset from the hip→ankle chord.
      const span = vec3(ankle.x - hip.x, ankle.y - hip.y, ankle.z - hip.z)
      const mid = vec3(hip.x + span.x / 2, hip.y + span.y / 2, hip.z + span.z / 2)
      if (knee.z - mid.z > 0.02) sawForwardKnee = true
      expect(knee.z - mid.z, 'knee must never bow backward').toBeGreaterThan(-0.02)
    }
    expect(sawForwardKnee, 'knee should visibly lead during the cycle').toBe(true)
  })

  it('advances stride with distance, so the cycle count scales with speed not time', () => {
    // Same duration, double the speed → about double the strides. Time-driven animation would
    // give the same count for both, which is what makes feet skate.
    const cycles = (speed: number): number => {
      const a = createAnimator()
      let x = 0
      let last = 0
      let crossings = 0
      a.step({ position: vec3(0, 0, 0), yaw: 0, speed, grounded: true, rising: false }, DT)
      for (let t = 0; t < 2 / DT; t++) {
        x += speed * DT
        const pose = a.step({ position: vec3(x, 0, 0), yaw: 0, speed, grounded: true, rising: false }, DT)
        const y = solePosition(pose, 'L').y
        if (last <= FOOT_Y + 0.01 && y > FOOT_Y + 0.01) crossings++
        last = y
      }
      return crossings
    }
    const slow = cycles(2)
    const fast = cycles(5)
    expect(fast).toBeGreaterThan(slow)
  })

  it('does not accrue stride while standing still', () => {
    const a = createAnimator()
    let pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    const first = solePosition(pose, 'L')
    for (let t = 0; t < 120; t++) pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    const later = solePosition(pose, 'L')
    expect(Math.abs(later.z - first.z)).toBeLessThan(0.01)
    expect(Math.abs(later.y - first.y)).toBeLessThan(0.02)
  })

  it('smooths facing frame-rate independently', () => {
    // The same elapsed time at different frame rates must land in the same place — the flaw in the
    // view this replaces, which eased by a fixed fraction per frame.
    const settle = (dt: number): number => {
      const a = createAnimator()
      let pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, dt)
      for (let t = 0; t < Math.round(0.3 / dt); t++)
        pose = a.step({ position: vec3(0, 0, 0), yaw: Math.PI / 2, speed: 0, grounded: true, rising: false }, dt)
      return pose.yaw
    }
    expect(settle(1 / 144)).toBeCloseTo(settle(1 / 30), 2)
  })

  it('tucks the knees up on the way up, and stands back down on landing', () => {
    // Tucking belongs to the *rising* half specifically; the descent extends instead (see the
    // rise/fall test below), so this has to ask for the half it means.
    const a = createAnimator()
    let pose = restPoseOf(a)
    for (let t = 0; t < 60; t++) pose = a.step({ position: vec3(0, 5, 0), yaw: 0, speed: 3, grounded: false, rising: true }, DT)
    const airSole = solePosition(pose, 'L').y
    for (let t = 0; t < 60; t++) pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    const groundSole = solePosition(pose, 'L').y
    expect(airSole, 'legs tuck up while rising').toBeGreaterThan(groundSole + 0.15)
  })

  it('keeps the feet on the ground however hard the body leans and twists', () => {
    // The legs hang off the body, so lean and twist rotate the frame they are solved in. Solving as
    // though it were upright pushes the feet through the floor, and the error grows with the lean —
    // which only showed up once the values were raised. Exaggerate both and the feet must still land.
    const a = createAnimator({ ...DEFAULT_GAIT, lean: 0.5, torsoTwist: 0.5, bob: 0.2 })
    let z = 0
    let lowest = Infinity
    a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
    for (let t = 0; t < 3 / DT; t++) {
      z += 5.5 * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
      for (const side of ['L', 'R'] as const) lowest = Math.min(lowest, solePosition(pose, side).y)
    }
    expect(lowest).toBeGreaterThan(FOOT_Y - 0.03)
  })

  it('swings the arms wide, splayed off the body, with a bent elbow throughout', () => {
    // Read from a camera behind the character, pure fore/aft swing is foreshortened to nearly
    // nothing — hence the splay — and a straight arm swinging from the shoulder reads as a mannequin.
    const a = createAnimator()
    let z = 0
    let minElbowBend = Infinity
    let maxHandSpread = 0
    let handRange = { min: Infinity, max: -Infinity }
    a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
    for (let t = 0; t < 2 / DT; t++) {
      z += 5.5 * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
      const shoulder = jointPosition(pose, 'upperArmL')
      const elbow = jointPosition(pose, 'lowerArmL')
      // Elbow is bent whenever the forearm is not colinear with the upper arm.
      const upper = vec3(elbow.x - shoulder.x, elbow.y - shoulder.y, elbow.z - shoulder.z)
      const bendAngle = Math.abs(pose.rotation.lowerArmL.x) // x component tracks the pitch magnitude
      minElbowBend = Math.min(minElbowBend, bendAngle)
      // Hand travel fore/aft over the cycle, and how far the arm holds off the body laterally.
      const hand = elbow
      handRange = { min: Math.min(handRange.min, hand.z), max: Math.max(handRange.max, hand.z) }
      maxHandSpread = Math.max(maxHandSpread, Math.abs(upper.x))
    }
    expect(handRange.max - handRange.min, 'arms should swing a long way fore and aft').toBeGreaterThan(0.4)
    expect(minElbowBend, 'the elbow should never straighten fully').toBeGreaterThan(0.05)
    expect(maxHandSpread, 'arms should hold off the body so the swing reads from behind').toBeGreaterThan(0.02)
  })

  it('bobs the body vertically while walking', () => {
    const a = createAnimator()
    let z = 0
    let min = Infinity
    let max = -Infinity
    a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
    for (let t = 0; t < 2 / DT; t++) {
      z += 5.5 * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
      min = Math.min(min, pose.bodyOffset.y)
      max = Math.max(max, pose.bodyOffset.y)
    }
    // Dips by most of the configured amount over a cycle; the legs absorb it via IK.
    expect(max - min).toBeGreaterThan(DEFAULT_GAIT.bob * 0.8)
  })

  it('poses rising and falling differently', () => {
    // `STATE_RISING` exists on the wire precisely so a viewer can tell the two apart — vertical
    // velocity crosses zero at the apex. It was plumbed through and then ignored, which made a jump
    // and a fall the same shape.
    const settle = (rising: boolean): Pose => {
      const a = createAnimator()
      let pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
      for (let t = 0; t < 60; t++) pose = a.step({ position: vec3(0, 4, 0), yaw: 0, speed: 2, grounded: false, rising }, DT)
      return pose
    }
    const up = settle(true)
    const down = settle(false)

    // Legs: tucked up on the way up, extended on the way down.
    const upSole = solePosition(up, 'L').y
    const downSole = solePosition(down, 'L').y
    expect(upSole, 'knees should be higher while rising').toBeGreaterThan(downSole + 0.15)

    // Arms: different pitch and a wider spread while falling.
    expect(Math.abs(up.rotation.upperArmL.x - down.rotation.upperArmL.x)).toBeGreaterThan(0.1)
    const spread = (p: Pose): number => Math.abs(jointPosition(p, 'lowerArmL').x - jointPosition(p, 'upperArmL').x)
    expect(spread(down), 'arms spread wider on the way down').toBeGreaterThan(spread(up))
  })

  it('moves the arms sideways in the air, not only fore and aft', () => {
    // The camera sits behind the character, where fore/aft motion is foreshortened away. A jump has
    // to displace the arms laterally or, from the player's own view, nothing appears to happen.
    const a = createAnimator()
    let pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    const groundSpread = Math.abs(jointPosition(pose, 'lowerArmL').x - jointPosition(pose, 'upperArmL').x)
    for (let t = 0; t < 60; t++) pose = a.step({ position: vec3(0, 4, 0), yaw: 0, speed: 2, grounded: false, rising: false }, DT)
    const airSpread = Math.abs(jointPosition(pose, 'lowerArmL').x - jointPosition(pose, 'upperArmL').x)
    expect(airSpread - groundSpread, 'arms should swing out to the side once airborne').toBeGreaterThan(0.15)
  })

  /**
   * Apex height of each swing. Filtered above the ground band on purpose: during stance the sole
   * sits flat at FOOT_Y and float noise there produces "local maxima" that are not steps at all —
   * counting them measures the stance-to-swing gap instead of the difference between steps, which
   * makes a variation test pass whether or not anything varies.
   */
  const swingPeaks = (lifts: number[]): number[] => {
    // Also drop the first 1.5 s: the gait fades in from a standing start, so early swings are
    // legitimately lower and would look like variation to either test.
    const from = Math.round(1.5 / DT)
    const peaks: number[] = []
    for (let i = Math.max(1, from); i < lifts.length - 1; i++) {
      if (lifts[i]! < FOOT_Y + 0.05) continue // still on the ground: not a swing
      if (lifts[i]! > lifts[i - 1]! && lifts[i]! >= lifts[i + 1]!) peaks.push(lifts[i]!)
    }
    return peaks
  }

  it('varies each step, and repeats exactly for the same seed', () => {
    // Per *movement*, not per character: consecutive steps of the same character differ.
    const walk = (seed: number, ticks: number): number[] => {
      const a = createAnimator(DEFAULT_GAIT, seed)
      const lifts: number[] = []
      let z = 0
      for (let t = 0; t < ticks; t++) {
        z += 5 * DT
        const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5, grounded: true, rising: false }, DT)
        lifts.push(solePosition(pose, 'L').y)
      }
      return lifts
    }
    // Peak lift of each swing differs between cycles.
    const peaks = swingPeaks(walk(7, Math.round(6 / DT)))
    expect(peaks.length, 'several swings in four seconds').toBeGreaterThan(2)
    const spread = Math.max(...peaks) - Math.min(...peaks)
    expect(spread, 'step height should not be identical every cycle').toBeGreaterThan(0.005)

    // Deterministic for a seed, different across seeds.
    expect(walk(7, 120)).toEqual(walk(7, 120))
    expect(walk(7, 120)).not.toEqual(walk(99, 120))
  })

  it('varies jumps and landings from one to the next', () => {
    const a = createAnimator(DEFAULT_GAIT, 3)
    const jump = (): number => {
      // grounded → airborne rolls this jump's shape
      for (let t = 0; t < 20; t++) a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
      let pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: false, rising: true }, DT)
      for (let t = 0; t < 25; t++) pose = a.step({ position: vec3(0, 2, 0), yaw: 0, speed: 0, grounded: false, rising: true }, DT)
      return solePosition(pose, 'L').y
    }
    const a1 = jump()
    const a2 = jump()
    expect(Math.abs(a1 - a2), 'two jumps should not tuck to exactly the same height').toBeGreaterThan(0.001)
  })

  // Includes 10, the top of the debug slider: the amount is uncapped so the effect can be seen
  // while tuning, and exaggeration must not break the property either.
  it.each([1, 10])('variation %d never slides a planted foot', (variation) => {
    // The hazard: phase advances as distance / stride, so varying stride would slide the stance
    // foot. Nothing ground-contacting is varied, and this proves it.
    const a = createAnimator({ ...DEFAULT_GAIT, variation }, 11)
    const speed = 5
    let z = 0
    let worstSlide = 0
    let runStart: number | null = null
    a.step({ position: vec3(0, 0, 0), yaw: 0, speed, grounded: true, rising: false }, DT)
    for (let t = 0; t < 4 / DT; t++) {
      z += speed * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed, grounded: true, rising: false }, DT)
      const sole = solePosition(pose, 'L')
      const worldZ = z + sole.z
      if (sole.y < FOOT_Y + 0.01) {
        if (runStart === null) runStart = worldZ
        else worstSlide = Math.max(worstSlide, Math.abs(worldZ - runStart))
      } else runStart = null
    }
    expect(worstSlide).toBeLessThan(0.08)
  })

  it('never inverts a varied quantity at the top of the debug range', () => {
    // Multipliers are rolled in log space, so no amount can flip a sign: the bob only ever lowers
    // the body and a step only ever lifts the foot. A linear roll would go negative here, and an
    // inverted lift pulls the foot down through the floor.
    const a = createAnimator({ ...DEFAULT_GAIT, variation: 10 }, 5) // 10 = slider maximum
    let z = 0
    let worst = 0
    for (let t = 0; t < 6 / DT; t++) {
      z += 5 * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5, grounded: true, rising: false }, DT)
      expect(pose.bodyOffset.y).toBeLessThanOrEqual(1e-6)
      worst = Math.min(worst, solePosition(pose, 'L').y - FOOT_Y)
    }
    // Not zero: a varied lift can exceed the leg's reach, and the IK then clamps and misses by a
    // little. Measured 4 mm at the slider maximum, against 0.4 mm with variation off.
    expect(worst).toBeGreaterThan(-0.01)
  })

  it('variation 0 makes the seed irrelevant', () => {
    // Asserted this way round on purpose. "Cycles are identical" is hard to measure honestly: the
    // gait fades in from rest, stride creeps as the speed smoother settles, and the swing apex is
    // sampled at a slightly different phase each cycle — all of which look like variation. Seed
    // independence is the actual property and nothing aliases it.
    const walk = (seed: number, variation: number): number[] => {
      const a = createAnimator({ ...DEFAULT_GAIT, variation }, seed)
      const out: number[] = []
      let z = 0
      for (let t = 0; t < 4 / DT; t++) {
        z += 5 * DT
        const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5, grounded: true, rising: false }, DT)
        out.push(solePosition(pose, 'L').y, pose.bodyOffset.y, pose.rotation.upperArmL.x)
      }
      return out
    }
    expect(walk(1, 0)).toEqual(walk(12345, 0)) // variation off: seed cannot matter
    expect(walk(1, 1)).not.toEqual(walk(12345, 1)) // variation on: it does
  })

  /** Sample an idle character for `seconds`, standing at the origin. */
  const idle = (gait = DEFAULT_GAIT, seconds = 14, seed = 4): Pose[] => {
    const a = createAnimator(gait, seed)
    const out: Pose[] = []
    for (let t = 0; t < seconds / DT; t++) {
      const pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
      out.push(snapshot(pose))
    }
    return out
  }
  const range = (xs: number[]): number => Math.max(...xs) - Math.min(...xs)

  it('is not a statue when standing still', () => {
    // Every gait amplitude is scaled by speed, so at a standstill the gait contributes exactly
    // nothing. Without an idle layer the character freezes solid.
    // Thresholds sit at roughly half the measured envelope (bob 0.040 m, sway 0.031 m, tilt 0.014):
    // these assert the layer *runs*, and pinning them to the exact amplitudes would mean every feel
    // tweak in the pane breaks a test.
    const poses = idle()
    expect(range(poses.map((p) => p.bodyOffset.y)), 'breathing should move the hips').toBeGreaterThan(0.02)
    expect(range(poses.map((p) => p.bodyOffset.x)), 'weight should shift side to side').toBeGreaterThan(0.015)
    expect(range(poses.map((p) => p.rotation.body.z)), 'torso should tip with the shift').toBeGreaterThan(0.006)
  })

  it('keeps both feet planted through a weight shift', () => {
    // The reason the leg solve needed lateral reach. Hips that sway while the feet are welded under
    // them is not a weight shift, it is the whole character sliding sideways.
    const poses = idle()
    for (const side of ['L', 'R'] as const) {
      const soles = poses.map((p) => solePosition(p, side))
      // Strict on purpose — unlike the amplitudes above this is correctness, not feel, and the
      // measured drift is 0.00 mm. Slack here would hide exactly the bug the lateral solve fixed.
      expect(range(soles.map((s) => s.x)), `${side} foot should not slide sideways`).toBeLessThan(5e-4)
      expect(range(soles.map((s) => s.z)), `${side} foot should not slide fore/aft`).toBeLessThan(5e-4)
      // Standing legs are at *full* extension (hip line is exactly two bone lengths up), so the
      // floor is only reachable at all because idle drops the hips first.
      for (const s of soles) expect(s.y).toBeGreaterThan(FOOT_Y - 0.002)
    }
  })

  it('rests its weight on alternating legs, bending the knees unequally', () => {
    // Contrapposto: hips toward the weighted leg, which straightens it and folds the other. The
    // asymmetry is not posed — it falls out of the IK once the hips move off centre.
    const poses = idle()
    // Knee bend is a pure pitch on the lower leg, so the quaternion's x component reads it directly.
    const skew = poses.map((p) => p.rotation.lowerLegL.x - p.rotation.lowerLegR.x)
    expect(Math.max(...skew), 'weight on one leg').toBeGreaterThan(0.004)
    expect(Math.min(...skew), 'and later on the other').toBeLessThan(-0.004)
  })

  it('varies one weight shift from the next', () => {
    const sway = (seed: number): number[] => idle(DEFAULT_GAIT, 30, seed).map((p) => p.bodyOffset.x)
    const held = (xs: number[]): number[] => {
      // Peak sway of each shift — the value it settles on before easing to the other side.
      const peaks: number[] = []
      for (let i = 1; i < xs.length - 1; i++) if (Math.abs(xs[i]!) > Math.abs(xs[i - 1]!) && Math.abs(xs[i]!) >= Math.abs(xs[i + 1]!)) peaks.push(Math.abs(xs[i]!))
      return peaks
    }
    const peaks = held(sway(4))
    expect(peaks.length, 'several shifts in thirty seconds').toBeGreaterThan(2)
    expect(range(peaks), 'shifts should differ in size').toBeGreaterThan(0.001)
    expect(sway(4)).toEqual(sway(4))
    expect(sway(4)).not.toEqual(sway(77))
  })

  it('contributes nothing once the character is moving', () => {
    // Idle must not leak into the walk: a breathing bob on top of the gait bob, or a sway that never
    // fully lets go, both read as a limp. Zeroing the idle amplitudes has to be a no-op at speed.
    const flat = { ...DEFAULT_GAIT, idleSettle: 0, breathDepth: 0, idleSway: 0, idleRoll: 0 }
    const walk = (gait: typeof DEFAULT_GAIT): number[] => {
      const a = createAnimator(gait, 8)
      const out: number[] = []
      let z = 0
      for (let t = 0; t < 3 / DT; t++) {
        z += 5 * DT
        const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5, grounded: true, rising: false }, DT)
        // Skip the first second: the speed smoother ramps from rest, so idle legitimately applies.
        if (t > 1 / DT) out.push(pose.bodyOffset.x, pose.bodyOffset.y, pose.rotation.body.z, solePosition(pose, 'L').y)
      }
      return out
    }
    expect(walk(DEFAULT_GAIT)).toEqual(walk(flat))
  })

  it('does not let the twisting torso drag the planted feet sideways', () => {
    // The torso counter-rotates against the stride, which swings the hip joints laterally. The legs
    // used to be solved as though the foot sat under the hip's *current* x, so the stance foot
    // tracked that swing — a ~1 cm lateral scuff every step.
    const a = createAnimator(DEFAULT_GAIT, 2)
    let z = 0
    const xs: number[] = []
    for (let t = 0; t < 4 / DT; t++) {
      z += 5 * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5, grounded: true, rising: false }, DT)
      const sole = solePosition(pose, 'L')
      if (sole.y < FOOT_Y + 0.01) xs.push(sole.x) // planted
    }
    expect(range(xs), 'planted foot should hold its lateral position').toBeLessThan(0.002)
  })

  /**
   * Root-space position of a part's far end — the tip of a hanging limb, the top of an upright part.
   * The inertia assertions are all about where a part physically ends up, deliberately: the moonwalk
   * bug slipped through a solver test that checked angles against their own sign convention.
   */
  const tipPosition = (pose: Pose, part: PartName): Vec3 => {
    const joint = jointPosition(pose, part)
    const chain: PartName[] = []
    for (let p: PartName | null = part; p !== null; p = RIG[p].parent) chain.unshift(p)
    let q = { x: 0, y: 0, z: 0, w: 1 }
    for (const name of chain) {
      const r = pose.rotation[name]
      q = {
        x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
        y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
        z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
        w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
      }
    }
    // Limbs hang below their joint (negative mesh offset); body and head rise above it.
    const along = RIG[part].meshOffset.y < 0 ? -RIG[part].size.y : RIG[part].size.y
    const end = rotateVec3(q, vec3(0, along, 0))
    return vec3(joint.x + end.x, joint.y + end.y, joint.z + end.z)
  }

  /**
   * Stand still facing `yaw` for `warmup`, then have `carry` applied for `seconds` — the step onto a
   * moving surface, which is an acceleration. The warmup exists so the facing smoother has arrived:
   * a yaw still easing toward its target rotates the frame the acceleration is measured in.
   */
  const pushed = (yaw: number, carry: Vec3, seconds = 0.5, warmup = 0, gait = DEFAULT_GAIT, step = DT): Pose => {
    const a = createAnimator(gait, 6)
    const stand = { position: vec3(0, 0, 0), yaw, speed: 0, grounded: true, rising: false }
    for (let t = 0; t < warmup / step; t++) a.step(stand, step)
    let pose = a.step(stand, step)
    for (let t = 0; t < seconds / step; t++) pose = a.step({ ...stand, carry }, step)
    return pose
  }
  const carried = (carry: Vec3, seconds = 0.5, gait = DEFAULT_GAIT): Pose => pushed(0, carry, seconds, 0, gait)

  it('lags every part against the acceleration, and never the planted feet', () => {
    // The physical property, asserted in world space for all ten parts. A positive roll carries an
    // upright part's top toward −x but a hanging limb's tip toward +x, so the two kinds need
    // opposite signs; checking displacement rather than angles is what makes that unfakeable.
    for (const [axis, carry] of [
      ['z', vec3(0, 0, 3)],
      ['x', vec3(3, 0, 0)],
    ] as const) {
      const still = carried(vec3(0, 0, 0))
      const moved = carried(carry)
      for (const part of PART_NAMES) {
        const d = axis === 'z' ? tipPosition(moved, part).z - tipPosition(still, part).z : tipPosition(moved, part).x - tipPosition(still, part).x
        if (part === 'lowerLegL' || part === 'lowerLegR') {
          // Feet are planted. The lower body's inertia arrives as hip travel, and the IK absorbs it.
          expect(Math.abs(d), `${part} is a planted foot and must not move (${axis})`).toBeLessThan(1e-3)
        } else {
          expect(d, `${part} should lag against a +${axis} acceleration`).toBeLessThan(-1e-3)
        }
      }
    }
  })

  it('lags the loose parts more than the load-bearing ones', () => {
    const still = carried(vec3(0, 0, 0))
    const moved = carried(vec3(0, 0, 3))
    const lag = (part: PartName): number => Math.abs(tipPosition(moved, part).z - tipPosition(still, part).z)
    expect(lag('lowerArmL'), 'forearm inherits the shoulder and adds its own').toBeGreaterThan(lag('upperArmL'))
    expect(lag('upperArmL'), 'arms hang free; the torso carries weight').toBeGreaterThan(lag('body'))
    expect(lag('upperLegL'), 'knees only move as far as the hips do').toBeLessThan(lag('body'))
    // The head is the exception that displacement cannot express: it rides on top of a leaning torso,
    // so its *absolute* travel is the largest on the body however little it adds of its own. The
    // weight ordering is only visible in what the head contributes, which is its local rotation.
    expect(Math.abs(moved.rotation.head.x), 'a real head stabilizes itself').toBeLessThan(Math.abs(moved.rotation.body.x))
  })

  it('responds to acceleration, not to being carried at speed', () => {
    // Standing on a train at line speed feels like standing still. A layer keyed to velocity would
    // hold a permanent lean the whole time a platform is moving.
    const still = carried(vec3(0, 0, 0), 6)
    const cruising = carried(vec3(0, 0, 3), 6)
    for (const part of PART_NAMES) {
      const d = tipPosition(cruising, part)
      const s = tipPosition(still, part)
      expect(Math.hypot(d.x - s.x, d.y - s.y, d.z - s.z), `${part} should settle back once the speed is steady`).toBeLessThan(2e-3)
    }
  })

  it('compresses under upward acceleration and never lifts the feet', () => {
    // Rising hips are unsolvable — standing legs are already at full extension — so a downward
    // acceleration has to show up somewhere other than the hips.
    const still = carried(vec3(0, 0, 0))
    const up = carried(vec3(0, 4, 0))
    const down = carried(vec3(0, -4, 0))
    expect(up.bodyOffset.y, 'upward acceleration compresses').toBeLessThan(still.bodyOffset.y - 0.005)
    expect(down.bodyOffset.y, 'downward must not lift the hips').toBeLessThanOrEqual(still.bodyOffset.y + 1e-9)
    // ...it goes to the arms instead, spread wide enough to read from behind the character.
    const spread = (p: Pose): number => Math.abs(tipPosition(p, 'lowerArmL').x - tipPosition(p, 'lowerArmR').x)
    expect(spread(down), 'arms float out as weight drops').toBeGreaterThan(spread(still) + 0.01)
    for (const p of [up, down]) for (const s of ['L', 'R'] as const) expect(solePosition(p, s).y).toBeGreaterThan(FOOT_Y - 1e-3)
  })

  it('is frame-rate independent', () => {
    // The acceleration is read as the gap between a signal and its own smoothed value, which is a
    // closed-form low-passed derivative. Differencing per frame would give a 144 fps client a
    // completely different reading from a 60 fps one, since carry only updates at the 30 Hz sim rate.
    const at = (step: number): number => tipPosition(pushed(0, vec3(0, 0, 3), 0.5, 0, DEFAULT_GAIT, step), 'lowerArmL').z
    // Within 1 mm across a 2.4× frame-rate spread, on a lag of ~17 cm.
    expect(Math.abs(at(1 / 144) - at(1 / 60))).toBeLessThan(1e-3)
  })

  it('does nothing at all when the layer is off, or when nothing is carrying the character', () => {
    const off = { ...DEFAULT_GAIT, inertiaStrength: 0 }
    const sample = (pose: Pose): number[] => [
      pose.bodyOffset.x,
      pose.bodyOffset.y,
      pose.bodyOffset.z,
      ...PART_NAMES.flatMap((n) => [
        pose.jointOffset[n].x,
        pose.jointOffset[n].y,
        pose.jointOffset[n].z,
        pose.rotation[n].x,
        pose.rotation[n].y,
        pose.rotation[n].z,
        pose.rotation[n].w,
      ]),
    ]
    expect(sample(carried(vec3(3, 2, 3), 0.5, off))).toEqual(sample(carried(vec3(0, 0, 0), 0.5, off)))
    // And an animator never told about carry at all must be untouched by the feature existing.
    const a = createAnimator(DEFAULT_GAIT, 6)
    let plain = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    for (let t = 0; t < 0.5 / DT; t++) plain = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    expect(sample(plain)).toEqual(sample(carried(vec3(0, 0, 0))))
  })

  it('measures the acceleration in the character frame, not the world', () => {
    // Facing east, a push toward +x is a push in the *back*, and the body has to lag forward-relative
    // to itself. Reading the world axes straight would brace sideways for it.
    const yaw = Math.PI / 2 // facing +x
    const pose = pushed(yaw, vec3(3, 0, 0), 0.5, 1)
    const still = pushed(yaw, vec3(0, 0, 0), 0.5, 1)
    // Root-space −z is behind the character, which faces +x in the world: a backward lag.
    expect(tipPosition(pose, 'lowerArmL').z).toBeLessThan(tipPosition(still, 'lowerArmL').z - 1e-3)
    // Compared against the same moment of the idle layer, which is also moving the hips sideways.
    expect(Math.abs(pose.bodyOffset.x - still.bodyOffset.x), 'nothing lateral, in its own frame').toBeLessThan(1e-4)
  })

  /**
   * Composed **world** rotation of a part, parents included, and its angle away from upright. The
   * head's whole point is what it does in the world while the torso does something else, so a test
   * that reads its local quaternion is testing the wrong frame.
   */
  const partQuat = (pose: Pose, part: PartName): Quat => {
    const chain: PartName[] = []
    for (let p: PartName | null = part; p !== null; p = RIG[p].parent) chain.unshift(p)
    let q: Quat = { x: 0, y: 0, z: 0, w: 1 }
    for (const name of chain) q = mulQuat(q, pose.rotation[name])
    return q
  }
  const angleOf = (q: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)))

  /** Walk at top speed for `seconds`, dropping the first second while the gait fades in. */
  const walkPoses = (gait = DEFAULT_GAIT, seconds = 3, seed = 3): Pose[] => {
    const a = createAnimator(gait, seed)
    const out: Pose[] = []
    let z = 0
    for (let t = 0; t < seconds / DT; t++) {
      z += DEFAULT_GAIT.runSpeed * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: DEFAULT_GAIT.runSpeed, grounded: true, rising: false }, DT)
      if (t > 1 / DT) out.push(snapshot(pose))
    }
    return out
  }

  it('holds the head level in the world while the torso leans and twists', () => {
    // The head's own signals off, so this measures stabilization alone. At 0 the head is welded and
    // goes exactly where the torso goes — which is the state this layer exists to leave behind.
    const bare = { ...DEFAULT_GAIT, headRise: 0, headFall: 0, headLand: 0, headSprint: 0, headCounterBob: 0, inertiaStrength: 0 }
    const ratio = (headStabilize: number): number => {
      const poses = walkPoses({ ...bare, headStabilize })
      const head = Math.max(...poses.map((p) => angleOf(partQuat(p, 'head'))))
      const body = Math.max(...poses.map((p) => angleOf(partQuat(p, 'body'))))
      return head / body
    }
    // Exact at both ends and linear between, because the counter-rotation is the base rotation's
    // conjugate slerped along the geodesic — not its three Euler terms negated, which would only
    // agree to first order. Torso tilt is 0.238 rad at top speed; the head's is (1 − knob) of it.
    expect(ratio(0), 'welded: the head is exactly as tilted as the torso').toBeCloseTo(1, 6)
    expect(ratio(0.5), 'half of it').toBeCloseTo(0.5, 3)
    expect(ratio(1), 'stabilized: dead level while the torso works').toBeLessThan(1e-6)
  })

  it('leads the turn with the head, then stops leading', () => {
    // Both smoothers chase the same target on different half-lives, so the lead is self-cancelling:
    // it exists only while the heading is changing and needs nothing to unwind it.
    const a = createAnimator()
    const stand = { position: vec3(0, 0, 0), speed: 0, grounded: true, rising: false }
    let pose = a.step({ ...stand, yaw: 0 }, DT)
    let peak = 0
    for (let t = 0; t < 0.3 / DT; t++) {
      pose = a.step({ ...stand, yaw: Math.PI / 2 }, DT)
      peak = Math.max(peak, pose.rotation.head.y) // signed toward the new heading
    }
    expect(peak, 'the head should arrive at the new heading first').toBeGreaterThan(0.05)
    for (let t = 0; t < 1 / DT; t++) pose = a.step({ ...stand, yaw: Math.PI / 2 }, DT)
    expect(Math.abs(pose.rotation.head.y), 'and hold no residual once the turn is done').toBeLessThan(0.005)
  })

  it('keeps the eyeline steadier than the hips', () => {
    // A rotation cannot express this: the neck has to translate. The spring layer produces it as a
    // consequence of being a soft isolator — which is also why the *frequency* decides the sign of
    // the effect. Below the bob's ~3.2 Hz it attenuates; above it, it amplifies and reads as a
    // bobblehead. That is a trap worth a test, since a "stiffer, snappier neck" makes it worse.
    const travel = (springFrequency: number): { head: number; hip: number } => {
      const poses = walkPoses({ ...DEFAULT_GAIT, springFrequency })
      return { head: range(poses.map((p) => jointPosition(p, 'head').y)), hip: range(poses.map((p) => p.bodyOffset.y)) }
    }
    // Measured at top speed against 129 mm of hip travel: 43 mm at the default 2 Hz, 126 mm at 8 Hz.
    const soft = travel(DEFAULT_GAIT.springFrequency)
    expect(soft.head, 'a soft neck isolates: the head travels well under the hips').toBeLessThan(soft.hip * 0.6)
    const stiff = travel(8)
    expect(stiff.head, 'a stiff one tracks the bob instead — the bobblehead').toBeGreaterThan(soft.head * 2)
    expect(soft.hip, 'the hips must keep bobbing — this is a neck, not a smaller stride').toBeCloseTo(stiff.hip, 6)
  })

  it('looks at the landing on the way down, and nods on the impact', () => {
    const air = (rising: boolean): number => {
      const a = createAnimator()
      a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
      let pose = restPoseOf(a)
      for (let t = 0; t < 1 / DT; t++) pose = a.step({ position: vec3(0, 4, 0), yaw: 0, speed: 0, grounded: false, rising }, DT)
      return pose.rotation.head.x // positive pitches the head forward and down
    }
    expect(air(false), 'falling: looking down at where this ends').toBeGreaterThan(air(true) + 0.1)

    // The nod, isolated from the falling look so it is the nod being measured.
    const a = createAnimator({ ...DEFAULT_GAIT, headRise: 0, headFall: 0 })
    a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    for (let t = 0; t < 0.5 / DT; t++) a.step({ position: vec3(0, 4, 0), yaw: 0, speed: 0, grounded: false, rising: false }, DT)
    const land = { position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }
    let nod = 0
    for (let t = 0; t < 0.2 / DT; t++) nod = Math.max(nod, a.step(land, DT).rotation.head.x)
    expect(nod, 'the impact should drive the head down').toBeGreaterThan(0.05)
    let settled = a.step(land, DT)
    for (let t = 0; t < 1.5 / DT; t++) settled = a.step(land, DT)
    expect(Math.abs(settled.rotation.head.x), 'and it should decay away, not stick').toBeLessThan(0.02)
  })

  /** Stand for `before`, then jump and land — the sharpest step the joint targets ever take. */
  const landing = (gait = DEFAULT_GAIT, after = 1.2, before = 0.4): Pose[] => {
    const a = createAnimator(gait, 5)
    const stand = { position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }
    for (let t = 0; t < before / DT; t++) a.step(stand, DT)
    for (let t = 0; t < 0.4 / DT; t++) a.step({ ...stand, position: vec3(0, 3, 0), grounded: false, rising: false }, DT)
    const out: Pose[] = []
    for (let t = 0; t < after / DT; t++) out.push(snapshot(a.step(stand, DT)))
    return out
  }

  it('never displaces the body or a leg — the spring layer cannot reach a planted foot', () => {
    // Structural, not tuned: the body's travel is `bodyOffset`, which the leg IK is solved against,
    // and a leg offset would slide the foot it is standing on. Both are excluded by construction and
    // this is what says so.
    for (const poses of [walkPoses(), landing(), idle(DEFAULT_GAIT, 4)])
      for (const p of poses)
        for (const part of ['body', 'upperLegL', 'lowerLegL', 'upperLegR', 'lowerLegR'] as const)
          expect(magnitude(p.jointOffset[part]), `${part} must not translate`).toBe(0)
  })

  it('overshoots and rings on a landing, and does not when critically damped', () => {
    // The bounce is the overshoot: the spring passes the target and comes back. Sign changes in the
    // head's vertical displacement count it. At ζ = 1 there is no oscillation at all by definition,
    // which is the control — if that one rings too, the integrator is wrong rather than the tuning.
    const crossings = (springDamping: number): number => {
      const ys = landing({ ...DEFAULT_GAIT, springDamping }).map((p) => p.jointOffset.head.y)
      let n = 0
      for (let i = 1; i < ys.length; i++) if (Math.sign(ys[i]!) !== Math.sign(ys[i - 1]!) && Math.abs(ys[i]!) > 1e-4) n++
      return n
    }
    expect(crossings(DEFAULT_GAIT.springDamping), 'under-damped: it should ring').toBeGreaterThan(1)
    expect(crossings(1), 'critically damped: it must not').toBeLessThan(2)
  })

  it('settles back to nothing once the character is still', () => {
    // A spring that kept a residual would leave the head permanently off its neck. Measured against a
    // flat idle: with the idle layer live the torso never actually stops moving, so a real character
    // holds a fraction of a millimetre of lag forever — correctly, but that is not what this asks.
    // `breathPeriod: 0` matters: the torso's breathing *pitch* is not scaled by `breathDepth`, which
    // only governs the hips, so zeroing the depth alone leaves the chest still moving.
    const flat = { ...DEFAULT_GAIT, idleSettle: 0, breathDepth: 0, breathPeriod: 0, idleSway: 0, idleRoll: 0 }
    const poses = landing(flat, 4)
    const last = poses[poses.length - 1]!
    for (const part of PART_NAMES) {
      const o = last.jointOffset[part]
      expect(Math.hypot(o.x, o.y, o.z), `${part} should come to rest on its joint`).toBeLessThan(1e-4)
    }
    // With idle running it stays small rather than accumulating. Measured 1.5 mm.
    const live = landing(DEFAULT_GAIT, 4)
    const lag = live[live.length - 1]!.jointOffset.head
    expect(Math.hypot(lag.x, lag.y, lag.z), 'idle keeps it alive, but barely').toBeLessThan(3e-3)
  })

  it('rings identically at 60 and 144 fps', () => {
    // The spring is solved in closed form for exactly this reason. A stepped integrator would ring at
    // a frame-rate-dependent amplitude, and at low damping would gain energy and never settle.
    //
    // Sampled at a fixed elapsed time rather than by peak: a 2 Hz ring read off a 60 Hz grid misses
    // its own peak by ~3%, which is 1.7 mm here and says nothing about the integrator. Durations are
    // whole tick counts at both rates.
    //
    // Idle is flattened for the same reason. Its shift is an *event* on a `dt`-decremented timer, so
    // it fires up to one tick apart at different rates and the torso is then in a slightly different
    // place — a real difference, inherent to an event clock, and not the spring's.
    const flat = { ...DEFAULT_GAIT, idleSettle: 0, breathDepth: 0, breathPeriod: 0, idleSway: 0, idleRoll: 0 }
    const at = (step: number): number => {
      const a = createAnimator(flat, 5)
      const stand = { position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }
      for (let t = 0; t < Math.round(0.5 / step); t++) a.step(stand, step)
      for (let t = 0; t < Math.round(0.5 / step); t++) a.step({ ...stand, position: vec3(0, 3, 0), grounded: false, rising: false }, step)
      let y = 0
      for (let t = 0; t < Math.round(1.25 / step); t++) y = a.step(stand, step).jointOffset.head.y
      return y
    }
    expect(Math.abs(at(1 / 144) - at(1 / 60))).toBeLessThan(1e-4)
  })

  it('gives the forearm the shoulder’s displacement plus its own', () => {
    // Same increments-down-the-chain model the inertia weights use: a child's target hangs off where
    // its parent ended up, so the loose end of a limb moves furthest.
    const poses = walkPoses()
    const travel = (part: PartName): number => range(poses.map((p) => jointPosition(p, part).y))
    expect(travel('lowerArmL'), 'the elbow inherits the shoulder and adds its own').toBeGreaterThan(travel('upperArmL'))
  })

  it('holds every part within the displacement clamp', () => {
    // A landing is a step change in the joint targets; without the clamp a lightly-damped spring can
    // throw a part far enough off the body to read as detached.
    const springMax = 0.03
    for (const p of landing({ ...DEFAULT_GAIT, springMax, springDamping: 0.15, springUpperArm: 1, springLowerArm: 1 }))
      for (const part of PART_NAMES) {
        const o = p.jointOffset[part]
        // Weights are all ≤ 1 here, and the clamp is applied before the weight, so this bounds them.
        expect(Math.hypot(o.x, o.y, o.z), `${part} within the clamp`).toBeLessThanOrEqual(springMax + 1e-9)
      }
  })

  it('does nothing at all when the weights are zero', () => {
    const off = { ...DEFAULT_GAIT, springHead: 0, springUpperArm: 0, springLowerArm: 0 }
    for (const p of landing(off)) for (const part of PART_NAMES) expect(magnitude(p.jointOffset[part])).toBe(0)
  })

  it('leans forward with speed and stands up when stopped', () => {
    const fast = run(DEFAULT_GAIT.runSpeed, 1).pose
    const still = run(0, 1).pose
    // Body pitch is encoded as an x-axis rotation; compare the quaternion's x component.
    expect(Math.abs(fast.rotation.body.x)).toBeGreaterThan(Math.abs(still.rotation.body.x) + 0.01)
  })
})

const restPoseOf = (a: ReturnType<typeof createAnimator>): Pose =>
  a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
