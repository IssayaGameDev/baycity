import { describe, expect, it } from 'vitest'

import { boundState } from './inspector'

/**
 * What the Inspector's widgets are bound to must share nothing with the document (ADR 0101).
 *
 * The bug: a spread is shallow, so the bound `shape` was the very same object as the component's — and on an
 * inherited component that object is the **prefab's own**. Tweakpane writes into a bound object rather than
 * replacing it (`writePoint3d` → `writeProperty` → `valueObj[name] = value`), so dragging half extents on one
 * placement edited the prefab definition in memory, every frame, before any op existed.
 */
describe('boundState', () => {
  it('layers the authored params over the declared defaults', () => {
    const state = boundState({ power: 26, mode: 'soft' }, { power: 40 })
    expect(state).toEqual({ power: 40, mode: 'soft' })
  })

  it('shares no nested object with the params it was given', () => {
    const params = { shape: { kind: 'box', halfExtents: { x: 800, y: 0.5, z: 80 } }, center: { x: 0, y: 0, z: 0 } }
    const state = boundState({}, params)

    // What Tweakpane does to a bound point: writes x/y/z into the object it reads, in place.
    const bound = state.shape as { halfExtents: { x: number; y: number; z: number } }
    bound.halfExtents.x = 8000
    bound.halfExtents.y = 50
    ;(state.center as { y: number }).y = 9

    expect(params.shape.halfExtents, 'the prefab keeps its own size').toEqual({ x: 800, y: 0.5, z: 80 })
    expect(params.center.y).toBe(0)
  })

  it('shares no nested object with the defaults either', () => {
    // A registry's defaults are one object handed to every instance, so aliasing them would leak a drag on
    // one node into every other node of that type.
    const defaults = { shape: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } }
    const state = boundState(defaults, {})
    ;(state.shape as { halfExtents: { x: number } }).halfExtents.x = 99
    expect(defaults.shape.halfExtents.x).toBe(0.5)
  })

  it('copies an array param rather than aliasing it', () => {
    const params = { points: [{ t: 0 }, { t: 1 }] }
    const state = boundState({}, params)
    ;(state.points as { t: number }[])[0]!.t = 5
    expect(params.points[0]!.t).toBe(0)
  })
})
