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
      behavior: { kind: 'move', axis: vec3(0, 1, 0), amplitude: 1.5, periodMs: 4000 },
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
    const y0 = lift.position.y
    loaded.update(1000) // quarter of the 4000ms period → near apex
    expect(Math.abs(lift.position.y - y0)).toBeGreaterThan(0.5)

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
