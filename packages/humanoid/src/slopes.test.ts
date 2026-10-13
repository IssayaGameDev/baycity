import { axisAngleToQuat, TICK_DT, TICK_RATE_HZ, vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, DEFAULT_TUNING, stepCharacter } from './groundController'

/**
 * Slopes (ADR 0127). A grounded character follows the surface it is on; speed is unchanged going up, down
 * and flat.
 *
 * The tuning is Keyboard Escape's, because that is the game whose `moveSpeed` spans a hundredfold range:
 * 2.8 m/s at Level 0 to 58.8 m/s at Level 100 (`10 + 2 x Level` studs/s, 0.28 m per stud). Past the end of
 * that curve the tick itself is the limit, not the slope — see the ADR.
 */
const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const HY = 0.5
const STILL = { moveX: 0, moveZ: 0, jump: false }
const FORWARD = { moveX: 1, moveZ: 0, jump: false }
const KB = { ...DEFAULT_TUNING, groundMaxAccel: Infinity, groundBrakeMaxAccel: 200, airMaxAccel: 100, airDrag: 0.5 }
/** The authored speed curve, end to end: Level 0, an early stage, Level 50, Level 100. */
const SPEEDS = [2.8, 15, 30, 58.8]
const ANGLES = [10, 20, 30, 40, 45]

interface Slope {
  readonly n: Vec3
  readonly top: Vec3
  readonly tan: number
}

/** A long slab tilted `deg` about Z. Positive `deg` rises with +x, so running +x is a climb. */
const makeSlope = (w: PhysicsWorld, deg: number): Slope => {
  const a = (deg * Math.PI) / 180
  w.addFixedBody({
    position: vec3(0, 0, 0),
    rotation: axisAngleToQuat(vec3(0, 0, 1), a),
    shape: { kind: 'cuboid', halfExtents: vec3(400, HY, 8) },
  })
  const n = vec3(-Math.sin(a), Math.cos(a), 0)
  return { n, top: vec3(n.x * HY, n.y * HY, 0), tan: Math.tan(a) }
}

/**
 * Distance from the capsule's lowest surface point to the slope's plane, along that plane's normal.
 *
 * **Flat ground reads -0.039, not +0.02.** A capsule held down by the controller's per-tick press settles
 * that far into whatever it stands on, slope or not, and did so long before slopes were followed. So depth
 * is judged as a difference from that baseline, which `FLAT_REST` names.
 */
const clearance = (s: Slope, c: Vec3, deg: number): number =>
  (c.x - s.top.x) * s.n.x + (c.y - s.top.y) * s.n.y - CHAR_HALF_HEIGHT * Math.cos((deg * Math.PI) / 180) - CHAR_RADIUS
const FLAT_REST = -0.039
const surfaceY = (s: Slope, x: number): number => s.top.y + (x - s.top.x) * s.tan
/**
 * Centre height of a capsule at rest on the slope directly below `x`.
 *
 * `radius / cos` and not `radius`: the bottom sphere touches the incline at a point off to the side, so
 * straight down from the centre the plane is `radius / cos` away, not `radius`. Spawning at the flat-ground
 * height instead leaves the capsule a quarter of a metre clear of a 10 degree slope, and standing still does
 * not close it — the controller's press is 0.06 m a tick and snap-to-ground does not fire for a capsule going
 * nowhere. It closes over the first five ticks of running, which read as a 0.28 m hop that was the harness's
 * and not the character's.
 */
const restY = (s: Slope, x: number, deg: number): number =>
  surfaceY(s, x) + CHAR_HALF_HEIGHT + CHAR_RADIUS / Math.cos((deg * Math.PI) / 180) + 0.02

interface Run {
  /** Fraction of ticks with no footing. Running downhill this reached 0.98 before ADR 0127. */
  readonly airFrac: number
  /** Furthest the soles got above the surface: the hop. */
  readonly maxGap: number
  /** Deepest into the surface. Compared against `FLAT_REST`, never against zero. */
  readonly minClear: number
  readonly travel: number
  readonly endSpeed: number
}

