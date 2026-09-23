import { eulerToQuat, rotateVec3, vec3, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { distanceAlongAxis, faceFromNormal, pulled, snappedPull, type Axis, type Face } from './facePull'

const v = (x: number, y: number, z: number) => ({ x, y, z })
const DEG = Math.PI / 180
/** The pulled axis as a unit vector. Unrotated, so parent frame and node frame are the same one. */
const flat = (a: Axis): Vec3 => v(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0)
/** The same axis carried into the parent's frame by the node's own rotation, in degrees. */
const turned = (a: Axis, deg: Vec3): Vec3 => rotateVec3(eulerToQuat(vec3(deg.x * DEG, deg.y * DEG, deg.z * DEG)), flat(a))

describe('faceFromNormal', () => {
  it('names each of the six faces', () => {
    expect(faceFromNormal(v(1, 0, 0))).toEqual({ axis: 'x', sign: 1 })
    expect(faceFromNormal(v(-1, 0, 0))).toEqual({ axis: 'x', sign: -1 })
    expect(faceFromNormal(v(0, 1, 0))).toEqual({ axis: 'y', sign: 1 })
    expect(faceFromNormal(v(0, -1, 0))).toEqual({ axis: 'y', sign: -1 })
    expect(faceFromNormal(v(0, 0, 1))).toEqual({ axis: 'z', sign: 1 })
    expect(faceFromNormal(v(0, 0, -1))).toEqual({ axis: 'z', sign: -1 })
  })

  /** A rounded box's fillets point between two axes, and a rounded box is one of the two shapes this works on. */
  it('picks the face a fillet belongs to', () => {
    expect(faceFromNormal(v(0.9, 0.4, 0.1))).toEqual({ axis: 'x', sign: 1 })
    expect(faceFromNormal(v(-0.2, -0.95, 0.2))).toEqual({ axis: 'y', sign: -1 })
    expect(faceFromNormal(v(0.3, 0.3, -0.9))).toEqual({ axis: 'z', sign: -1 })
  })

  it('gives null for no direction at all', () => {
    expect(faceFromNormal(v(0, 0, 0))).toBeNull()
  })
})

describe('distanceAlongAxis', () => {
  it('measures along the line, not along the ray', () => {
    // A ray straight down at x = 3, against the x axis through the origin: nearest point is x = 3.
    const t = distanceAlongAxis(v(3, 5, 0), v(0, -1, 0), v(0, 0, 0), v(1, 0, 0))
    expect(t).toBeCloseTo(3, 6)
  })

  it('is signed', () => {
    expect(distanceAlongAxis(v(-2, 5, 0), v(0, -1, 0), v(0, 0, 0), v(1, 0, 0))).toBeCloseTo(-2, 6)
  })

  it('measures from the line origin, not from the world origin', () => {
    expect(distanceAlongAxis(v(3, 5, 0), v(0, -1, 0), v(1, 0, 0), v(1, 0, 0))).toBeCloseTo(2, 6)
  })

  it('works at an angle', () => {
    // Ray from above-left heading down-right at 45 degrees crosses x = 4 at y = 0.
    const t = distanceAlongAxis(v(0, 4, 0), v(Math.SQRT1_2, -Math.SQRT1_2, 0), v(0, 0, 0), v(1, 0, 0))
    expect(t).toBeCloseTo(4, 6)
  })

  /** Looking straight down the axis there is no nearest point; the caller holds its last value. */
  it('gives null when the ray runs along the line', () => {
    expect(distanceAlongAxis(v(-5, 0, 0), v(1, 0, 0), v(0, 0, 0), v(1, 0, 0))).toBeNull()
  })
})

describe('snappedPull', () => {
  /**
   * Snapping where the face **lands**, not how far it moved. Snapping the movement would anchor the grid to
   * wherever the face started, which is the fault ADR 0113, ADR 0114 and ADR 0117 each fixed in turn.
   */
  it('lands the face on the grid from an off-grid start', () => {
    // Face at 2.3, dragged 0.4 -> would be 2.7, snaps to 3, so the delta is 0.7.
    expect(snappedPull(2.3, 0.4, 1)).toBeCloseTo(0.7, 6)
  })

  it('can bring a face back onto the grid with a tiny drag', () => {
    expect(snappedPull(2.3, 0.05, 1)).toBeCloseTo(-0.3, 6)
  })

  it('passes the raw distance through with no step', () => {
    expect(snappedPull(2.3, 0.41, 0)).toBeCloseTo(0.41, 6)
  })
})

describe('pulled', () => {
  const scale = v(2, 1, 4)
  const position = v(10, 0, 0)

  it('grows the size by the distance and the centre by half, toward the face pulled', () => {
    const out = pulled(scale, position, { axis: 'x', sign: 1 }, 2, 0.1, flat('x'))
    expect(out.scale.x).toBeCloseTo(4, 6)
    expect(out.position.x).toBeCloseTo(11, 6)
  })

  it('moves the centre the other way for the opposite face', () => {
    const out = pulled(scale, position, { axis: 'x', sign: -1 }, 2, 0.1, flat('x'))
    expect(out.scale.x).toBeCloseTo(4, 6)
    expect(out.position.x).toBeCloseTo(9, 6)
  })

  /** The face that was not grabbed must not move. That is the whole difference from scaling. */
  it('leaves the opposite face exactly where it was', () => {
    for (const sign of [1, -1] as const) {
      const far = position.x - (sign * scale.x) / 2
      const out = pulled(scale, position, { axis: 'x', sign }, 1.7, 0.1, flat('x'))
      expect(out.position.x - (sign * out.scale.x) / 2, `sign ${sign}`).toBeCloseTo(far, 6)
    }
  })

  it('pulls inward too', () => {
    const out = pulled(scale, position, { axis: 'x', sign: 1 }, -1, 0.1, flat('x'))
    expect(out.scale.x).toBeCloseTo(1, 6)
    expect(out.position.x).toBeCloseTo(9.5, 6)
  })

  it('stops at the minimum instead of inverting', () => {
    const out = pulled(scale, position, { axis: 'x', sign: 1 }, -50, 0.5, flat('x'))
    expect(out.scale.x).toBe(0.5)
    // And the far face still has not moved, even though the pull was refused partway.
    expect(out.position.x - out.scale.x / 2).toBeCloseTo(position.x - scale.x / 2, 6)
  })

  it('touches only the axis pulled', () => {
    const out = pulled(scale, position, { axis: 'z', sign: 1 }, 1, 0.1, flat('z'))
    expect(out.scale.x).toBe(2)
    expect(out.scale.y).toBe(1)
    expect(out.scale.z).toBeCloseTo(5, 6)
    expect(out.position.x).toBe(10)
    expect(out.position.z).toBeCloseTo(0.5, 6)
  })
})

/**
 * A rotated box (ADR 0119).
 *
 * Scale is in the node's own frame and position is in its parent's, and they are not the same frame. The
 * first version moved the centre along the parent's axis while the face moved along the node's, so a rotated
 * box slid away as it grew. None of the tests above could see it: every one of them uses an unrotated box.
 */
describe('pulled, on a rotated box', () => {
  /** Centre of the face opposite the one grabbed, in the parent's frame. This is what must not move. */
  const farFace = (pos: Vec3, scale: Vec3, face: Face, axis: Vec3): Vec3 => {
    const half = (scale[face.axis] * face.sign) / 2
    return v(pos.x - axis.x * half, pos.y - axis.y * half, pos.z - axis.z * half)
  }
  const apart = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

  /** Kodjo's authored platform, the one the bug was reported on. */
  const position = v(-4.11, 61.8, 21.2)
  const rotation = v(-90, -75.0002, -90)
  const scale = v(8.4, 0.3, 38)

  it('leaves the opposite face where it was, at every rotation and on every face', () => {
    // 180 degrees was the worst of these: the centre used to move the whole pull, backwards.
    for (const rot of [v(0, 0, 0), v(0, 5, 0), v(0, 45, 0), v(0, 90, 0), v(0, 180, 0), v(90, 0, 0), v(0, 0, 90), rotation]) {
      for (const ax of ['x', 'y', 'z'] as const) {
        for (const sign of [1, -1] as const) {
          const face: Face = { axis: ax, sign }
          const axis = turned(ax, rot)
          const before = farFace(position, scale, face, axis)
          const out = pulled(scale, position, face, 5, 0.1, axis)
          const label = `(${rot.x}, ${rot.y}, ${rot.z}) ${sign > 0 ? '+' : '-'}${ax}`
          expect(apart(before, farFace(out.position, out.scale, face, axis)), label).toBeCloseTo(0, 6)
        }
      }
    }
  })

  it('moves the centre along the box own axis, not the parent one', () => {
    // Turned 90 degrees about y, the node's local +x points along the parent's -z.
    const axis = turned('x', v(0, 90, 0))
    const out = pulled(v(2, 1, 4), v(0, 0, 0), { axis: 'x', sign: 1 }, 2, 0.1, axis)
    expect(out.scale.x).toBeCloseTo(4, 6)
    expect(out.position.x).toBeCloseTo(0, 6)
    expect(out.position.z).toBeCloseTo(-1, 6)
  })

  it('still refuses to invert, and holds the far face when it does', () => {
    const face: Face = { axis: 'y', sign: 1 }
    const axis = turned('y', rotation)
    const before = farFace(position, scale, face, axis)
    const out = pulled(scale, position, face, -50, 0.5, axis)
    expect(out.scale.y).toBe(0.5)
    expect(apart(before, farFace(out.position, out.scale, face, axis))).toBeCloseTo(0, 6)
  })
})
