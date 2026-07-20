import { describe, expect, it } from 'vitest'

import { axisAngleToQuat, clamp, eulerToQuat, lerp, lerpVec3, mulQuat, quat, rotateVec3, vec3 } from './math'

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

  const closeQuat = (a: ReturnType<typeof quat>, b: ReturnType<typeof quat>): void => {
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.y).toBeCloseTo(b.y, 6)
    expect(a.z).toBeCloseTo(b.z, 6)
    expect(a.w).toBeCloseTo(b.w, 6)
  }

  it('eulerToQuat matches axisAngleToQuat for a single-axis rotation', () => {
    closeQuat(eulerToQuat(vec3(0, Math.PI / 2, 0)), axisAngleToQuat(vec3(0, 1, 0), Math.PI / 2))
    closeQuat(eulerToQuat(vec3(Math.PI / 3, 0, 0)), axisAngleToQuat(vec3(1, 0, 0), Math.PI / 3))
  })

  it('rotateVec3 rotates +x to -z under a +90° yaw', () => {
    const r = rotateVec3(axisAngleToQuat(vec3(0, 1, 0), Math.PI / 2), vec3(1, 0, 0))
    expect(r.x).toBeCloseTo(0, 6)
    expect(r.y).toBeCloseTo(0, 6)
    expect(r.z).toBeCloseTo(-1, 6)
  })

  it('mulQuat composes rotations (two quarter turns = one half turn)', () => {
    const q90 = axisAngleToQuat(vec3(0, 1, 0), Math.PI / 2)
    const r = rotateVec3(mulQuat(q90, q90), vec3(1, 0, 0))
    expect(r.x).toBeCloseTo(-1, 6)
    expect(r.z).toBeCloseTo(0, 6)
  })

  it('axisAngleToQuat normalizes a non-unit axis', () => {
    closeQuat(axisAngleToQuat(vec3(0, 5, 0), Math.PI / 2), axisAngleToQuat(vec3(0, 1, 0), Math.PI / 2))
  })
})
