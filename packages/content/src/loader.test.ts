import { vec3 } from '@mp/core'
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
})
