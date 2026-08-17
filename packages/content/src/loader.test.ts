import { eulerToQuat, vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLevel } from './loader'
import type { Level } from './types'

const fixture: Level = {
  id: 'fx',
  config: { fallBehavior: 'respawn-checkpoint', fallY: -3 },
  instances: [
    {
      prefab: { id: 'ground', pieces: [{ collider: { kind: 'box', halfExtents: vec3(10, 0.1, 10) }, transform: { position: vec3(0, 0, 0) } }] },
      transform: { position: vec3(0, 0, 0) },
    },
    {
      prefab: {
        id: 'lift',
        pieces: [{ collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) }, transform: { position: vec3(0, 0, 0) }, visual: { kind: 'primitive', style: 'moving' } }],
      },
      transform: { position: vec3(0, 2, 0) },
      behavior: { kind: 'move', axis: vec3(0, 1, 0), distance: 1.5, periodMs: 4000 },
    },
  ],
  markers: [
    { kind: 'spawn', transform: { position: vec3(0, 2, 0) } },
    { kind: 'checkpoint', transform: { position: vec3(3, 0.5, 0) }, radius: 1.5 },
  ],
}

describe('instantiateLevel', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('builds colliders + markers and moves clock-driven pieces', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, fixture)

    expect(loaded.visuals).toHaveLength(2)
    expect(loaded.markers.filter((m) => m.kind === 'spawn')).toHaveLength(1)
    expect(loaded.markers.filter((m) => m.kind === 'checkpoint')).toHaveLength(1)

    const lift = loaded.visuals.find((v) => v.style === 'moving')!
    expect(lift).toBeDefined()
    loaded.update(0)
    const y0 = lift.position.y // home (at rest)
    loaded.update(1000) // quarter period → half of the travel
    expect(Math.abs(lift.position.y - y0)).toBeGreaterThan(0.5)

    world.free()
  })

  it('bakes transform scale into collider dims and scaled offsets', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const level: Level = {
      id: 'scaled',
      config: { fallBehavior: 'physical-fall', fallY: -10 },
      instances: [
        {
          prefab: {
            id: 'p',
            pieces: [{ collider: { kind: 'box', halfExtents: vec3(1, 1, 1) }, transform: { position: vec3(1, 0, 0) } }],
          },
          transform: { position: vec3(0, 0, 0), scale: vec3(2, 3, 4) },
        },
      ],
    }
    const loaded = instantiateLevel(world, level)
    const v = loaded.visuals[0]!
    expect(v.collider).toEqual({ kind: 'box', halfExtents: vec3(2, 3, 4) }) // dims × scale
    expect(v.position).toEqual(vec3(2, 0, 0)) // local offset (1,0,0) × instance scale x=2
    world.free()
  })

  it('applies per-piece behavior (one piece moves while its sibling stays put)', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const level: Level = {
      id: 'perpiece',
      config: { fallBehavior: 'physical-fall', fallY: -10 },
      instances: [
        {
          prefab: {
            id: 'mixed',
            pieces: [
              { collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) }, transform: { position: vec3(0, 0, 0) }, behavior: { kind: 'move', axis: vec3(0, 1, 0), distance: 2, periodMs: 4000 } },
              { collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) }, transform: { position: vec3(3, 0, 0) } },
            ],
          },
          transform: { position: vec3(0, 0, 0) },
        },
      ],
    }
    const loaded = instantiateLevel(world, level)
    const mover = loaded.visuals[0]!
    const stat = loaded.visuals[1]!
    loaded.update(0)
    const m0 = mover.position.y
    const s0 = stat.position.y
    loaded.update(1000) // quarter period → mover near apex
    expect(Math.abs(mover.position.y - m0)).toBeGreaterThan(0.5)
    expect(stat.position.y).toBe(s0) // sibling untouched
    world.free()
  })

  it('a trigger piece exposes a collider the character contact-detects', () => {
    const world = createPhysicsWorld() // character drives its own vertical movement
    const level: Level = {
      id: 'trig',
      config: { fallBehavior: 'physical-fall', fallY: -10 },
      instances: [
        {
          prefab: {
            id: 'pad',
            pieces: [{ collider: { kind: 'box', halfExtents: vec3(3, 0.25, 3) }, transform: { position: vec3(0, 0, 0) }, trigger: 'hazard' }],
          },
          transform: { position: vec3(0, 0, 0) },
        },
      ],
    }
    const loaded = instantiateLevel(world, level)
    const trig = loaded.triggers.find((t) => t.kind === 'hazard')
    expect(trig).toBeDefined()

    const char = world.addCharacter({ position: { x: 0, y: 2, z: 0 }, radius: 0.4, halfHeight: 0.5 })
    let hit = false
    for (let i = 0; i < 120; i++) {
      char.move({ x: 0, y: -0.05, z: 0 })
      world.step(1 / 60)
      if (char.collisions().includes(trig!.colliderHandle)) hit = true // real contact with the pad
    }
    expect(hit).toBe(true)
    world.free()
  })

  it('render(alpha) interpolates a moving piece between the last two sim poses', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, fixture)
    loaded.update(0) // prev = curr = pose(0)
    const a = loaded.visuals.find((v) => v.style === 'moving')!.position.y
    loaded.update(1000) // prev = pose(0), curr = pose(1000)
    const lift = loaded.visuals.find((v) => v.style === 'moving')!
    const b = lift.position.y
    expect(Math.abs(b - a)).toBeGreaterThan(0.5) // it actually moved between ticks

    loaded.render(0)
    expect(lift.position.y).toBeCloseTo(a, 6) // alpha 0 → the previous tick
    loaded.render(1)
    expect(lift.position.y).toBeCloseTo(b, 6) // alpha 1 → the latest tick
    loaded.render(0.5)
    expect(lift.position.y).toBeCloseTo((a + b) / 2, 6) // halfway
    world.free()
  })

  it('applies a rotated static collider (ramp)', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const tilt = vec3(0, 0, Math.PI / 6)
    const loaded = instantiateLevel(world, {
      id: 'ramp',
      config: { fallBehavior: 'physical-fall', fallY: -3 },
      instances: [
        {
          prefab: { id: 'r', pieces: [{ collider: { kind: 'box', halfExtents: vec3(2, 0.1, 1) }, transform: { position: vec3(0, 0, 0), rotation: tilt } }] },
          transform: { position: vec3(0, 0, 0) },
        },
      ],
    })
    const q = eulerToQuat(tilt)
    expect(loaded.visuals[0]!.rotation.z).toBeCloseTo(q.z, 6)
    expect(loaded.visuals[0]!.rotation.w).toBeCloseTo(q.w, 6)
    world.free()
  })

  it('spins a rotate-behavior piece over time', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, {
      id: 'bar',
      config: { fallBehavior: 'physical-fall', fallY: -3 },
      instances: [
        {
          prefab: { id: 'b', pieces: [{ collider: { kind: 'box', halfExtents: vec3(2, 0.1, 0.1) }, transform: { position: vec3(0, 1, 0) } }] },
          transform: { position: vec3(0, 0, 0) },
          behavior: { kind: 'rotate', axis: vec3(0, 1, 0), periodMs: 4000 },
        },
      ],
    })
    const bar = loaded.visuals[0]!
    loaded.update(0)
    expect(bar.rotation.w).toBeCloseTo(1, 6) // θ=0 → identity
    loaded.update(1000) // quarter of the 4000ms period → 90° about Y
    expect(Math.abs(bar.rotation.y)).toBeGreaterThan(0.5)
    world.free()
  })

  // Trigger pieces are the only ones whose collider handle the loader publishes, so these
  // fixtures tag the moving piece as a hazard to get at it (a moving hazard is real content).
  it('basePose reports a moving piece pose, and nothing for a static collider', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, {
      id: 'lift',
      config: { fallBehavior: 'physical-fall', fallY: -3 },
      instances: [
        {
          prefab: { id: 'g', pieces: [{ collider: { kind: 'box', halfExtents: vec3(5, 0.1, 5) }, transform: { position: vec3(0, -2, 0) }, trigger: 'checkpoint' }] },
          transform: { position: vec3(0, 0, 0) },
        },
        {
          prefab: { id: 'l', pieces: [{ collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) }, transform: { position: vec3(0, 0, 0) }, trigger: 'hazard' }] },
          transform: { position: vec3(0, 2, 0) },
          behavior: { kind: 'move', axis: vec3(0, 1, 0), distance: 2, periodMs: 4000 },
        },
      ],
    })
    const lift = loaded.triggers.find((t) => t.kind === 'hazard')!
    const staticFloor = loaded.triggers.find((t) => t.kind === 'checkpoint')!
    const visual = loaded.visuals[1]!

    loaded.update(0)
    const y0 = visual.position.y
    loaded.update(1000) // quarter period
    expect(visual.position.y - y0).toBeGreaterThan(0.5) // it really moved

    // The pose a rider keeps its position in: the piece's live pose, tracking `update`.
    const pose = loaded.basePose(lift.colliderHandle)!
    expect(pose.position.y).toBeCloseTo(visual.position.y, 6)
    expect(pose.rotation.w).toBeCloseTo(1, 6) // a mover does not spin
    // Static geometry is not a movement base — nothing to ride.
    expect(loaded.basePose(staticFloor.colliderHandle)).toBeUndefined()
    world.free()
  })

  it('basePose follows a spinning piece orientation', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, {
      id: 'disc',
      config: { fallBehavior: 'physical-fall', fallY: -3 },
      instances: [
        {
          prefab: { id: 'd', pieces: [{ collider: { kind: 'box', halfExtents: vec3(3, 0.2, 3) }, transform: { position: vec3(0, 0, 0) }, trigger: 'hazard' }] },
          transform: { position: vec3(0, 0, 0) },
          behavior: { kind: 'rotate', axis: vec3(0, 1, 0), periodMs: 4000 },
        },
      ],
    })
    const disc = loaded.triggers[0]!
    loaded.update(0)
    expect(loaded.basePose(disc.colliderHandle)!.rotation.w).toBeCloseTo(1, 6) // θ=0 → identity
    loaded.update(1000) // quarter period → +90° about +y

    // A quarter turn about +y: (x,y,z,w) = (0, sin45, 0, cos45). A rider's stored local point
    // maps through this, which is what makes it orbit rather than spin in place.
    const pose = loaded.basePose(disc.colliderHandle)!
    expect(pose.rotation.y).toBeCloseTo(Math.SQRT1_2, 5)
    expect(pose.rotation.w).toBeCloseTo(Math.SQRT1_2, 5)
    expect(pose.position.y).toBeCloseTo(0, 6) // spins in place, does not translate
    world.free()
  })

  it('a convex collider becomes a real solid the character rests on', () => {
    const world = createPhysicsWorld() // character drives its own vertical movement
    // A wedge: the end faces are not parallel, which is exactly what a box cannot express.
    const points = [
      vec3(-2, -0.25, -2),
      vec3(-2, -0.25, 2),
      vec3(-2, 0.25, -2),
      vec3(-2, 0.25, 2),
      vec3(2, -0.25, -1),
      vec3(2, -0.25, 1),
      vec3(2, 0.25, -1),
      vec3(2, 0.25, 1),
    ]
    const loaded = instantiateLevel(world, {
      id: 'convex',
      config: { fallBehavior: 'physical-fall', fallY: -10 },
      instances: [{ prefab: { id: 'wedge', pieces: [{ collider: { kind: 'convex', points }, transform: { position: vec3(0, 0, 0) } }] }, transform: { position: vec3(0, 0, 0) } }],
    })
    expect(loaded.visuals[0]!.collider.kind).toBe('convex')

    const char = world.addCharacter({ position: vec3(0, 3, 0), radius: 0.4, halfHeight: 0.5 })
    for (let i = 0; i < 120; i++) {
      char.move({ x: 0, y: -0.05, z: 0 })
      world.step(1 / 60)
    }
    // Landed on the top face (y = 0.25) rather than falling through it.
    expect(char.translation().y).toBeGreaterThan(0.25)
    expect(char.translation().y).toBeLessThan(2)
    world.free()
  })

  it('bakes scale into convex points exactly, unlike ball and capsule', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const points = [vec3(-1, -1, -1), vec3(1, -1, -1), vec3(-1, 1, -1), vec3(1, 1, -1), vec3(-1, -1, 1), vec3(1, -1, 1), vec3(-1, 1, 1), vec3(1, 1, 1)]
    const loaded = instantiateLevel(world, {
      id: 'scaled-convex',
      config: { fallBehavior: 'physical-fall', fallY: -10 },
      instances: [
        {
          prefab: { id: 'c', pieces: [{ collider: { kind: 'convex', points }, transform: { position: vec3(0, 0, 0) } }] },
          transform: { position: vec3(0, 0, 0), scale: vec3(2, 3, 4) },
        },
      ],
    })
    const col = loaded.visuals[0]!.collider
    expect(col.kind).toBe('convex')
    if (col.kind !== 'convex') return
    // Every point scaled per-axis — no approximation, which is the ball/capsule limitation.
    expect(col.points[0]).toEqual(vec3(-2, -3, -4))
    expect(col.points[7]).toEqual(vec3(2, 3, 4))
    world.free()
  })

  it('rotates child piece positions by the instance rotation', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, {
      id: 'inst-rot',
      config: { fallBehavior: 'physical-fall', fallY: -3 },
      instances: [
        {
          prefab: { id: 'p', pieces: [{ collider: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }, transform: { position: vec3(1, 0, 0) } }] },
          transform: { position: vec3(10, 0, 0), rotation: vec3(0, Math.PI / 2, 0) }, // +90° about Y
        },
      ],
    })
    // Local (1,0,0) rotated +90° about Y → (0,0,-1), plus origin (10,0,0).
    const p = loaded.visuals[0]!.position
    expect(p.x).toBeCloseTo(10, 6)
    expect(p.z).toBeCloseTo(-1, 6)
    world.free()
  })
})
