import { entityId, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { createRewindBuffer, hitScan, raySphere } from './rewind'

const SHOOTER = entityId(1000)
const TARGET = entityId(1001)

describe('rewind buffer', () => {
  it('reconstructs interpolated positions at a past time', () => {
    const rb = createRewindBuffer()
    rb.record(0, new Map([[TARGET, { x: 0, y: 0, z: 0 }]]))
    rb.record(100, new Map([[TARGET, { x: 10, y: 0, z: 0 }]]))
    expect(rb.positionsAt(50).get(TARGET)!.x).toBeCloseTo(5)
  })

  it('clamps to the buffered range', () => {
    const rb = createRewindBuffer()
    rb.record(100, new Map([[TARGET, { x: 3, y: 0, z: 0 }]]))
    rb.record(200, new Map([[TARGET, { x: 9, y: 0, z: 0 }]]))
    expect(rb.positionsAt(0).get(TARGET)!.x).toBe(3) // before oldest
    expect(rb.positionsAt(999).get(TARGET)!.x).toBe(9) // after newest
  })
})

describe('raySphere', () => {
  it('hits a sphere in the ray path', () => {
    expect(raySphere({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, 0.5)).not.toBeNull()
  })
  it('misses a sphere off the ray path', () => {
    expect(raySphere({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 1 }, { x: 5, y: 0, z: 0 }, 0.5)).toBeNull()
  })
})

describe('lag compensation', () => {
  it('hits the target at its rewound position but misses at the present one', () => {
    const rb = createRewindBuffer()
    rb.record(0, new Map([[TARGET, { x: 0, y: 0, z: 0 }]]))
    rb.record(100, new Map([[TARGET, { x: 10, y: 0, z: 0 }]]))

    // The shooter aimed where they saw the target — its position at t=50 (x=5).
    const origin: Vec3 = { x: 5, y: 0, z: -10 }
    const dir: Vec3 = { x: 0, y: 0, z: 1 }

    expect(hitScan(rb.positionsAt(50), origin, dir, 0.5, SHOOTER)).toBe(TARGET) // rewound: hit
    expect(hitScan(rb.positionsAt(100), origin, dir, 0.5, SHOOTER)).toBeNull() // present: target moved on -> miss
  })

  it('never hits the shooter itself', () => {
    const rb = createRewindBuffer()
    rb.record(0, new Map([[SHOOTER, { x: 0, y: 0, z: 0 }]]))
    expect(hitScan(rb.positionsAt(0), { x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 1 }, 0.5, SHOOTER)).toBeNull()
  })
})
