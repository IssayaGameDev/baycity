import { axisAngleToQuat, vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, stepCharacter, TICK_DT } from './character'

/**
 * TEMPORARY. Measures the two things obstacle parameters need and arithmetic cannot give:
 *   A  max gap as a function of the rise/drop between take-off and landing
 *   B  how far off-centre a beam of a given width can be stood on
 *   C  whether a slope below the slide threshold actually sheds a standing character
 *   D  whether curved tops (dome, horizontal log) are standable, and over what band
 * Delete once the numbers are recorded.
 */
const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const T = 0.2 // slab half-thickness
const STILL = { moveX: 0, moveZ: 0, jump: false }

const world0 = (): PhysicsWorld => createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
const slab = (w: PhysicsWorld, c: Vec3, hx: number, hz: number, hy = T): void => {
  w.addFixedBody({ position: c, shape: { kind: 'cuboid', halfExtents: vec3(hx, hy, hz) } })
}

// ---- A: gap vs rise -------------------------------------------------------------------------
const attemptGap = (gap: number, rise: number): boolean => {
  const w = world0()
  slab(w, vec3(0, 0, 0), 6, 4) // take-off, far edge x=6, top y=T
  const landX = 6 + gap + 6
  slab(w, vec3(landX, rise, 0), 6, 4) // landing, near edge x=6+gap, top y=rise+T
  const c = addCharacter(w, vec3(0, T + STAND + 0.02, 0))

  let jumped = false
  let ok = false
  for (let t = 0; t < 240; t++) {
    const p = c.body.translation()
    const want = !jumped && c.grounded && p.x > 6 - 0.45
    if (want) jumped = true
    // Held while rising, not tapped: `jumpCutScale` is live in DEFAULT_TUNING, so a one-tick press is a
    // deliberate short hop and would measure the *minimum* jump. The envelope is the maximum.
    stepCharacter(c, { moveX: 1, moveZ: 0, jump: want || c.vy > 0 }, TICK_DT)
    w.step(TICK_DT)
    const n = c.body.translation()
    if (jumped && c.grounded && n.x > 6 + gap + 0.3 && Math.abs(n.y - (rise + T + STAND)) < 0.3) {
      ok = true
      break
    }
    if (n.y < rise - 6) break // fell past the landing
  }
  w.free()
  return ok
}

// ---- B: off-centre margin on a flat beam ----------------------------------------------------
/** Stand still at `offset` from the centre line of a beam `width` wide; does it hold? */
const standsOffCentre = (width: number, offset: number): boolean => {
  const w = world0()
  slab(w, vec3(0, 0, 0), width / 2, 8)
  const c = addCharacter(w, vec3(offset, T + STAND + 0.02, 0))
  for (let t = 0; t < 90; t++) {
    stepCharacter(c, STILL, TICK_DT)
    w.step(TICK_DT)
    if (c.body.translation().y < -3) break
  }
  const p = c.body.translation()
  w.free()
  return p.y > T + STAND - 0.3
}

/** Walk the length of a beam `width` wide, dead centre. */
const traverses = (width: number): boolean => {
  const w = world0()
  slab(w, vec3(0, 0, 0), width / 2, 8)
  const c = addCharacter(w, vec3(0, T + STAND + 0.02, -6))
  for (let t = 0; t < 120; t++) {
    stepCharacter(c, { moveX: 0, moveZ: 1, jump: false }, TICK_DT)
    w.step(TICK_DT)
    const p = c.body.translation()
    if (p.y < -3) break
    if (p.z > 5.5) break
  }
  const p = c.body.translation()
  w.free()
  return p.z > 5 && p.y > T + STAND - 0.3
}

// ---- C: does a sub-threshold slope shed a standing character? -------------------------------
const slopeDrift = (deg: number): number => {
  const w = world0()
  const a = (deg * Math.PI) / 180
  const hy = 0.5
  const q = axisAngleToQuat(vec3(0, 0, 1), a)
  w.addFixedBody({ position: vec3(0, 0, 0), rotation: q, shape: { kind: 'cuboid', halfExtents: vec3(12, hy, 6) } })
  // Top-face centre, then out along the face normal by the stand height.
  const n = vec3(-Math.sin(a), Math.cos(a), 0)
  const top = vec3(n.x * hy, n.y * hy, 0)
  const d = STAND + 0.03
  const c = addCharacter(w, vec3(top.x + n.x * d, top.y + n.y * d, 0))
  const start = c.body.translation()
  for (let t = 0; t < 120; t++) {
    stepCharacter(c, STILL, TICK_DT)
    w.step(TICK_DT)
    if (c.body.translation().y < -8) break
  }
  const p = c.body.translation()
  w.free()
  return Math.hypot(p.x - start.x, p.z - start.z) // horizontal drift over 4 s, standing still
}

