import { entityId } from '@mp/core'
import { STATE_GROUNDED, STATE_RISING, type Snapshot } from '@mp/net'
import { describe, expect, it } from 'vitest'

import { interpolateAt } from './interpolation'

const snap = (t: number, x: number): Snapshot => ({
  serverTimeMs: t,
  entities: [{ id: entityId(1), position: { x, y: 0, z: 0 }, flags: 0 }],
})

const withFlags = (t: number, x: number, flags: number): Snapshot => ({
  serverTimeMs: t,
  entities: [{ id: entityId(1), position: { x, y: 0, z: 0 }, flags }],
})

describe('interpolateAt', () => {
  it('interpolates halfway between two snapshots', () => {
    expect(interpolateAt([snap(0, 0), snap(100, 10)], 50)[0]!.position.x).toBeCloseTo(5)
  })

  it('does not interpolate state flags — they hold the sample at or before the render time', () => {
    // Blending "grounded" toward "airborne" is meaningless, and fading a state change in early
    // would start an air pose while the player is still on the ground.
    const buf = [withFlags(0, 0, STATE_GROUNDED), withFlags(100, 10, STATE_RISING)]
    expect(interpolateAt(buf, 1)[0]!.flags).toBe(STATE_GROUNDED)
    expect(interpolateAt(buf, 99)[0]!.flags).toBe(STATE_GROUNDED) // still the older sample
    expect(interpolateAt(buf, 100)[0]!.flags).toBe(STATE_RISING) // lands exactly on the change
    expect(interpolateAt(buf, 150)[0]!.flags).toBe(STATE_RISING)
  })

  it('holds the earliest snapshot before the buffered range', () => {
    expect(interpolateAt([snap(100, 3), snap(200, 9)], 50)[0]!.position.x).toBe(3)
  })

  it('holds the latest snapshot after the buffered range', () => {
    expect(interpolateAt([snap(0, 3), snap(100, 9)], 999)[0]!.position.x).toBe(9)
  })

  it('selects the correct bracket among many snapshots', () => {
    const buf = [snap(0, 0), snap(100, 10), snap(200, 20), snap(300, 30)]
    expect(interpolateAt(buf, 250)[0]!.position.x).toBeCloseTo(25)
  })

  it('returns empty for an empty buffer', () => {
    expect(interpolateAt([], 0)).toEqual([])
  })
})

