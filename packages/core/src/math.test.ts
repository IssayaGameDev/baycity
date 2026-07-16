import { describe, expect, it } from 'vitest'

import { clamp, lerp, lerpVec3 } from './math'

describe('math', () => {
  it('lerp hits endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0)
    expect(lerp(0, 10, 1)).toBe(10)
    expect(lerp(0, 10, 0.5)).toBe(5)
  })

  it('clamp bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })

  it('lerpVec3 interpolates component-wise', () => {
    expect(lerpVec3({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 }, 0.5)).toEqual({
      x: 1,
      y: 2,
      z: 3,
    })
  })
})
