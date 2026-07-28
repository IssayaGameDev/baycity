import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, stepCharacter, TICK_DT } from '@mp/character'
import { instantiateLevel, validateLevel } from '@mp/content'
import { createSimClock, vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { showcase } from './showcase'

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
