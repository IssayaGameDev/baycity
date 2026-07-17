import { entityId } from '@mp/core'
import type { Snapshot } from '@mp/net'
import { describe, expect, it } from 'vitest'

import { interpolateAt } from './interpolation'

const snap = (t: number, x: number): Snapshot => ({
  serverTimeMs: t,
  lastProcessedInputSeq: 0,
  entities: [{ id: entityId(1), position: { x, y: 0, z: 0 } }],
})

describe('interpolateAt', () => {
  it('interpolates halfway between two snapshots', () => {
    expect(interpolateAt([snap(0, 0), snap(100, 10)], 50)[0]!.position.x).toBeCloseTo(5)
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
