import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { gizmoPointer, orbitAround } from './viewGizmo'

/** A 800×600 canvas at the page's top-left, with a 128 px gizmo in its top-right corner. */
const RECT = { left: 0, top: 0 }
const WIDTH = 800
const DIM = 128

describe('gizmoPointer (which clicks the gizmo takes)', () => {
  it('maps the corner square to -1..1, y up', () => {
    // Centre of the square: 800-128=672 is its left edge, so 672+64 = 736.
    expect(gizmoPointer(RECT, 736, 64, WIDTH, DIM)).toEqual({ x: 0, y: 0 })
    // Top-left of the square is (-1, +1) — y is flipped, as every raycast expects.
    expect(gizmoPointer(RECT, 672, 0, WIDTH, DIM)).toEqual({ x: -1, y: 1 })
    expect(gizmoPointer(RECT, 800, 128, WIDTH, DIM)).toEqual({ x: 1, y: -1 })
  })

  it('misses everywhere else, so the rest of the viewport still gets its clicks', () => {
    expect(gizmoPointer(RECT, 671, 64, WIDTH, DIM), 'just left of the square').toBeNull()
    expect(gizmoPointer(RECT, 736, 129, WIDTH, DIM), 'just below it').toBeNull()
    expect(gizmoPointer(RECT, 100, 300, WIDTH, DIM), 'the middle of the scene').toBeNull()
  })

  it('follows the canvas, not the window', () => {
    // The same click is inside the square on a narrow canvas and outside it on a wide one, and an offset
    // canvas (a panel layout, which the editor has) shifts it again.
    expect(gizmoPointer(RECT, 300, 64, 400, DIM)).not.toBeNull()
    expect(gizmoPointer(RECT, 300, 64, 1600, DIM)).toBeNull()
    expect(gizmoPointer({ left: 220, top: 40 }, 956, 104, WIDTH, DIM)).toEqual({ x: 0, y: 0 })
  })
})

describe('orbitAround (dragging the gizmo turns the view)', () => {
  const target = new THREE.Vector3(0, 0, 0)

  it('keeps the distance and turns by the drag', () => {
    const start = new THREE.Vector3(0, 0, 10)
    const moved = orbitAround(start, target, 100, 0, 0.01)
    expect(moved.length()).toBeCloseTo(10, 6)
    // 100 px at 0.01 rad/px is one radian about the vertical axis, away from the drag.
    expect(moved.x).toBeCloseTo(-10 * Math.sin(1), 5)
    expect(moved.z).toBeCloseTo(10 * Math.cos(1), 5)
  })

  it('never reaches the pole, where the azimuth stops meaning anything', () => {
    const start = new THREE.Vector3(0, 0, 10)
    // Far more vertical drag than it takes to get there, in both directions.
    for (const dy of [-10_000, 10_000]) {
      const moved = orbitAround(start, target, 0, dy, 0.01)
      expect(Math.abs(moved.y)).toBeLessThan(10)
      expect(moved.length()).toBeCloseTo(10, 6)
    }
  })

  it('orbits the target, not the origin', () => {
    const target2 = new THREE.Vector3(50, 3, -20)
    const start = new THREE.Vector3(50, 3, -10)
    const moved = orbitAround(start, target2, 100, 0, 0.01)
    expect(moved.distanceTo(target2)).toBeCloseTo(10, 6)
  })

  it('leaves the camera alone for a drag of nothing', () => {
    const start = new THREE.Vector3(3, 4, 5)
    const moved = orbitAround(start, target, 0, 0, 0.01)
    expect(moved.x).toBeCloseTo(3, 6)
    expect(moved.y).toBeCloseTo(4, 6)
    expect(moved.z).toBeCloseTo(5, 6)
  })
})