/** Settle on the slope, then hold forward for 4 s. Positive `deg` is uphill, negative downhill. */
const run = (deg: number, speed: number, ticks = 120): Run => {
  const w = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  const s = makeSlope(w, deg)
  const tuning = { ...KB, moveSpeed: speed }
  const x0 = deg < 0 ? -150 : -20
  const c = addCharacter(w, vec3(x0, restY(s, x0, deg), 0))
  for (let t = 0; t < 30; t++) {
    stepCharacter(c, STILL, TICK_DT, tuning)
    w.step(TICK_DT)
  }
  const startX = c.body.translation().x
  // Started at speed rather than accelerating into the hill: the acceleration ceilings make the run-up its
  // own long test, and what is measured here is the steady state.
  c.vx = speed
  let air = 0
  let maxGap = -Infinity
  let minClear = Infinity
  let used = 0
  for (let t = 0; t < ticks; t++) {
    stepCharacter(c, FORWARD, TICK_DT, tuning)
    w.step(TICK_DT)
    used++
    const p = c.body.translation()
    const cl = clearance(s, p, deg)
    if (!c.grounded) air++
    if (cl > maxGap) maxGap = cl
    if (cl < minClear) minClear = cl
    if (Math.abs(p.x) > 380) break
  }
  const p = c.body.translation()
  w.free()
  return { airFrac: air / used, maxGap, minClear, travel: p.x - startX, endSpeed: Math.hypot(c.vx, c.vz) }
}

