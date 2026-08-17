import { mulQuat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { createAnimator, solveTwoBone, DEFAULT_GAIT } from './animate'
import { CHAR_HEIGHT, FOOT_Y, HIP_HEIGHT, LIMB_LENGTH, RIG, PART_NAMES, partTransforms, restPose, type PartName, type Pose } from './rig'

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

/**
 * Composed **root-space** rotation of a part â€” every local rotation from the body down, without the root
 * yaw. The moonwalk bug went through a solver test that checked angles against their own convention, so
 * the assertions built on this one are about where things physically end up.
 */
const partQuatOf = (pose: Pose, part: PartName): Quat => {
  const chain: PartName[] = []
  for (let p: PartName | null = part; p !== null; p = RIG[p].parent) chain.unshift(p)
  let q: Quat = { x: 0, y: 0, z: 0, w: 1 }
  for (const name of chain) q = mulQuat(q, pose.rotation[name])
  return q
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

describe('partTransforms', () => {
  // What a ragdoll is seeded from. If it disagrees with the walk a renderer does, the ten rigid bodies
  // start somewhere other than where the rig was drawn and every death begins with a visible jump.
  const origin = vec3(3, 1, -2)

  it('puts every box where the renderer puts it', () => {
    const a = createAnimator(DEFAULT_GAIT, 5)
    let z = 0
    let pose = a.step({ position: vec3(0, 0, 0), yaw: 0.7, speed: 5, grounded: true, rising: false }, DT)
    for (let t = 0; t < 40; t++) {
      z += 5 * DT
      pose = a.step({ position: vec3(0, 0, z), yaw: 0.7, speed: 5, grounded: true, rising: false }, DT)
    }
    const world = partTransforms(pose, origin)
    // Independent check: the test's own joint walk, plus the root yaw, plus `meshOffset` to reach the box.
    const rootQ = { x: 0, y: Math.sin(pose.yaw / 2), z: 0, w: Math.cos(pose.yaw / 2) }
    for (const name of PART_NAMES) {
      const jointLocal = jointPosition(pose, name)
      const turned = rotateVec3(rootQ, jointLocal)
      const q = mulQuat(rootQ, partQuatOf(pose, name))
      const centre = rotateVec3(q, RIG[name].meshOffset)
      expect(world[name].position.x, `${name} x`).toBeCloseTo(origin.x + turned.x + centre.x, 9)
      expect(world[name].position.y, `${name} y`).toBeCloseTo(origin.y + turned.y + centre.y, 9)
      expect(world[name].position.z, `${name} z`).toBeCloseTo(origin.z + turned.z + centre.z, 9)
      for (const axis of ['x', 'y', 'z', 'w'] as const) expect(world[name].rotation[axis], `${name} rot ${axis}`).toBeCloseTo(q[axis], 9)
    }
  })

  it('stands the rest pose on the ground, with the parts stacked', () => {
    const w = partTransforms(restPose(), vec3(0, 0, 0))
    // Sole of the lower leg: its box centre is half a segment above its foot.
    expect(w.lowerLegL.position.y - LIMB_LENGTH / 2).toBeCloseTo(FOOT_Y, 9)
    // Head box centre sits half a head above the top of the torso.
    expect(w.head.position.y).toBeGreaterThan(w.body.position.y)
    // Left and right mirror.
    expect(w.upperArmL.position.x).toBeCloseTo(-w.upperArmR.position.x, 9)
  })

  it('moves with the root, and turns with the yaw', () => {
    const flat = partTransforms(restPose(), vec3(0, 0, 0))
    const shifted = partTransforms(restPose(), vec3(10, 4, -7))
    expect(shifted.head.position.x - flat.head.position.x).toBeCloseTo(10, 9)
    expect(shifted.head.position.y - flat.head.position.y).toBeCloseTo(4, 9)
    // A quarter turn swaps the arms' lateral offset onto the other axis. Negated: a rotation about +y
    // carries +x toward −z, the same convention the renderer's `root.rotation.y` uses, and the same one
    // that makes the animator's `yaw = atan2(dx, dz)` mean forward is `(sin yaw, cos yaw)`.
    const turned = partTransforms({ ...restPose(), yaw: Math.PI / 2 }, vec3(0, 0, 0))
    expect(turned.upperArmL.position.z).toBeCloseTo(-flat.upperArmL.position.x, 9)
    expect(Math.abs(turned.upperArmL.position.x)).toBeLessThan(1e-9)
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
    // Never digs into the floorâ€¦
    expect(min).toBeGreaterThan(FOOT_Y - 0.03)
    // â€¦and does lift clear of it during swing.
    expect(max - min).toBeGreaterThan(0.1)
  })

  it('plants the stance foot in the world â€” it must not slide (no moonwalk)', () => {
    // The definitive test of walk direction. Travelling +z with yaw 0, a foot in its stance phase
    // has to hold still in *world* space: its local offset must move backward exactly as fast as
    // the body moves forward. If the limb pitch is mirrored, the local offset moves forward
    // instead and the planted foot slides at twice the body's speed â€” a moonwalk.
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
      const planted = sole.y < FOOT_Y + 0.01 // on the ground â†’ this foot is bearing weight
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

  it('bends knees like a human â€” shin swings back from a forward thigh', () => {
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
      // Knee's forward offset from the hipâ†’ankle chord.
      const span = vec3(ankle.x - hip.x, ankle.y - hip.y, ankle.z - hip.z)
      const mid = vec3(hip.x + span.x / 2, hip.y + span.y / 2, hip.z + span.z / 2)
      if (knee.z - mid.z > 0.02) sawForwardKnee = true
      expect(knee.z - mid.z, 'knee must never bow backward').toBeGreaterThan(-0.02)
    }
    expect(sawForwardKnee, 'knee should visibly lead during the cycle').toBe(true)
  })

  it('advances stride with distance, so the cycle count scales with speed not time', () => {
    // Same duration, double the speed â†’ about double the strides. Time-driven animation would
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
    // The same elapsed time at different frame rates must land in the same place â€” the flaw in the
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
    // The *tucked* leg, whichever side leads this jump â€” the other one is deliberately extended.
    const airSole = Math.max(solePosition(pose, 'L').y, solePosition(pose, 'R').y)
    for (let t = 0; t < 60; t++) pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    const groundSole = Math.max(solePosition(pose, 'L').y, solePosition(pose, 'R').y)
    expect(airSole, 'the leading knee tucks up while rising').toBeGreaterThan(groundSole + 0.15)
  })

  it('keeps the feet on the ground however hard the body leans and twists', () => {
    // The legs hang off the body, so lean and twist rotate the frame they are solved in. Solving as
    // though it were upright pushes the feet through the floor, and the error grows with the lean â€”
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
    // nothing â€” hence the splay â€” and a straight arm swinging from the shoulder reads as a mannequin.
    const a = createAnimator()
    let z = 0
    let minElbowBend = Infinity
    let maxHandSpread = 0
    let handRange = { min: Infinity, max: -Infinity }
    a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
    for (let t = 0; t < 2 / DT; t++) {
      z += 5.5 * DT
      const pose = a.step({ position: vec3(0, 0, z), yaw: 0, speed: 5.5, grounded: true, rising: false }, DT)
      // Skip the first half second, as the variation tests do. This harness jumps from a standstill to
      // top speed in one frame â€” a 330 m/sÂ² acceleration no controller can produce â€” and the inertial
      // layer answers it by straightening the elbow, which is not what the assertion below is about.
      if (t < 0.5 / DT) continue
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
    // `STATE_RISING` exists on the wire precisely so a viewer can tell the two apart â€” vertical
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

    // Legs: tucked up on the way up, extended on the way down. Highest sole either side, since only
    // the leading leg tucks.
    const upSole = Math.max(solePosition(up, 'L').y, solePosition(up, 'R').y)
    const downSole = Math.max(solePosition(down, 'L').y, solePosition(down, 'R').y)
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
   * sits flat at FOOT_Y and float noise there produces "local maxima" that are not steps at all â€”
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
      // grounded â†’ airborne rolls this jump's shape
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
    // sampled at a slightly different phase each cycle â€” all of which look like variation. Seed
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

  /**
   * Idle amplitudes off, for tests that need the torso to actually hold still. `breathPeriod: 0`
   * matters: the torso's breathing *pitch* is not scaled by `breathDepth`, which governs only the
   * hips, so zeroing the depth alone leaves the chest moving.
   */
  const FLAT_IDLE = { ...DEFAULT_GAIT, idleSettle: 0, breathDepth: 0, breathPeriod: 0, idleSway: 0, idleRoll: 0 }

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
      // Strict on purpose â€” unlike the amplitudes above this is correctness, not feel, and the
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
    // asymmetry is not posed â€” it falls out of the IK once the hips move off centre.
    const poses = idle()
    // Knee bend is a pure pitch on the lower leg, so the quaternion's x component reads it directly.
    const skew = poses.map((p) => p.rotation.lowerLegL.x - p.rotation.lowerLegR.x)
    expect(Math.max(...skew), 'weight on one leg').toBeGreaterThan(0.004)
    expect(Math.min(...skew), 'and later on the other').toBeLessThan(-0.004)
  })

  it('varies one weight shift from the next', () => {
    const sway = (seed: number): number[] => idle(DEFAULT_GAIT, 30, seed).map((p) => p.bodyOffset.x)
    const held = (xs: number[]): number[] => {
      // Peak sway of each shift â€” the value it settles on before easing to the other side.
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
    // tracked that swing â€” a ~1 cm lateral scuff every step.
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
   * Root-space position of a part's far end â€” the tip of a hanging limb, the top of an upright part.
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
   * Stand still facing `yaw` for `warmup`, then have `carry` applied for `seconds` â€” the step onto a
   * moving surface, which is an acceleration. The warmup exists so the facing smoother has arrived:
   * a yaw still easing toward its target rotates the frame the acceleration is measured in.
   */
  /**
   * `seconds` defaults to 1/12 â€” near the peak of the response, and an exact tick count at both 60 and
   * 144 fps for the frame-rate test. The layer measures acceleration over `inertiaSampleHalfLife`
   * (30 ms), so a step in carry is a short pulse; the old 0.5 s default sat in the tail of the 120 ms
   * window this used to share with the response smoothing, and now lands long after it has settled.
   */
  const pushed = (yaw: number, carry: Vec3, seconds = 1 / 12, warmup = 0, gait = DEFAULT_GAIT, step = DT): Pose => {
    const a = createAnimator(gait, 6)
    const stand = { position: vec3(0, 0, 0), yaw, speed: 0, grounded: true, rising: false }
    for (let t = 0; t < Math.round(warmup / step); t++) a.step(stand, step)
    let pose = a.step(stand, step)
    for (let t = 0; t < Math.round(seconds / step); t++) pose = a.step({ ...stand, carry }, step)
    return pose
  }
  const carried = (carry: Vec3, seconds = 1 / 12, gait = DEFAULT_GAIT): Pose => pushed(0, carry, seconds, 0, gait)

  it('lags every part against the acceleration, and never the planted feet', () => {
    // The physical property, asserted in world space for all ten parts. A positive roll carries an
    // upright part's top toward âˆ’x but a hanging limb's tip toward +x, so the two kinds need
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

  /**
   * Drive the animator through the controller's own speed profile â€” 0 â†’ 5.5 m/s in 0.1 s, hold, then
   * brake to a stop in 0.08 s â€” and return the poses of each phase separately.
   *
   * Those times are 55 m/sÂ² and 69 m/sÂ², 5.6 g and 7 g: the largest accelerations in the game by a
   * wide margin, and for a long time the only ones the animator never saw.
   */
  const locomotion = (gait = DEFAULT_GAIT): { ramp: Pose[]; steady: Pose[]; brake: Pose[] } => {
    const a = createAnimator(gait, 4)
    let z = 0
    let speed = 0
    const at = (s: number): Pose => {
      z += s * DT
      return snapshot(a.step({ position: vec3(0, 0, z), yaw: 0, speed: s, grounded: true, rising: false }, DT))
    }
    for (let t = 0; t < 1 / DT; t++) at(0)
    const ramp: Pose[] = []
    for (let t = 0; t < 0.35 / DT; t++) {
      speed = Math.min(DEFAULT_GAIT.runSpeed, speed + (DEFAULT_GAIT.runSpeed / 0.1) * DT)
      ramp.push(at(speed))
    }
    const steady: Pose[] = []
    for (let t = 0; t < 1.5 / DT; t++) steady.push(at(speed))
    const brake: Pose[] = []
    for (let t = 0; t < 0.35 / DT; t++) {
      speed = Math.max(0, speed - (DEFAULT_GAIT.runSpeed / 0.08) * DT)
      brake.push(at(speed))
    }
    return { ramp, steady, brake }
  }
  /** Fore/aft component of a joint's offset â€” the axis locomotion acts on, clear of the vertical bob. */
  const fore = (ps: Pose[], part: PartName): { min: number; max: number } => ({
    min: Math.min(...ps.map((p) => p.jointOffset[part].z)),
    max: Math.max(...ps.map((p) => p.jointOffset[part].z)),
  })

  it('drags the loose parts when the character itself accelerates', () => {
    // The bug this exists to prevent, and it shipped: the layer was fed `carry` alone â€” motion the
    // character did *not* ask for â€” so it fired on platforms and nowhere else. Your own starts, stops
    // and turns are the biggest accelerations in the game and produced nothing whatsoever.
    const { ramp, steady, brake } = locomotion()
    const parts = ['head', 'upperArmL', 'upperArmR'] as const
    const maxOf = (part: PartName): number => (part === 'head' ? DEFAULT_GAIT.headLagMax : DEFAULT_GAIT.armLagMax)
    const meanOf = (part: PartName): number => {
      const held = steady.slice(Math.round(0.5 / DT)).map((p) => p.jointOffset[part].z)
      return held.reduce((a, b) => a + b, 0) / held.length
    }
    for (const part of parts) {
      expect(fore(ramp, part).min, `${part} should be left behind by a start`).toBeLessThan(-0.015)
      // Nothing is thrown *forward* past its attachment by a stop: it falls behind and then catches up. A
      // first-order lag mathematically cannot overshoot, which is the trade this makes against the spring
      // the head used to have, and why the stop is a hard maximum rather than a damping ratio.
      const trailing = fore(brake, part)
      expect(trailing.min, `${part} should still be behind as the brake starts`).toBeLessThan(-0.005)
      expect(trailing.max, `${part} must not overshoot â€” a first-order lag cannot`).toBeLessThan(0.01)
      // A held speed keeps a *constant* trail rather than settling to nothing, and that is the effect
      // rather than a defect: a first-order lag against a target at constant velocity settles at `vÂ·Ï„`
      // behind it. Keying to acceleration instead is what made this invisible for two attempts. Bounded
      // by the stop rather than growing with speed without limit.
      expect(meanOf(part), `${part} should hold a steady trail behind its attachment`).toBeLessThan(-0.02)
      expect(meanOf(part), `${part}'s trail must stay bounded`).toBeGreaterThan(-maxOf(part) - 1e-9)
    }
  })

  it('drags them sideways through a turn taken at a constant speed', () => {
    // Constant speed, changing direction: still an acceleration, and the case a speed-keyed layer would
    // miss entirely.
    const a = createAnimator(DEFAULT_GAIT, 4)
    const speed = DEFAULT_GAIT.runSpeed
    let x = 0
    let z = 0
    for (let t = 0; t < 1.5 / DT; t++) {
      z += speed * DT
      a.step({ position: vec3(x, 0, z), yaw: 0, speed, grounded: true, rising: false }, DT)
    }
    let worst = 0
    for (let t = 0; t < 0.5 / DT; t++) {
      const yaw = (Math.PI / 2) * Math.min(1, (t * DT) / 0.25)
      x += Math.sin(yaw) * speed * DT
      z += Math.cos(yaw) * speed * DT
      const p = a.step({ position: vec3(x, 0, z), yaw, speed, grounded: true, rising: false }, DT)
      worst = Math.max(worst, Math.hypot(p.jointOffset.upperArmL.x, p.jointOffset.upperArmL.y, p.jointOffset.upperArmL.z))
    }
    // Measured 49 mm for a 90Â° turn over a quarter second.
    expect(worst, 'a corner should throw the arms wide').toBeGreaterThan(0.02)
  })

  it('responds to acceleration, not to being carried at speed', () => {
    // Standing on a train at line speed feels like standing still. A layer keyed to velocity would
    // hold a permanent lean the whole time a platform is moving.
    // Rotations only. The *translations* legitimately hold a steady trail at a steady carry â€” a joint lag is
    // first order and settles at `vÂ·Ï„` behind whatever is dragging it, exactly as it does when the character
    // runs. Measured 30 mm at a 3 m/s carry, which is the layer working, not the lean failing to settle.
    const still = carried(vec3(0, 0, 0), 6)
    const cruising = carried(vec3(0, 0, 3), 6)
    for (const part of PART_NAMES)
      for (const axis of ['x', 'y', 'z', 'w'] as const)
        expect(Math.abs(cruising.rotation[part][axis] - still.rotation[part][axis]), `${part} should settle back once the speed is steady (${axis})`).toBeLessThan(2e-3)
  })

  it('compresses under upward acceleration and never lifts the feet', () => {
    // Rising hips are unsolvable â€” standing legs are already at full extension â€” so a downward
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
    // 1/12 s is a whole number of ticks at both rates (5 and 12), so both sample the same instant.
    //
    // Read as the forearm's *rotation*, which is what this closed form governs. A tip position would also
    // carry the arms' world-space positional lag, and that one is only exact for a target at constant
    // velocity â€” against an accelerating shoulder it keeps an O(dt) error, measured 2.1 mm here. Worth
    // knowing, and a separate matter from the derivative this test is about.
    const at = (step: number): number => pushed(0, vec3(0, 0, 3), 1 / 12, 0, DEFAULT_GAIT, step).rotation.lowerArmL.x
    expect(Math.abs(at(1 / 144) - at(1 / 60))).toBeLessThan(1e-3)
  })

  it('does nothing at all when the layer is off, or when nothing is carrying the character', () => {
    // Both halves of the response to carry: `inertiaStrength` for the rotations, the two lag half-lives for
    // the translations. They are separate mechanisms now, so switching one off is not switching carry off.
    const off = { ...DEFAULT_GAIT, inertiaStrength: 0, headLagHalfLife: 0, armLagHalfLife: 0 }
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
    // And an animator never told about carry at all must be untouched by the feature existing. Same
    // elapsed time as the comparison below, or the two land at different points in the idle cycle.
    const a = createAnimator(DEFAULT_GAIT, 6)
    let plain = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    for (let t = 0; t < Math.round(0.5 / DT); t++) plain = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    expect(sample(plain)).toEqual(sample(carried(vec3(0, 0, 0), 0.5)))
  })

  it('measures the acceleration in the character frame, not the world', () => {
    // Facing east, a push toward +x is a push in the *back*, and the body has to lag forward-relative
    // to itself. Reading the world axes straight would brace sideways for it.
    const yaw = Math.PI / 2 // facing +x
    const pose = pushed(yaw, vec3(3, 0, 0), 1 / 12, 1)
    const still = pushed(yaw, vec3(0, 0, 0), 1 / 12, 1)
    // Root-space âˆ’z is behind the character, which faces +x in the world: a backward lag.
    expect(tipPosition(pose, 'lowerArmL').z).toBeLessThan(tipPosition(still, 'lowerArmL').z - 1e-3)
    // Compared against the same moment of the idle layer, which is also moving the hips sideways.
    expect(Math.abs(pose.bodyOffset.x - still.bodyOffset.x), 'nothing lateral, in its own frame').toBeLessThan(1e-4)
  })

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
    // goes exactly where the torso goes â€” which is the state this layer exists to leave behind.
    const bare = { ...DEFAULT_GAIT, headRise: 0, headFall: 0, headLand: 0, headSprint: 0, headCounterBob: 0, inertiaStrength: 0 }
    const ratio = (headStabilize: number): number => {
      const poses = walkPoses({ ...bare, headStabilize })
      const head = Math.max(...poses.map((p) => angleOf(partQuatOf(p, 'head'))))
      const body = Math.max(...poses.map((p) => angleOf(partQuatOf(p, 'body'))))
      return head / body
    }
    // Exact at both ends and linear between, because the counter-rotation is the base rotation's
    // conjugate slerped along the geodesic â€” not its three Euler terms negated, which would only
    // agree to first order. Torso tilt is 0.238 rad at top speed; the head's is (1 âˆ’ knob) of it.
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

  it('opens and closes a gap at the neck, and does not shrink the stride to do it', () => {
    // A rotation cannot express this: the neck has to translate. The gap is the visible effect â€” two boxes
    // meeting at a horizontal seam, so any offset shows.
    //
    // What this deliberately does **not** claim is that the head is much steadier than the hips. It is
    // not, any more: at the tuned half-life the head rides 119 mm of the hips' 129 mm. The spring this
    // replaced managed 43 mm, because it filtered the neck point in *root* space and so never saw the
    // character travelling at all. One first-order lag in world space cannot do both â€” attenuating a
    // 3.2 Hz bob wants Ï„ â‰« 50 ms, which at 5.5 m/s is a 275 mm trail. The trail was the ask; the vertical
    // steadiness is what it cost, and this records the number so the trade is not rediscovered by accident.
    const gap = (headLagHalfLife: number): { gap: number; head: number; hip: number } => {
      const poses = walkPoses({ ...DEFAULT_GAIT, headLagHalfLife })
      return {
        gap: Math.max(...poses.map((p) => Math.hypot(p.jointOffset.head.x, p.jointOffset.head.y, p.jointOffset.head.z))),
        head: range(poses.map((p) => jointPosition(p, 'head').y)),
        hip: range(poses.map((p) => p.bodyOffset.y)),
      }
    }
    const lagging = gap(DEFAULT_GAIT.headLagHalfLife)
    const welded = gap(0)
    expect(welded.gap, 'welded: the head sits exactly on its neck').toBe(0)
    expect(lagging.gap, 'lagging: a gap worth seeing opens at the neck').toBeGreaterThan(0.03)
    expect(lagging.hip, 'the hips must keep bobbing â€” this is a neck, not a smaller stride').toBeCloseTo(welded.hip, 6)
    expect(lagging.head).toBeLessThan(welded.head + 1e-9) // no worse than welded, but only just
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

  /** Stand for `before`, then jump and land â€” the sharpest step the joint targets ever take. */
  const landing = (gait = DEFAULT_GAIT, after = 1.2, before = 0.4): Pose[] => {
    const a = createAnimator(gait, 5)
    const stand = { position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }
    for (let t = 0; t < before / DT; t++) a.step(stand, DT)
    for (let t = 0; t < 0.4 / DT; t++) a.step({ ...stand, position: vec3(0, 3, 0), grounded: false, rising: false }, DT)
    const out: Pose[] = []
    for (let t = 0; t < after / DT; t++) out.push(snapshot(a.step(stand, DT)))
    return out
  }

  it('translates the neck and the two shoulders, and nothing else', () => {
    // Structural, not tuned. The body's travel is `bodyOffset`, which the leg IK is solved against, and
    // a leg offset would slide the foot it is standing on. The forearms are excluded for a different
    // reason: they inherit their shoulder, so the arm lags as one piece instead of coming apart at the
    // elbow â€” and a spring there would also force the shoulder's frequency, which is what kept the
    // shoulder too stiff to see.
    const sprung = new Set<PartName>(['head', 'upperArmL', 'upperArmR'])
    for (const poses of [walkPoses(), landing(), idle(DEFAULT_GAIT, 4)])
      for (const p of poses)
        for (const part of PART_NAMES) if (!sprung.has(part)) expect(magnitude(p.jointOffset[part]), `${part} must not translate`).toBe(0)
  })

  it('settles back to nothing once the character is still', () => {
    // A lag that kept a residual would leave the head permanently off its neck. Measured against a flat
    // idle: with the idle layer live the torso never actually stops moving, so a real character holds a
    // fraction of a millimetre of lag forever â€” correctly, but that is not what this asks.
    const poses = landing(FLAT_IDLE, 4)
    const last = poses[poses.length - 1]!
    for (const part of PART_NAMES) {
      const o = last.jointOffset[part]
      expect(Math.hypot(o.x, o.y, o.z), `${part} should come to rest on its joint`).toBeLessThan(1e-4)
    }
    // With idle running it stays small rather than accumulating. Bounded against the walking neck gap
    // (66 mm) rather than against its own measured value, which moves whenever anything else draws
    // from the PRNG and shifts the idle sequence: a few mm of standing lag is correct, 10% is not.
    const live = landing(DEFAULT_GAIT, 4)
    const lag = live[live.length - 1]!.jointOffset.head
    expect(Math.hypot(lag.x, lag.y, lag.z), 'idle keeps it alive, but barely').toBeLessThan(6.6e-3)
  })

  it('does not vibrate when the position arrives at the sim rate', () => {
    // The bug this exists to prevent, reported from the game: the head and arms shook while moving, worst
    // on a platform. Position comes from a 30 Hz simulation and this layer runs per rendered frame, so a
    // one-frame difference of it alternates between zero and a whole tick's travel â€” a square wave at the
    // frame rate. The velocity feed-forward that makes the trail frame-rate independent was reading that
    // difference raw.
    //
    // Modelled exactly: the position is held for two 60 fps frames at a time, and a platform's carry is
    // added on top so the per-tick step is as large as the case that showed it worst.
    const a = createAnimator(DEFAULT_GAIT, 3)
    const speed = DEFAULT_GAIT.runSpeed
    const carry = vec3(4, 0, 0) // a fast mover underfoot, on top of the running
    let held = vec3(0, 0, 0)
    let z = 0
    let x = 0
    const offsets: Vec3[] = []
    const bodyOffsets: Vec3[] = []
    for (let t = 0; t < 4 / DT; t++) {
      // The sim advances every other rendered frame; between ticks the position does not change at all.
      if (t % 2 === 0) {
        z += speed * (2 * DT)
        x += carry.x * (2 * DT)
        held = vec3(x, 0, z)
      }
      const p = a.step({ position: held, yaw: 0, speed, grounded: true, rising: false, carry }, DT)
      if (t > 1 / DT) {
        offsets.push({ ...p.jointOffset.upperArmL })
        bodyOffsets.push({ ...p.bodyOffset })
      }
    }
    // Frame-to-frame change. Vibration shows up here and nowhere else: a trail that is merely large is
    // fine, one that reverses every frame is the artefact.
    const worstJump = (vs: Vec3[]): number => {
      let worst = 0
      for (let i = 1; i < vs.length; i++) {
        const p = vs[i]!
        const q = vs[i - 1]!
        worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z))
      }
      return worst
    }
    // Compared against the *body's* own frame-to-frame movement under the same stepped input, rather than
    // against zero. A held position also freezes the stride phase, so the gait's bob steps by 25 mm a frame
    // here; the layer cannot be steadier than the body it hangs off. What it must not do is add jitter of
    // its own, and it does not: 3.9 mm against the body's 25.
    //
    // Reading the position difference raw gave 92 mm â€” a whole tick's travel, alternating in sign every
    // frame â€” and 12 mm even after averaging it over 60 ms, since the square wave's amplitude is twice its
    // mean. Driving from the known velocity removes it by construction.
    expect(worstJump(offsets), 'the offset must not jitter more than the body it hangs off').toBeLessThan(worstJump(bodyOffsets))
    expect(worstJump(offsets), 'and must stay small in absolute terms').toBeLessThan(5e-3)
  })

  it('does not vibrate on a noisy carry while the character stands still', () => {
    // The second half of the same report: still shaking slightly when carried by a platform and not moving.
    // `carry` is `(applied âˆ’ locomotion)/dt` from the controller â€” a per-tick difference of what the physics
    // solver resolved, divided by a 33 ms tick, so a few millimetres of contact hash becomes tenths of a m/s.
    // Modelled here as a carry that alternates every sim tick around its mean.
    const a = createAnimator(DEFAULT_GAIT, 3)
    const stand = { position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }
    let x = 0
    const offsets: Vec3[] = []
    for (let t = 0; t < 4 / DT; t++) {
      // 2 m/s of ride with Â±0.3 m/s of hash on it, held for a sim tick at a time.
      const tick = Math.floor(t / 2)
      const noisy = 2 + (tick % 2 === 0 ? 0.3 : -0.3)
      if (t % 2 === 0) x += noisy * (2 * DT)
      const p = a.step({ ...stand, position: vec3(x, 0, 0), carry: vec3(noisy, 0, 0) }, DT)
      if (t > 1 / DT) offsets.push({ ...p.jointOffset.upperArmL })
    }
    let worst = 0
    for (let i = 1; i < offsets.length; i++) {
      const p = offsets[i]!
      const q = offsets[i - 1]!
      worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z))
    }
    // The trail itself is ~29 mm here and must hold steady; only its frame-to-frame change is the artefact.
    expect(worst, 'a noisy carry must not shake the arm').toBeLessThan(5e-4)
  })

  it('does not shake the rotations on a noisy carry, but still answers a clean start', () => {
    // The half of the vibration report that survived fixing the translation, and the more visible half: a
    // few degrees of arm and head rotation, not a fraction of a millimetre of travel. `carry` is a per-tick
    // difference out of the physics solver, so it arrives with 30 Hz hash on it, and differentiating scales
    // that hash by `ln2/window`. Locomotion's 0.03 s window â€” needed to see a 0.1 s start at all â€” turned a
    // quiet platform ride into shake. The two inputs now get their own windows.
    const jitterOf = (steps: { speed: number; carry: Vec3 }[]): number => {
      const a = createAnimator(DEFAULT_GAIT, 3)
      const angles: number[] = []
      let x = 0
      let z = 0
      for (let t = 0; t < steps.length; t++) {
        const s = steps[t]!
        x += s.carry.x * DT
        z += s.speed * DT
        const p = a.step({ position: vec3(x, 0, z), yaw: 0, speed: s.speed, grounded: true, rising: false, carry: s.carry }, DT)
        if (t > 1 / DT) angles.push(p.rotation.upperArmL.x)
      }
      let worst = 0
      for (let i = 1; i < angles.length; i++) worst = Math.max(worst, Math.abs(angles[i]! - angles[i - 1]!))
      return worst
    }

    // Standing on a 2 m/s ride with Â±0.3 m/s of per-tick hash: the arm must be quiet.
    const noisy = Array.from({ length: Math.round(4 / DT) }, (_, t) => ({ speed: 0, carry: vec3(2 + (Math.floor(t / 2) % 2 === 0 ? 0.3 : -0.3), 0, 0) }))
    // Under 0.2Â° of change per frame, against the several degrees this used to shake by.
    expect(jitterOf(noisy), 'a noisy carry must not shake the arm').toBeLessThan(0.0017)

    // And the sharp window still earns its keep: after a second of standing, a clean 0.1 s ramp to full
    // speed must move the arm a lot more than that in a single frame.
    const warmup = Math.round(1.2 / DT)
    const start = Array.from({ length: warmup + Math.round(0.5 / DT) }, (_, t) => ({
      speed: t < warmup ? 0 : Math.min(DEFAULT_GAIT.runSpeed, (DEFAULT_GAIT.runSpeed / 0.1) * (t - warmup) * DT),
      carry: vec3(0, 0, 0),
    }))
    expect(jitterOf(start), 'a real start must still register').toBeGreaterThan(0.004)
  })

  it('trails vertically through a jump and a fall', () => {
    // Lost once already, silently: the layer used to difference the world position, which picked up every
    // vertical source for free, and replacing that with a velocity signal replaced only the horizontal
    // half. `carry.y` is a platform ride and nothing else, so without `vy` there was no vertical drive at
    // all and jumps had no trail. This is the test that says so.
    const at = (vy: number): number => {
      const a = createAnimator(DEFAULT_GAIT, 3)
      const stand = { position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }
      for (let t = 0; t < 1 / DT; t++) a.step(stand, DT)
      let y = 0
      let out = 0
      for (let t = 0; t < 0.4 / DT; t++) {
        y += vy * DT
        out = a.step({ position: vec3(0, y, 0), yaw: 0, speed: 0, vy, grounded: false, rising: vy > 0 }, DT).jointOffset.head.y
      }
      return out
    }
    // Rising, the head is left below its neck; falling, above it. Bounded by the stop either way.
    expect(at(12), 'rising: the head should hang below the neck').toBeLessThan(-0.02)
    expect(at(-12), 'falling: it should ride above it').toBeGreaterThan(0.02)
    expect(Math.abs(at(12))).toBeLessThanOrEqual(DEFAULT_GAIT.headLagMax + 1e-9)
    // And a platform's ride drives it through the same axis, from `carry.y` instead.
    const lifted = carried(vec3(0, 4, 0), 0.5)
    expect(lifted.jointOffset.head.y, 'an elevator starting up should leave the head behind').toBeLessThan(-0.01)
  })

  it('trails the same distance at 60 and 144 fps', () => {
    // A plain `smooth` toward a *moving* target is frame-rate dependent â€” it treats the target as jumping
    // at the frame boundary and settles at `vÂ·dtÂ·Î±/(1âˆ’Î±)`, which measured 42 mm at 60 fps against 62 mm at
    // 144 for the same tuning. Measuring the target's velocity and using the exact linear-ramp solution
    // removes that, and this is the test that says so: a steady run, where the trail is purely vÂ·Ï„.
    const trail = (step: number): number => {
      const a = createAnimator(FLAT_IDLE, 5)
      const speed = DEFAULT_GAIT.runSpeed
      let z = 0
      let out = 0
      for (let t = 0; t < Math.round(3 / step); t++) {
        z += speed * step
        out = a.step({ position: vec3(0, 0, z), yaw: 0, speed, grounded: true, rising: false }, step).jointOffset.upperArmL.z
      }
      return out
    }
    expect(Math.abs(trail(1 / 144) - trail(1 / 60))).toBeLessThan(1e-3)
  })

  it('lags each arm behind its shoulder, as one piece', () => {
    // Kodjo's ask, stated exactly: the point where the arm attaches to the body, interpolated instead of
    // followed. Two earlier attempts interpolated it in *root* space, where the shoulder never moves at
    // all, so they converged instantly and rendered nothing. This one is in world space.
    //
    // The elbow has no lag of its own, so whatever the shoulder is displaced by, the elbow is displaced
    // by identically â€” the arm cannot come apart. Exact, not approximate: this layer writes translations
    // only and no rotation reads them back, so turning the lag off changes positions and nothing else.
    const on = walkPoses()
    const off = walkPoses({ ...DEFAULT_GAIT, armLagHalfLife: 0 })
    let worst = 0
    let seen = 0
    for (let i = 0; i < on.length; i++) {
      const shoulder = jointPosition(on[i]!, 'upperArmL')
      const shoulderOff = jointPosition(off[i]!, 'upperArmL')
      const elbow = jointPosition(on[i]!, 'lowerArmL')
      const elbowOff = jointPosition(off[i]!, 'lowerArmL')
      const ds = Math.hypot(shoulder.x - shoulderOff.x, shoulder.y - shoulderOff.y, shoulder.z - shoulderOff.z)
      const de = Math.hypot(elbow.x - elbowOff.x, elbow.y - elbowOff.y, elbow.z - elbowOff.z)
      worst = Math.max(worst, Math.abs(ds - de))
      seen = Math.max(seen, ds)
    }
    expect(worst, 'the elbow travels exactly as far as the shoulder').toBeLessThan(1e-12)
    expect(seen, 'the arm should trail visibly at speed').toBeGreaterThan(0.04)
  })

  it('trails the arms further the longer the lag, and pins them when it is zero', () => {
    // The one knob, and the property that says it is wired to the screen. Walking at top speed, the
    // trail grows with the half-life and saturates at `armLagMax`.
    const trail = (armLagHalfLife: number): number =>
      Math.max(...walkPoses({ ...DEFAULT_GAIT, armLagHalfLife }).map((p) => Math.hypot(p.jointOffset.upperArmL.x, p.jointOffset.upperArmL.y, p.jointOffset.upperArmL.z)))
    expect(trail(0), 'zero pins the arm rigidly to the torso').toBe(0)
    expect(trail(0.005)).toBeGreaterThan(0.02)
    expect(trail(0.02)).toBeGreaterThan(trail(0.005))
    expect(trail(0.2), 'and it saturates at the stop rather than detaching').toBeLessThanOrEqual(DEFAULT_GAIT.armLagMax + 1e-9)
  })

  it('holds every joint within its stop', () => {
    // A jump moves the attachment points several metres per second, far faster than any lag is tuned for.
    // The stop is what turns that into a saturated trail rather than a limb left behind in the air.
    const max = 0.03
    // Long half-lives so the demanded trail is well past the stop, which is the case being bounded.
    for (const p of landing({ ...DEFAULT_GAIT, headLagMax: max, armLagMax: max, headLagHalfLife: 0.1, armLagHalfLife: 0.1 }))
      for (const part of PART_NAMES) {
        const o = p.jointOffset[part]
        expect(Math.hypot(o.x, o.y, o.z), `${part} within its stop`).toBeLessThanOrEqual(max + 1e-9)
      }
  })

  it('does nothing at all when both half-lives are zero', () => {
    const off = { ...DEFAULT_GAIT, headLagHalfLife: 0, armLagHalfLife: 0 }
    for (const p of landing(off)) for (const part of PART_NAMES) expect(magnitude(p.jointOffset[part])).toBe(0)
  })

  /**
   * Jump `n` times off the spot and return the pose at the top of each rise, plus one well into each
   * descent. The rise is where the lead/trail asymmetry lives; the descent is where it must be gone.
   */
  const jumps = (n: number, gait = DEFAULT_GAIT): { rise: Pose; fall: Pose }[] => {
    const a = createAnimator(gait, 9)
    const stand = { position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }
    const out: { rise: Pose; fall: Pose }[] = []
    for (let j = 0; j < n; j++) {
      for (let t = 0; t < 0.4 / DT; t++) a.step(stand, DT)
      let rise = snapshot(a.step({ ...stand, position: vec3(0, 2, 0), grounded: false, rising: true }, DT))
      for (let t = 0; t < 0.4 / DT; t++) rise = snapshot(a.step({ ...stand, position: vec3(0, 3, 0), grounded: false, rising: true }, DT))
      let fall = rise
      for (let t = 0; t < 0.4 / DT; t++) fall = snapshot(a.step({ ...stand, position: vec3(0, 2, 0), grounded: false, rising: false }, DT))
      out.push({ rise, fall })
    }
    return out
  }
  /** Knee bend in degrees, measured at the joint. 0 is a dead straight leg. */
  const kneeBend = (pose: Pose, side: 'L' | 'R'): number => {
    const hip = jointPosition(pose, `upperLeg${side}` as PartName)
    const knee = jointPosition(pose, `lowerLeg${side}` as PartName)
    const sole = solePosition(pose, side)
    const a = vec3(knee.x - hip.x, knee.y - hip.y, knee.z - hip.z)
    const b = vec3(sole.x - knee.x, sole.y - knee.y, sole.z - knee.z)
    const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z))
    return Math.acos(clampTo(dot)) * (180 / Math.PI)
  }
  const clampTo = (x: number): number => Math.max(-1, Math.min(1, x))

  /** Signed lead/trail split: which knee is tucked higher, and which arm is thrown wider. */
  const kneeSplit = (p: Pose): number => solePosition(p, 'L').y - solePosition(p, 'R').y
  const armSplit = (p: Pose): number => Math.abs(jointPosition(p, 'lowerArmL').x) - Math.abs(jointPosition(p, 'lowerArmR').x)

  it('alternates which side leads from one jump to the next', () => {
    const js = jumps(4)
    const knees = js.map((j) => kneeSplit(j.rise))
    for (const k of knees) expect(Math.abs(k), 'a jump should be visibly one-sided').toBeGreaterThan(0.05)
    for (let i = 1; i < knees.length; i++) expect(Math.sign(knees[i]!), `jump ${i} should mirror jump ${i - 1}`).toBe(-Math.sign(knees[i - 1]!))
  })

  it('folds one leg and extends the other, on every jump', () => {
    // Kodjo's ask, and the reason the tuck share is asymmetric by construction rather than a Â±fraction
    // around the tuck: half of a 0.36 m tuck is still a bent knee, not an extended leg.
    //
    // It is also why the trailing leg's share is the one quantity in the air pose that the per-jump
    // strength roll does not touch. Near full extension the knee angle is savagely nonlinear â€” 66 mm
    // of residual lift measures 46Â° of bend â€” so a roll landing under 1 does not read as "slightly
    // less straight", it reads as bent, and it did on half the jumps before this was separated out.
    for (const j of jumps(4)) {
      const bends = [kneeBend(j.rise, 'L'), kneeBend(j.rise, 'R')]
      // Measured: lead 99â€“112Â°, trail 2â€“13Â°.
      expect(Math.max(...bends), 'the leading knee folds').toBeGreaterThan(60)
      expect(Math.min(...bends), 'the trailing leg extends').toBeLessThan(20)
    }
  })

  it('pairs the raised arm with the opposite knee', () => {
    // Contralateral, as a run and a jump both are. Same-side pairing reads as a robot, and this is the
    // assertion that stops a sign slip from producing one.
    for (const j of jumps(4)) expect(Math.sign(armSplit(j.rise)), 'wide arm opposite the high knee').toBe(-Math.sign(kneeSplit(j.rise)))
  })

  it('comes back to symmetric before landing', () => {
    // Held through the descent, the split lands the character one-footed and then snaps flat.
    for (const j of jumps(3)) {
      expect(Math.abs(kneeSplit(j.fall)), 'knees together on the way down').toBeLessThan(Math.abs(kneeSplit(j.rise)) * 0.2)
      expect(Math.abs(armSplit(j.fall)), 'arms even on the way down').toBeLessThan(Math.abs(armSplit(j.rise)) * 0.2)
    }
  })

  it('varies how one-sided each jump is, not only which side', () => {
    // Strict L,R,L,R is two poses and reads as a pattern within a few jumps. Compared two apart, so
    // the side matches and only the strength differs.
    const knees = jumps(5).map((j) => Math.abs(kneeSplit(j.rise)))
    expect(Math.abs(knees[2]! - knees[0]!), 'same side, different strength').toBeGreaterThan(1e-3)
    expect(Math.abs(knees[3]! - knees[1]!)).toBeGreaterThan(1e-3)
  })

  it('is exactly symmetric with the asymmetry off', () => {
    // Also the guard on everything else in the air pose: with idle flat, nothing but these two knobs
    // may distinguish left from right while airborne.
    for (const j of jumps(3, { ...FLAT_IDLE, airAsymArm: 0, airAsymLeg: 0 }))
      for (const p of [j.rise, j.fall]) {
        expect(kneeSplit(p)).toBeCloseTo(0, 12)
        expect(armSplit(p)).toBeCloseTo(0, 12)
      }

    // With idle live it is symmetric only to a fraction of a millimetre, and that is not a leak: the
    // idle arm hang is deliberately *unmirrored* (the torso carries both arms and gravity does not),
    // and the arm springs still hold a little of it when the jump starts. Measured 0.86 mm against
    // the 50 mm the asymmetry itself is worth.
    for (const j of jumps(3, { ...DEFAULT_GAIT, airAsymArm: 0, airAsymLeg: 0 })) {
      expect(Math.abs(kneeSplit(j.rise))).toBeLessThan(1e-9)
      expect(Math.abs(armSplit(j.rise))).toBeLessThan(2e-3)
    }
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

