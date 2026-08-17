import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, stepCharacter, TICK_DT } from '@mp/character'
import { curvedBeam, instantiateLevel, validateLevel, type PrefabInstance } from '@mp/content'
import { createSimClock, eulerToQuat, mulQuat, rotateVec3, vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { courses, showcase } from './showcase'

/**
 * End-to-end on the real level, through the real loader, stepped exactly as `main.ts` steps it:
 * sim clock → `update` → world.step → `stepCharacter` → world.step. The unit suites test the
 * mechanism in isolation; this tests the thing the game actually runs, on the platforms in the
 * gym, so a regression in either half (the loader's frozen posing, or the character's ride) fails
 * here even if both halves still look right on their own.
 */
const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const STILL = { moveX: 0, moveZ: 0, jump: false }

/** The gym's movers, by the authored home position in showcase.ts. */
const MOVERS = [
  { name: 'row A +X mover (8 m / 6 s)', home: vec3(-13, 0.75, -20), top: 0.75 + 0.2 },
  { name: 'row A +Z mover (6 m / 5 s)', home: vec3(4, 0.75, -20), top: 0.75 + 0.2 },
  { name: 'row B fast +X mover (12 m / 4 s)', home: vec3(-10, 0.75, -28), top: 0.75 + 0.2 },
] as const

const near = (a: Vec3, b: Vec3, tol: number): boolean => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < tol

/**
 * Measured maximum edge-to-edge gap as a function of the rise between take-off and landing
 * (packages/character envelope runs, tuning 5.5 m/s / 3 m apex). Linear between samples; the trade
 * is ≈0.35 m of reach per metre climbed, and the same bought back by dropping.
 */
const MAX_GAP: ReadonlyArray<readonly [rise: number, gap: number]> = [
  [-2, 4.1],
  [-1, 3.9],
  [0, 3.5],
  [0.5, 3.4],
  [1, 3.2],
  [1.5, 3.0],
  [2, 2.8],
  [2.5, 2.5],
]

const maxGapForRise = (rise: number): number => {
  if (rise <= MAX_GAP[0]![0]) return MAX_GAP[0]![1]
  const last = MAX_GAP[MAX_GAP.length - 1]!
  if (rise >= last[0]) return last[1]
  for (let i = 1; i < MAX_GAP.length; i++) {
    const [r1, g1] = MAX_GAP[i]!
    const [r0, g0] = MAX_GAP[i - 1]!
    if (rise <= r1) return g0 + ((g1 - g0) * (rise - r0)) / (r1 - r0)
  }
  return last[1]
}

/** World-space AABB of every piece of an instance, with the instance transform applied. */
const pieceBoxes = (inst: PrefabInstance): { min: Vec3; max: Vec3 }[] => {
  const prefab = inst.prefab
  if (typeof prefab === 'string') return []
  const q = eulerToQuat(inst.transform.rotation ?? vec3(0, 0, 0))
  const origin = inst.transform.position
  return prefab.pieces.map((p) => {
    const col = p.collider
    const pq = mulQuat(q, eulerToQuat(p.transform.rotation ?? vec3(0, 0, 0)))
    const centre = rotateVec3(q, p.transform.position)
    // Local corner set: a box's eight corners, or a convex hull's own points.
    const corners: Vec3[] =
      col.kind === 'convex'
        ? [...col.points]
        : col.kind === 'box'
          ? [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => vec3(col.halfExtents.x * sx, col.halfExtents.y * sy, col.halfExtents.z * sz))))
          : [vec3(0, 0, 0)]
    let min = vec3(Infinity, Infinity, Infinity)
    let max = vec3(-Infinity, -Infinity, -Infinity)
    for (const local of corners) {
      const c = rotateVec3(pq, local)
      const w = vec3(origin.x + centre.x + c.x, origin.y + centre.y + c.y, origin.z + centre.z + c.z)
      min = vec3(Math.min(min.x, w.x), Math.min(min.y, w.y), Math.min(min.z, w.z))
      max = vec3(Math.max(max.x, w.x), Math.max(max.y, w.y), Math.max(max.z, w.z))
    }
    return { min, max }
  })
}

/** Horizontal gap between two AABBs — 0 when they overlap or touch. */
const boxGap = (a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): number => {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x)
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z)
  return Math.hypot(dx, dz)
}

/**
 * Every jump the level asks for must be inside the measured envelope. This exists because it is
 * easy to author an obstacle that simply cannot be cleared — the carry bench originally had a pad
 * placed on a reach number that was wrong by 2 m — and playing the whole course by hand to find
 * out is slow.
 */