// ---- D: curved tops -------------------------------------------------------------------------
/** Stand on a sphere (dome) or a Z-axis capsule (log) at `phi` degrees from the crown. */
const standsOnCurve = (kind: 'dome' | 'log', radius: number, phiDeg: number): boolean => {
  const w = world0()
  const phi = (phiDeg * Math.PI) / 180
  if (kind === 'dome') w.addFixedBody({ position: vec3(0, 0, 0), shape: { kind: 'ball', radius } })
  else
    w.addFixedBody({
      position: vec3(0, 0, 0),
      rotation: axisAngleToQuat(vec3(1, 0, 0), Math.PI / 2), // stand the capsule's axis along Z
      shape: { kind: 'capsule', halfHeight: 6, radius },
    })
  // Capsule's lower sphere centre rests at radius + CHAR_RADIUS from the curve's centre.
  const r = radius + CHAR_RADIUS
  const c = addCharacter(w, vec3(Math.sin(phi) * r, Math.cos(phi) * r + CHAR_HALF_HEIGHT + 0.02, 0))
  const start = c.body.translation()
  for (let t = 0; t < 120; t++) {
    stepCharacter(c, STILL, TICK_DT)
    w.step(TICK_DT)
    if (c.body.translation().y < -6) break
  }
  const p = c.body.translation()
  w.free()
  // Held on: still up near the crown height, and did not slide far.
  return p.y > 0 && Math.hypot(p.x - start.x, p.z - start.z) < 0.6
}

const maxPassing = (vals: number[], test: (v: number) => boolean): number => {
  let best = Number.NaN
  for (const v of vals) if (test(v)) best = v
  return best
}

describe('obstacle parameter envelope', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('measures gap-vs-rise, beam margin, slope drift and curved tops', () => {
    const gaps = Array.from({ length: 46 }, (_, i) => 0.5 + i * 0.1)

    /* eslint-disable no-console */
    console.log('\nA  MAX GAP vs RISE (landing higher/lower than take-off)')
    for (const rise of [-2, -1, 0, 0.5, 1, 1.5, 2, 2.5]) {
      const g = maxPassing(gaps, (v) => attemptGap(Math.round(v * 10) / 10, rise))
      console.log(`   rise ${String(rise).padStart(4)} m → max gap ${Number.isNaN(g) ? 'none' : g.toFixed(1) + ' m'}`)
    }

    console.log('\nB  BEAM: off-centre margin, and centred traversal')
    for (const width of [0.2, 0.4, 0.6, 0.8, 1.2, 2]) {
      const offs = Array.from({ length: 21 }, (_, i) => i * 0.05)
      const m = maxPassing(offs, (o) => standsOffCentre(width, o))
      console.log(`   width ${width.toFixed(1)} m → margin ±${Number.isNaN(m) ? 'none' : m.toFixed(2) + ' m'}   traverse ${traverses(width) ? 'yes' : 'NO'}`)
    }

    console.log('\nC  SLOPE: horizontal drift while standing still for 4 s')
    for (const deg of [0, 20, 30, 40, 44, 48, 55, 70]) console.log(`   ${String(deg).padStart(2)}° → drift ${slopeDrift(deg).toFixed(2)} m`)

    console.log('\nD  CURVED TOPS: standable band from the crown')
    for (const kind of ['dome', 'log'] as const)
      for (const radius of [1, 2, 4]) {
        const band = maxPassing([0, 10, 20, 30, 40, 45, 50, 60], (p) => standsOnCurve(kind, radius, p))
        console.log(`   ${kind} r=${radius} m → holds to ${Number.isNaN(band) ? 'not even the crown' : band + '° from crown'}`)
      }
    /* eslint-enable no-console */
    expect(true).toBe(true)
  })
})
