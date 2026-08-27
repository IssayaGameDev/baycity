import { vec3 } from '@mp/core'
import type { WorldMarker } from '@mp/content'

import { describe, expect, it } from 'vitest'

import { spawnFrom, standingAt } from './spawn'

/**
 * The shared spawn placement — one copy now, where parkour, swing and the template each had their own
 * (identical) one.
 *
 * What is tested here is the part that became a parameter: the stand-off height. The rest of the behaviour is
 * also covered end-to-end through `modes/parkour/src/rules.test.ts`, which runs it against a real loaded
 * level; these read only the markers, which is all the function does.
 */

const markers = (...at: readonly ReturnType<typeof vec3>[]): { markers: WorldMarker[] } => ({
  markers: at.map((position) => ({ kind: 'spawn', position })),
})

describe('standingAt', () => {
  it('lifts a point by the stand-off, leaving the ground plane alone', () => {
    expect(standingAt(vec3(4, 1, 6), 1)).toEqual(vec3(4, 2, 6))
  })
})

describe('spawnFrom', () => {
  it('stands the character on the marker rather than inside it', () => {
    expect(spawnFrom(1)(markers(vec3(4, 1, 6)))).toEqual(vec3(4, 2, 6))
  })

  /** The whole reason the offset is a parameter: a game whose character is a different size gets its own. */
  it(`honours the game's own stand-off`, () => {
    expect(spawnFrom(0.25)(markers(vec3(0, 0, 0))).y).toBe(0.25)
    expect(spawnFrom(4)(markers(vec3(0, 0, 0))).y).toBe(4)
  })

  it('falls back above the origin when a level has no spawn', () => {
    expect(spawnFrom(1)({ markers: [] })).toEqual(vec3(0, 3, 0))
  })

  it('takes the first marker when a level has several', () => {
    expect(spawnFrom(0)(markers(vec3(1, 0, 0), vec3(9, 0, 0))).x).toBe(1)
  })

  describe('with a seed', () => {
    const loaded = markers(vec3(4, 1, 6))

    it('fans arrivals around the marker at a constant radius, all at standing height', () => {
      for (const seed of [0, 1, 2, 7, 40]) {
        const at = spawnFrom(1)(loaded, seed)
        expect(Math.hypot(at.x - 4, at.z - 6)).toBeCloseTo(2, 6)
        expect(at.y).toBe(2)
      }
    })

    /** Two players must never arrive inside each other, which is the only reason the fan exists. */
    it('puts no two of forty players in the same place', () => {
      const seen = new Set(Array.from({ length: 40 }, (_, i) => spawnFrom(1)(loaded, i)).map((p) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`))
      expect(seen.size).toBe(40)
    })

    /** A tool passes no seed and gets the marker itself — not seed 0, which is on the fan's edge. */
    it('is not the same as seed 0', () => {
      expect(spawnFrom(1)(loaded)).not.toEqual(spawnFrom(1)(loaded, 0))
    })
  })
})