describe('slopes', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('keeps its footing running downhill, at every speed the curve reaches', () => {
    const bad: string[] = []
    for (const deg of ANGLES) {
      for (const speed of [...SPEEDS, 40, 50]) {
        const r = run(-deg, speed)
        const line = `  down ${String(deg).padStart(2)} ${speed.toFixed(1).padStart(4)} m/s  air ${(r.airFrac * 100).toFixed(0).padStart(3)}%  gap ${r.maxGap.toFixed(3).padStart(7)}  clear ${r.minClear.toFixed(3).padStart(7)}`
        console.log(line)
        if (r.airFrac > 0 || r.maxGap >= 0.8) bad.push(line.trim())
      }
    }
    // Before: 41 % of ticks airborne at 5.5 m/s on 30 degrees, 90 % at 30 m/s, and gaps of 0.5 to 10 m.
    // Now footing is never lost on any of these, at any speed on the curve, and the steady state sits at
    // the 0.02 m contact offset.
    //
    // The gap allowance is 0.8 m rather than the offset because two cells still blip: 0.67 m on 10
    // degrees and 0.21 m on 20 degrees, both at 58.8 m/s, when a resolve comes up short. They are
    // recoveries, not hops — footing holds, so snap-to-ground closes them over the next tick or two
    // instead of gravity taking over. Every other cell stays inside 0.1 m.
    //
    // Collected rather than asserted per cell so a failure prints the whole table.
    expect(bad).toEqual([])
  })

  it('keeps its footing running uphill, without sinking into it', () => {
    for (const deg of ANGLES) {
      for (const speed of SPEEDS) {
        const r = run(deg, speed)
        console.log(
          `  up   ${String(deg).padStart(2)} ${speed.toFixed(1).padStart(4)} m/s  air ${(r.airFrac * 100).toFixed(0).padStart(3)}%  gap ${r.maxGap.toFixed(3).padStart(7)}  clear ${r.minClear.toFixed(3).padStart(7)}`,
        )
        expect(r.airFrac).toBeLessThan(0.05)
        // Before: 0.05 to 0.30 m inside the hill at speed, and clean through it below 17.5 degrees.
        expect(r.minClear).toBeGreaterThan(FLAT_REST - 0.2)
      }
    }
  })

  it('neither gains speed downhill nor loses it uphill (ADR 0127)', () => {
    for (const deg of ANGLES) {
      for (const speed of SPEEDS) {
        // Held forward throughout, so air drag never gets an airborne tick to bite on.
        expect(run(-deg, speed).endSpeed).toBeCloseTo(speed, 1)
        expect(run(deg, speed).endSpeed).toBeCloseTo(speed, 1)
      }
    }
  })

  it('keeps the climb when the contact-nudge retry fires (shallow slopes)', () => {
    // The retry only fires below about 17.5 degrees: a steeper normal leans far enough against the direction
    // of travel to trip `blockedAlong` and skip it. `Math.min(retry.y, 0)` used to clamp the climb away along
    // with the nudge, driving the capsule into the hill -- measured 150 m through a 17 degree slope at
    // walking pace.
    for (const deg of [5, 10, 15, 17]) {
      for (const speed of [2.8, 5.5, 15, 30]) {
        const r = run(deg, speed)
        console.log(`  nudge ${String(deg).padStart(2)} ${speed.toFixed(1).padStart(4)} m/s  clear ${r.minClear.toFixed(3).padStart(7)}  travel ${r.travel.toFixed(1)}`)
        expect(r.minClear).toBeGreaterThan(FLAT_REST - 0.2)
      }
    }
  })

  it('does not launch off a crest: over a ridge it takes the far side', () => {
    // Two slabs meeting in a ridge at x = 0, up one side and down the other, which is running off the top of
    // a hill. Glue, not a ski jump (ADR 0127).
    const a = (20 * Math.PI) / 180
    for (const speed of [2.8, 15, 30]) {
      const w = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
      const up = makeSlope(w, 20)
      makeSlope(w, -20)
      const tuning = { ...KB, moveSpeed: speed }
      const c = addCharacter(w, vec3(-20, restY(up, -20, 20), 0))
      for (let t = 0; t < 30; t++) {
        stepCharacter(c, STILL, TICK_DT, tuning)
        w.step(TICK_DT)
      }
      c.vx = speed
      let worst = 0
      for (let t = 0; t < 200; t++) {
        stepCharacter(c, FORWARD, TICK_DT, tuning)
        w.step(TICK_DT)
        const p = c.body.translation()
        // Past the ridge the far face is the descent, and the soles belong on it.
        if (p.x > 1) {
          const face = HY * Math.cos(a) - p.x * Math.tan(a)
          const above = p.y - STAND - face
          if (above > worst) worst = above
        }
        if (p.x > 60) break
      }
      console.log(`  crest ${speed.toFixed(1).padStart(4)} m/s  worst height above the far face ${worst.toFixed(3)} m`)
      w.free()
      expect(worst).toBeLessThan(1.5)
    }
  })

  it('leaves flat ground exactly where it was', () => {
    const w = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    w.addFixedBody({ position: vec3(0, 0, 0), shape: { kind: 'cuboid', halfExtents: vec3(400, HY, 8) } })
    const tuning = { ...KB, moveSpeed: 15 }
    const c = addCharacter(w, vec3(-20, HY + STAND + 0.05, 0))
    for (let t = 0; t < 30; t++) {
      stepCharacter(c, STILL, TICK_DT, tuning)
      w.step(TICK_DT)
    }
    const rest = c.body.translation().y
    c.vx = 15
    let air = 0
    for (let t = 0; t < 2 * TICK_RATE_HZ; t++) {
      stepCharacter(c, FORWARD, TICK_DT, tuning)
      w.step(TICK_DT)
      if (!c.grounded) air++
    }
    const p = c.body.translation()
    console.log(`  flat  rest y ${rest.toFixed(4)}  travel ${(p.x + 20).toFixed(3)} m in 2 s at 15 m/s  air ${air}`)
    w.free()
    // A flat normal makes `slopeDy` identically zero, so nothing here can have moved. The height is
    // held to 0.05 rather than pinned: a capsule creeps from the 0.02 contact offset down to about
    // -0.04 over a few seconds under the per-tick press, on flat ground, and always has.
    expect(air).toBe(0)
    expect(Math.abs(p.y - rest)).toBeLessThan(0.05)
    expect(p.x + 20).toBeCloseTo(30, 1)
  })
})