describe('parkour gym: authored jumps are clearable', () => {
  // The seam between one course piece and the next is exactly where the first version of this file
  // was blind: it checked jumps *within* each pad chain and never the transitions between
  // instances, which is how a 5.4 m step to the final pad shipped.
  it('every seam between consecutive course pieces is crossable', () => {
    for (const [name, course] of Object.entries(courses)) {
      for (let i = 1; i < course.length; i++) {
        const from = pieceBoxes(course[i - 1]!)
        const to = pieceBoxes(course[i]!)
        expect(from.length && to.length, `${name}[${i}]: no boxes`).toBeTruthy()

        // Nearest pair of pieces across the seam, and the height it lands at.
        let best = Infinity
        let rise = 0
        for (const a of from)
          for (const b of to) {
            const g = boxGap(a, b)
            if (g < best) {
              best = g
              rise = b.max.y - a.max.y // top surface to top surface
            }
          }
        expect(best, `${name} seam ${i - 1}→${i}: ${best.toFixed(2)} m at rise ${rise.toFixed(1)} m`).toBeLessThan(
          maxGapForRise(rise),
        )
      }
    }
  })

  it('every pad-to-pad jump in the level is inside the measured envelope', () => {
    // Pads belonging to one chain: same z-line group, ordered along x. Read straight off the level
    // data so the check follows whatever showcase.ts says.
    const chains = showcase.instances.filter((i) => typeof i.prefab !== 'string' && i.prefab.id === 'pad-chain')
    expect(chains.length).toBeGreaterThan(0)

    for (const inst of chains) {
      const prefab = inst.prefab as { id: string; pieces: { collider: { kind: string; halfExtents?: { x: number; y: number; z: number } }; transform: { position: { x: number; y: number; z: number } } }[] }
      const pads = prefab.pieces.map((p) => ({ pos: p.transform.position, half: p.collider.halfExtents! }))
      for (let i = 1; i < pads.length; i++) {
        const a = pads[i - 1]!
        const b = pads[i]!
        // Edge-to-edge along the direction of travel, plus the lateral offset: the real jump.
        const alongX = b.pos.x - a.pos.x - a.half.x - b.half.x
        const lateral = Math.abs(b.pos.z - a.pos.z)
        const jump = Math.hypot(Math.max(alongX, 0), lateral)
        const rise = b.pos.y - a.pos.y
        const limit = maxGapForRise(rise)
        expect(jump, `${prefab.id} pad ${i - 1}→${i}: ${jump.toFixed(2)} m at rise ${rise.toFixed(1)} m (limit ${limit.toFixed(2)} m)`).toBeLessThan(limit)
      }
    }
  })

  it('the carry bench momentum gap needs the platform, and is reachable with it', () => {
    // Mover: 4 m pad, home x = -10, travels 12 m → far edge at x = -10 + 12 + 2 = 4.
    const moverFarEdge = 4
    const catchPad = showcase.instances.find(
      (i) => Math.abs(i.transform.position.z - -28) < 0.01 && i.transform.position.x > 5,
    )
    expect(catchPad).toBeDefined()
    const nearEdge = catchPad!.transform.position.x - 2.5 // 5 m pad
    const gap = nearEdge - moverFarEdge
    expect(gap).toBeGreaterThan(maxGapForRise(0)) // a plain jump must NOT cover it
    expect(gap).toBeLessThan(6) // riding at ≈9.4 m/s for 0.66 s does
  })
})

describe('parkour gym: curved beams are walkable', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  // Steers along the arc's tangent each tick, which is what a player does with the mouse. Passing
  // means the swept prisms really are continuous underfoot — a notch at any join would drop the
  // character, and a box chain of the same subdivision has notches at every one.
  for (const [label, radius, sweepDeg, width] of [
    ['gentle', 12, 90, 1.2],
    ['tight', 6, 120, 0.8],
    ['hairpin', 4, 180, 0.8],
  ] as const) {
    it(`walks a ${label} arc (r=${radius} m, ${sweepDeg}°, ${width} m wide) end to end`, () => {
      const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
      const thickness = 0.5
      const prefab = curvedBeam({ radius, sweepDeg, width, thickness })
      instantiateLevel(world, {
        id: 'arc',
        config: { fallBehavior: 'physical-fall', fallY: -20 },
        instances: [{ prefab, transform: { position: vec3(0, 0, 0) } }],
      })
      const c = addCharacter(world, vec3(0, thickness / 2 + STAND + 0.02, 0))

      const total = (sweepDeg * Math.PI) / 180
      let reached = 0
      let lowest = Infinity
      for (let t = 0; t < 900; t++) {
        const p = c.body.translation()
        // Angular position around the arc centre (0, 0, radius), and the tangent there.
        const u = Math.atan2(p.x, radius - p.z)
        const tangent = { x: Math.cos(u), z: Math.sin(u) }
        stepCharacter(c, { moveX: tangent.x, moveZ: tangent.z, jump: false }, TICK_DT)
        world.step(TICK_DT)
        const now = c.body.translation()
        lowest = Math.min(lowest, now.y)
        reached = Math.max(reached, Math.atan2(now.x, radius - now.z))
        if (reached >= total - 0.05) break
      }
      expect(reached, `only got ${((reached / total) * 100).toFixed(0)}% round the arc`).toBeGreaterThan(total - 0.05)
      expect(lowest, 'fell through a join between segments').toBeGreaterThan(-1)
      world.free()
    })
  }
})

