import { axisAngleToQuat, eulerToQuat, rotateVec3, vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLevel } from './loader'
import type { Level } from './types'

/** A material asset id, so the moving piece is findable in `visuals` by what it is surfaced with. */
const MOVING_MAT = '19079ddb3fbfb27e'

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
        pieces: [{ collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) }, transform: { position: vec3(0, 0, 0) }, visual: { kind: 'primitive', material: MOVING_MAT } }],
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

    const lift = loaded.visuals.find((v) => v.material === MOVING_MAT)!
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
    const a = loaded.visuals.find((v) => v.material === MOVING_MAT)!.position.y
    loaded.update(1000) // prev = pose(0), curr = pose(1000)
    const lift = loaded.visuals.find((v) => v.material === MOVING_MAT)!
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

  it('gives every clock-driven piece a stable index, and poses it at tick or at render time', () => {
    // The machinery relative-to-base replication stands on (ADR 0021). A rider sends the index of the
    // piece it is on and its position *in that piece's frame*; a viewer has to turn that back into a world
    // position against the pose the deck was **drawn** at, which is not the same as the pose physics last
    // resolved against. Getting that distinction wrong is the whole bug this replaced: the rider ends up
    // 100 ms behind the deck and slides across it whenever the platform turns around.
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, {
      id: 'bases',
      config: { fallBehavior: 'physical-fall', fallY: -3 },
      instances: [
        // A static piece first, to prove the index counts clock-driven pieces rather than all of them.
        {
          prefab: { id: 's', pieces: [{ collider: { kind: 'box', halfExtents: vec3(2, 0.2, 2) }, transform: { position: vec3(0, 0, 0) }, trigger: 'checkpoint' }] },
          transform: { position: vec3(0, 0, 0) },
        },
        {
          prefab: { id: 'm', pieces: [{ collider: { kind: 'box', halfExtents: vec3(2, 0.2, 2) }, transform: { position: vec3(0, 0, 0) }, trigger: 'hazard' }] },
          transform: { position: vec3(0, 1, 0) },
          behavior: { kind: 'move', axis: vec3(1, 0, 0), distance: 8, periodMs: 4000 },
        },
        {
          prefab: { id: 'r', pieces: [{ collider: { kind: 'box', halfExtents: vec3(2, 0.2, 2) }, transform: { position: vec3(0, 0, 0) }, trigger: 'goal' }] },
          transform: { position: vec3(0, 3, 0) },
          behavior: { kind: 'rotate', axis: vec3(0, 1, 0), periodMs: 8000 },
        },
      ],
    })
    const mover = loaded.triggers.find((t) => t.kind === 'hazard')!
    const turntable = loaded.triggers.find((t) => t.kind === 'goal')!
    const staticFloor = loaded.triggers.find((t) => t.kind === 'checkpoint')!

    // Indices are dense over the clock-driven pieces, in level order, and static geometry has none.
    expect(loaded.baseIndex(mover.colliderHandle)).toBe(0)
    expect(loaded.baseIndex(turntable.colliderHandle)).toBe(1)
    expect(loaded.baseIndex(staticFloor.colliderHandle)).toBeUndefined()
    expect(loaded.basePoseOf(2, 'render')).toBeUndefined()

    // Two ticks apart, then drawn halfway between them: the render pose is the interpolated one, which is
    // where the deck visibly is, and the tick pose is where physics left it. A viewer must use the first.
    loaded.update(0)
    const atZero = loaded.basePoseOf(0, 'tick')!.position.x
    loaded.update(500)
    const atTick = loaded.basePoseOf(0, 'tick')!.position.x
    expect(atTick, 'the piece really moved between the two ticks').toBeGreaterThan(atZero + 0.5)
    expect(loaded.basePose(mover.colliderHandle)!.position.x, 'same pose the carry solver reads').toBeCloseTo(atTick, 9)
    loaded.render(0.5)
    expect(loaded.basePoseOf(0, 'render')!.position.x, 'drawn halfway between the last two ticks').toBeCloseTo(
      (atZero + atTick) / 2,
      9,
    )
    expect(loaded.basePoseOf(0, 'tick')!.position.x, 'and the tick pose is untouched by drawing').toBeCloseTo(atTick, 9)

    // The round trip a rider makes: a *fixed* point in the deck's frame becomes a world point that tracks
    // the deck exactly. That is the whole mechanism — the number on the wire does not change while the
    // platform moves, so no amount of latency can slide the rider across the deck.
    const stand = vec3(0.5, 0.6, -1.25)
    const worldOn = (index: number): Vec3 => {
      const deck = loaded.basePoseOf(index, 'render')!
      const p = rotateVec3(deck.rotation, stand)
      return vec3(deck.position.x + p.x, deck.position.y + p.y, deck.position.z + p.z)
    }
    const before = worldOn(0)
    loaded.update(1000)
    loaded.render(1)
    const after = worldOn(0)
    const deckMoved = loaded.basePoseOf(0, 'render')!.position.x - (atZero + atTick) / 2
    expect(after.x - before.x, 'the rider travels exactly as far as the deck did').toBeCloseTo(deckMoved, 9)
    expect(after.y).toBeCloseTo(before.y, 9)

    // A turntable's frame carries rotation, so the same round trip has to go through its orientation.
    loaded.update(2000) // quarter period -> +90 deg about Y
    loaded.render(1)
    const spun = loaded.basePoseOf(1, 'render')!
    const point = rotateVec3(spun.rotation, vec3(1, 0, 0)) // local +x
    expect(point.z, 'local +x should have swung to -z').toBeCloseTo(-1, 3)
    world.free()
  })

  it('reports what a moving piece does to whoever stands on it, translation and spin alike', () => {
    // A rider's `carry` for free: the wire already says which piece they ride (ADR 0021), and a piece's
    // own motion is known to every client, so the velocity it imparts at the rider's exact spot needs no
    // bytes. This is what lets a peer brace against a deck starting under them.
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const T = 4000
    const DIST = 8
    const loaded = instantiateLevel(world, {
      id: 'carry',
      config: { fallBehavior: 'physical-fall', fallY: -3 },
      instances: [
        {
          prefab: { id: 'm', pieces: [{ collider: { kind: 'box', halfExtents: vec3(2, 0.2, 2) }, transform: { position: vec3(0, 0, 0) }, trigger: 'hazard' }] },
          transform: { position: vec3(0, 1, 0) },
          behavior: { kind: 'move', axis: vec3(1, 0, 0), distance: DIST, periodMs: T },
        },
        {
          prefab: { id: 'r', pieces: [{ collider: { kind: 'box', halfExtents: vec3(2, 0.2, 2) }, transform: { position: vec3(0, 0, 0) }, trigger: 'goal' }] },
          transform: { position: vec3(0, 3, 0) },
          behavior: { kind: 'rotate', axis: vec3(0, 1, 0), periodMs: T },
        },
      ],
    })
    const stand = vec3(1.5, 0.2, 0)

    // Nothing to difference against on the first update.
    loaded.update(0)
    expect(loaded.baseCarry(0, stand)).toEqual(vec3(0, 0, 0))

    // A quarter period in, the mover is at its fastest: x = distance·(1 − cos(2πt/T))/2, so the speed is
    // distance·π/T — 6.28 m/s here. Sampled across a 10 ms step, which is close enough to the derivative.
    loaded.update(T / 4 - 5)
    loaded.update(T / 4 + 5)
    const peak = (DIST * Math.PI) / (T / 1000)
    expect(loaded.baseCarry(0, stand)!.x).toBeCloseTo(peak, 2)
    expect(loaded.baseCarry(0, stand)!.z).toBeCloseTo(0, 6)

    // At the end of the travel it is momentarily still — which is why the *slide* a viewer used to see
    // peaked at the reversal while the offset peaked mid-travel (ADR 0021).
    loaded.update(T / 2 - 5)
    loaded.update(T / 2 + 5)
    expect(Math.abs(loaded.baseCarry(0, stand)!.x)).toBeLessThan(0.05)

    // The turntable is the case a position-only difference would miss: the piece's origin never moves, so
    // all of the rider's motion is tangential. |v| = ω·r, and it is perpendicular to the radius.
    loaded.update(0)
    loaded.update(10)
    const spin = loaded.baseCarry(1, stand)!
    const omega = (2 * Math.PI) / (T / 1000)
    expect(Math.hypot(spin.x, spin.z), 'tangential speed is omega times radius').toBeCloseTo(omega * 1.5, 2)
    // Perpendicular to the radius at the *midpoint* of the arc, not at its start: a finite difference
    // measures the chord, which carries a half-angle bias of |v|·r·sin(omega·dt/2) — here 0.028, entirely
    // inherent to taking a velocity by differencing and not worth removing. Against the mid-arc radius it
    // is exactly perpendicular, which is the property actually worth asserting.
    const mid = rotateVec3(axisAngleToQuat(vec3(0, 1, 0), (omega * 10) / 1000 / 2), stand)
    expect(spin.x * mid.x + spin.z * mid.z).toBeCloseTo(0, 9)
    expect(spin.y, 'a turntable lifts nobody').toBeCloseTo(0, 6)

    // A rider at the axis is carried nowhere at all, however fast it spins.
    expect(Math.hypot(...Object.values(loaded.baseCarry(1, vec3(0, 0, 0))!))).toBeCloseTo(0, 6)
    expect(loaded.baseCarry(2, stand), 'no such piece').toBeUndefined()
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
