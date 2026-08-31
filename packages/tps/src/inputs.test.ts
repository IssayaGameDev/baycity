// @vitest-environment happy-dom
import type { OrbitCamera } from '@mp/camera'
import { beforeEach, describe, expect, it } from 'vitest'

import { createInputs, type Inputs } from './inputs'

/**
 * Input teardown (ADR 0065).
 *
 * `createInputs` takes seven listeners on `window`, `document` and the canvas, and until ADR 0065 none of
 * them could be released. A leaked listener breaks nothing you can see — it just keeps answering for a canvas
 * that is gone, which is exactly the failure a person play-testing cannot spot.
 *
 * Needs a DOM, hence the environment docblock rather than a suite-wide setting: the other 78 test files run
 * in Node and are faster for it.
 */

/** Only the four members `createInputs` actually calls, recording what it was told. */
const fakeCamera = (): OrbitCamera & { looks: [number, number][]; zooms: number[] } => {
  const looks: [number, number][] = []
  const zooms: number[] = []
  return {
    looks,
    zooms,
    yaw: () => 0,
    lookMouse: (dx: number, dy: number) => {
      looks.push([dx, dy])
    },
    zoomNotch: (dir: number) => {
      zooms.push(dir)
    },
  } as unknown as OrbitCamera & { looks: [number, number][]; zooms: number[] }
}

/**
 * A canvas that reports itself as holding pointer lock.
 *
 * Every mouse and wheel handler is gated on `document.pointerLockElement === canvas`, and happy-dom has no
 * pointer-lock implementation — without this the handlers all return early and the test would pass whether
 * they were removed or not.
 */
const lockedCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true })
  canvas.requestPointerLock = (): Promise<void> => Promise.resolve()
  return canvas
}

const start = (canvas: HTMLCanvasElement, camera: OrbitCamera): Inputs =>
  createInputs({ canvas, camera, isDead: () => false, onRespawn: () => {} })

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('disposing the inputs', () => {
  it('stops recording keys', () => {
    const inputs = start(lockedCanvas(), fakeCamera())
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }))
    expect(inputs.keys.has('KeyW')).toBe(true)

    inputs.dispose()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))

    // Neither the new press, nor the one held when it was torn down — a key that can never be released now
    // the `keyup` listener is gone would read as held for ever.
    expect(inputs.keys.has('KeyA')).toBe(false)
    expect(inputs.keys.has('KeyW')).toBe(false)
  })

  it('stops steering the camera', () => {
    const camera = fakeCamera()
    const inputs = start(lockedCanvas(), camera)
    window.dispatchEvent(new MouseEvent('mousemove'))
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }))
    expect(camera.looks).toHaveLength(1)
    expect(camera.zooms).toEqual([1])

    inputs.dispose()
    window.dispatchEvent(new MouseEvent('mousemove'))
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }))

    expect(camera.looks).toHaveLength(1)
    expect(camera.zooms).toEqual([1])
  })

  /**
   * The point of the whole thing. Two clients on one page is what a game-to-game swap looks like, and before
   * this the first one's handlers were still moving the first one's camera for ever.
   */
  it('leaves a second set of inputs working, and the first one deaf', () => {
    const firstInputs = start(lockedCanvas(), fakeCamera())
    document.body.innerHTML = ''

    const second = fakeCamera()
    const secondInputs = start(lockedCanvas(), second)
    firstInputs.dispose()

    window.dispatchEvent(new MouseEvent('mousemove'))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))

    // The new one hears everything.
    expect(second.looks).toHaveLength(1)
    expect(secondInputs.takeJump()).toBe(true)
    // The old one hears nothing. Asserted on the keyboard rather than the camera, because the mouse and wheel
    // handlers are gated on `pointerLockElement` and a stale one fails that check anyway — so a camera
    // assertion here would pass whether the listener was removed or not. The keyboard has no such gate, which
    // makes it the only honest witness that the listener is really gone.
    expect(firstInputs.keys.has('Space')).toBe(false)
    expect(firstInputs.takeJump()).toBe(false)
  })

  it('is safe to call twice', () => {
    const inputs = start(lockedCanvas(), fakeCamera())
    inputs.dispose()
    expect(() => inputs.dispose()).not.toThrow()
  })
})
