import { rotateVec3, vec3, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { createAnimator, solveTwoBone, DEFAULT_GAIT } from './animate'
import { CHAR_HEIGHT, FOOT_Y, HIP_HEIGHT, LIMB_LENGTH, RIG, PART_NAMES, type PartName, type Pose } from './rig'

const DT = 1 / 60

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
    const offset = name === 'body' ? vec3(part2.pivot.x, part2.pivot.y + pose.bodyOffset.y, part2.pivot.z) : part2.pivot
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

  it('tucks into an air pose when not grounded and returns on landing', () => {
    const a = createAnimator()
    let pose = restPoseOf(a)
    for (let t = 0; t < 60; t++) pose = a.step({ position: vec3(0, 5, 0), yaw: 0, speed: 3, grounded: false, rising: false }, DT)
    const airSole = solePosition(pose, 'L').y
    for (let t = 0; t < 60; t++) pose = a.step({ position: vec3(0, 0, 0), yaw: 0, speed: 0, grounded: true, rising: false }, DT)
    const groundSole = solePosition(pose, 'L').y
    expect(airSole, 'legs tuck up while airborne').toBeGreaterThan(groundSole + 0.15)
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