describe('parkour gym: the beam course is continuous', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  // Walking a straight line is enough to cross every beam (measured: all widths down to 0.2 m are
  // traversable dead centre), so this passes only if the pieces really do abut — no hole to drop
  // through, no misplaced rotation leaving a beam running the wrong way.
  it('can be walked from the slab edge to the far end without falling', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, validateLevel(showcase))
    const c = addCharacter(world, vec3(0, STAND + 0.02, 31)) // on the entry pad, tops flush at y = 0

    let lowest = Infinity
    for (let t = 0; t < 600; t++) {
      loaded.update(t * TICK_DT * 1000, c.base?.colliderHandle)
      world.step(TICK_DT)
      stepCharacter(c, { moveX: 0, moveZ: 1, jump: false }, TICK_DT, undefined, loaded.basePose)
      world.step(TICK_DT)
      const p = c.body.translation()
      lowest = Math.min(lowest, p.y)
      if (p.z > 88) break
    }
    const p = c.body.translation()
    expect(p.z, 'did not reach the far end of the beam course').toBeGreaterThan(88)
    expect(lowest, 'fell through a hole between pieces').toBeGreaterThan(-1)
    world.free()
  })
})

describe('parkour gym: riding the authored platforms', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  for (const mover of MOVERS) {
    it(`rides the ${mover.name} without slipping`, () => {
      const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
      const loaded = instantiateLevel(world, validateLevel(showcase))
      // Sim clock exactly as the mode builds it; a fixed reference keeps the run deterministic.
      let now = 0
      const clock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => now })

      // Settle the level at t=0 so the piece is at its authored home, then stand on it.
      loaded.update(clock.tick())
      world.step(TICK_DT)
      const visual = loaded.visuals.find((v) => near(v.position, mover.home, 0.01))
      expect(visual, `no piece found at ${JSON.stringify(mover.home)} — showcase.ts changed?`).toBeDefined()

      const c = addCharacter(world, vec3(mover.home.x, mover.top + STAND + 0.02, mover.home.z))

      let worstSlip = 0
      let offset: Vec3 | null = null
      let worstOffsetDrift = 0
      for (let t = 0; t < 240; t++) {
        const prevChar = c.body.translation()
        const prevPlat = { ...visual!.position }
        now += TICK_DT * 1000
        loaded.update(clock.tick(), c.base?.colliderHandle)
        world.step(TICK_DT) // (A) platforms move
        stepCharacter(c, STILL, TICK_DT, undefined, loaded.basePose)
        world.step(TICK_DT) // (B) character resolves
        if (t < 20) continue // settle onto the surface

        const nowChar = c.body.translation()
        const nowPlat = visual!.position
        const slip = Math.hypot(
          nowChar.x - prevChar.x - (nowPlat.x - prevPlat.x),
          nowChar.z - prevChar.z - (nowPlat.z - prevPlat.z),
        )
        worstSlip = Math.max(worstSlip, slip)

        // Cumulative: where we stand on the platform must not creep over 8 s.
        const rel = vec3(nowChar.x - nowPlat.x, nowChar.y - nowPlat.y, nowChar.z - nowPlat.z)
        if (offset === null) offset = rel
        else worstOffsetDrift = Math.max(worstOffsetDrift, Math.hypot(rel.x - offset.x, rel.z - offset.z))
      }

      expect(worstSlip).toBeLessThan(0.005) // worst single tick, 5 mm
      expect(worstOffsetDrift).toBeLessThan(0.05) // no creep across the platform over 8 s
      expect(c.grounded).toBe(true) // still aboard at the end
      world.free()
    })
  }

  it('rides the row A turntable off-centre, orbiting rather than being spun out from under', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, validateLevel(showcase))
    let now = 0
    const clock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => now })
    loaded.update(clock.tick())
    world.step(TICK_DT)

    // The turntable: 8x8 disc at (14, 0.75, -20), one turn per 8 s.
    const pivot = vec3(14, 0.75, -20)
    const radius = 2.5
    const c = addCharacter(world, vec3(pivot.x + radius, 0.75 + 0.2 + STAND + 0.02, pivot.z))

    let worstRadius = 0
    let swept = 0
    let prevAngle = 0
    for (let t = 0; t < 240; t++) {
      now += TICK_DT * 1000
      loaded.update(clock.tick(), c.base?.colliderHandle)
      world.step(TICK_DT)
      stepCharacter(c, STILL, TICK_DT, undefined, loaded.basePose)
      world.step(TICK_DT)
      const p = c.body.translation()
      const angle = Math.atan2(p.z - pivot.z, p.x - pivot.x)
      if (t < 20) {
        prevAngle = angle
        continue
      }
      worstRadius = Math.max(worstRadius, Math.abs(Math.hypot(p.x - pivot.x, p.z - pivot.z) - radius))
      let d = angle - prevAngle
      if (d > Math.PI) d -= 2 * Math.PI
      if (d < -Math.PI) d += 2 * Math.PI
      swept += d
      prevAngle = angle
    }

    expect(worstRadius).toBeLessThan(0.1) // held its distance from the axis
    // 220 ticks of an 8 s turn ≈ 0.92 rad. Being spun out from under would leave this near zero.
    expect(Math.abs(swept)).toBeGreaterThan(0.5)
    expect(c.grounded).toBe(true)
    world.free()
  })

  // Regression: a moving piece must still *push* a character it sweeps into. That push is Rapier
  // acting on the piece's kinematic velocity, so posing every piece without velocity (which riding
  // needs) silently removed it — the spinning bar passed straight through the player. Only the
  // ridden piece is posed frozen; everything else keeps its velocity and keeps pushing.
  it('is shoved sideways by the spinning bar while standing beside it', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, validateLevel(showcase))
    let now = 0
    const clock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => now })

    // The sampler's rotatingBar: 6 m long, spins about +y once per 3 s, centred (20, 2, 0) over a
    // platform at (20, 0.75, 0). Stand on that platform, off-centre, in the bar's path.
    const start = vec3(21.5, 0.75 + 0.2 + STAND + 0.02, 0)
    loaded.update(clock.tick())
    world.step(TICK_DT)
    const c = addCharacter(world, start)

    let maxPush = 0
    for (let t = 0; t < 120; t++) {
      now += TICK_DT * 1000
      loaded.update(clock.tick(), c.base?.colliderHandle)
      world.step(TICK_DT)
      stepCharacter(c, STILL, TICK_DT, undefined, loaded.basePose)
      world.step(TICK_DT)
      const p = c.body.translation()
      maxPush = Math.max(maxPush, Math.hypot(p.x - start.x, p.z - start.z))
    }
    // Standing perfectly still, the only thing that can move us is the bar sweeping through.
    expect(maxPush).toBeGreaterThan(0.3)
    world.free()
  })

  it('rides the kit sampler elevator up and down, keeping its feet on it', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, validateLevel(showcase))
    let now = 0
    const clock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => now })
    loaded.update(clock.tick())
    world.step(TICK_DT)

    // The vertical `movingPlatform` in the sampler row: home (13, 2.5, 0), 1.5 m over 4 s.
    const home = vec3(13, 2.5, 0)
    const visual = loaded.visuals.find((v) => near(v.position, home, 0.01))
    expect(visual, 'no elevator at (13, 2.5, 0) — showcase.ts changed?').toBeDefined()
    const c = addCharacter(world, vec3(home.x, home.y + 0.2 + STAND + 0.02, home.z))

    let worstGap = -Infinity
    let bestGap = Infinity
    for (let t = 0; t < 240; t++) {
      now += TICK_DT * 1000
      loaded.update(clock.tick(), c.base?.colliderHandle)
      world.step(TICK_DT)
      stepCharacter(c, STILL, TICK_DT, undefined, loaded.basePose)
      world.step(TICK_DT)
      if (t < 20) continue
      // Feet vs the slab's top surface (thickness 0.4 → half 0.2).
      const gap = c.body.translation().y - STAND - (visual!.position.y + 0.2)
      worstGap = Math.max(worstGap, gap)
      bestGap = Math.min(bestGap, gap)
    }
    expect(bestGap).toBeGreaterThan(-0.15) // not sinking through it
    expect(worstGap).toBeLessThan(0.15) // not being left behind by it
    world.free()
  })
})
