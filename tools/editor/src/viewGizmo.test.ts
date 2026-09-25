// @vitest-environment happy-dom
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { createViewGizmo, gizmoPointer, orbitAround } from './viewGizmo'

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

/**
 * The gizmo's parts (ADR 0149): which one a press or the pointer is over, from where the camera looks. The
 * picking is a raycast in the gizmo's own little scene, so it runs here without a renderer.
 */
describe('the cones and the cube', () => {
  /** The gizmo square's centre on the 800-wide canvas, and gizmo units to pixels: 64 px per 1.45. */
  const CX = 736
  const CY = 64
  const PX = 64 / 1.45
  const at = (x: number, y: number): PointerEvent => ({ clientX: x, clientY: y }) as PointerEvent

  const rig = (from: THREE.Vector3) => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
    camera.position.copy(from)
    camera.lookAt(0, 0, 0)
    const dom = { clientWidth: WIDTH, clientHeight: 600, getBoundingClientRect: () => RECT } as unknown as HTMLCanvasElement
    const gizmo = createViewGizmo({ camera: () => camera, target: () => new THREE.Vector3(), dom })
    const click = (x: number, y: number): 'centre' | 'axis' | null => {
      gizmo.pointerDown(at(x, y) as PointerEvent)
      return gizmo.pointerUp(at(x, y))
    }
    return { camera, gizmo, click }
  }

  it('toggles the projection from the cube, seen from a corner', () => {
    const { click } = rig(new THREE.Vector3(10, 10, 10))
    expect(click(CX, CY)).toBe('centre')
  })

  it('looks down the cone that was clicked', () => {
    // From the front, +X lies to the right of the cube.
    const { camera, gizmo, click } = rig(new THREE.Vector3(0, 0, 10))
    expect(click(CX + 0.63 * PX, CY)).toBe('axis')
    while (gizmo.update(0.1)) {
      // the snap runs to its end
    }
    expect(camera.position.x).toBeCloseTo(10, 4)
    expect(Math.hypot(camera.position.y, camera.position.z)).toBeCloseTo(0, 4)
  })

  it('answers a little past a cone’s drawn shape', () => {
    // 0.25 gizmo units above +X's axis: outside the cone (0.19 at its widest), inside its reach (0.3).
    const { click } = rig(new THREE.Vector3(0, 0, 10))
    expect(click(CX + 0.63 * PX, CY - 0.25 * PX)).toBe('axis')
  })

  it('lights what the pointer is over, and nothing once it leaves', () => {
    const { gizmo } = rig(new THREE.Vector3(10, 10, 10))
    expect(gizmo.hover(at(CX, CY))).toBe(true)
    expect(gizmo.hover(at(CX - 60, CY + 60)), 'a corner of the square with nothing in it').toBe(false)
    expect(gizmo.hover(at(100, 300)), 'the scene').toBe(false)
    expect(gizmo.hover(at(CX, CY))).toBe(true)
    expect(gizmo.hover(null)).toBe(false)
  })

  it('orbits on a drag, wherever it starts, and then is not a click', () => {
    const { camera, gizmo } = rig(new THREE.Vector3(0, 0, 10))
    expect(gizmo.pointerDown(at(CX, CY))).toBe(true)
    gizmo.pointerMove(at(CX + 50, CY))
    expect(gizmo.pointerUp(at(CX + 50, CY))).toBeNull()
    expect(camera.position.x).not.toBeCloseTo(0, 2)
    expect(camera.position.length()).toBeCloseTo(10, 6)
  })

  it('leaves a press outside its square to the viewport', () => {
    const { gizmo } = rig(new THREE.Vector3(0, 0, 10))
    expect(gizmo.pointerDown(at(100, 300))).toBe(false)
  })
})
