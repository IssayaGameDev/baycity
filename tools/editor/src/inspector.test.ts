import { describe, expect, it } from 'vitest'

import { numberScrub } from './controls'
import { boundState, peersOf, sameValue } from './inspector'

/**
 * What the Inspector's fields are built from must share nothing with the document (ADR 0101).
 *
 * The bug: a spread is shallow, so the bound `shape` was the very same object as the component's — and on an
 * inherited component that object is the **prefab's own**. Tweakpane wrote into a bound object rather than
 * replacing it, so dragging half extents on one placement edited the prefab definition in memory. The fields
 * now update this copy as they write, which must still not be the document's object.
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

/**
 * Pairing one component up across a multi-selection (ADR 0112).
 *
 * Ids cannot do it — they are minted per component, so two cubes' colliders are never the same id — and a
 * node may carry two of the same type, so the type alone cannot either. Type **and ordinal**.
 */
describe('peersOf', () => {
  interface FakeView {
    id: string
    type: string
    params: Record<string, unknown>
  }
  /** Just enough of `Doc` for `peersOf`: the components of each index. */
  const fakeDoc = (byIndex: Record<number, FakeView[]>) =>
    ({ components: (i: number) => byIndex[i] ?? [] }) as unknown as Parameters<typeof peersOf>[0]

  const view = (id: string, type: string, params: Record<string, unknown> = {}): FakeView => ({ id, type, params })

  it('matches the same type on every node, keeping each node’s own id', () => {
    const doc = fakeDoc({ 0: [view('a1', 'Collider')], 1: [view('b1', 'Collider')] })
    const peers = peersOf(doc, [0, 1], 0, view('a1', 'Collider') as never)
    expect(peers).toEqual([
      { at: 0, componentId: 'a1', params: {} },
      { at: 1, componentId: 'b1', params: {} },
    ])
  })

  it('matches by ordinal when a node carries two of the type', () => {
    const doc = fakeDoc({
      0: [view('a1', 'Collider'), view('a2', 'Collider')],
      1: [view('b1', 'Collider'), view('b2', 'Collider')],
    })
    // The second Collider on the primary pairs with the second on the other, not the first.
    expect(peersOf(doc, [0, 1], 0, view('a2', 'Collider') as never)?.map((p) => p.componentId)).toEqual(['a2', 'b2'])
  })

  it('counts only its own type when working out the ordinal', () => {
    const doc = fakeDoc({
      0: [view('a1', 'Renderer'), view('a2', 'Collider')],
      1: [view('b1', 'Collider'), view('b2', 'Renderer')],
    })
    // The Collider is second on node 0 and first on node 1, and they are still ordinal 0 of their type.
    expect(peersOf(doc, [0, 1], 0, view('a2', 'Collider') as never)?.map((p) => p.componentId)).toEqual(['a2', 'b1'])
  })

  it('gives null when one node has not got it — the section is then hidden', () => {
    const doc = fakeDoc({ 0: [view('a1', 'Collider')], 1: [view('b1', 'Renderer')] })
    expect(peersOf(doc, [0, 1], 0, view('a1', 'Collider') as never)).toBeNull()
  })

  it('gives null when one node has fewer of the type than the ordinal needs', () => {
    const doc = fakeDoc({ 0: [view('a1', 'Collider'), view('a2', 'Collider')], 1: [view('b1', 'Collider')] })
    expect(peersOf(doc, [0, 1], 0, view('a2', 'Collider') as never)).toBeNull()
  })

  it('gives null when the view is not on the primary at all', () => {
    const doc = fakeDoc({ 0: [view('a1', 'Collider')] })
    expect(peersOf(doc, [0], 0, view('ghost', 'Collider') as never)).toBeNull()
  })
})

describe('sameValue', () => {
  it('compares vec3s and shapes by content, not identity', () => {
    expect(sameValue({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(true)
    expect(sameValue({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 })).toBe(false)
    expect(sameValue({ kind: 'ball', radius: 1 }, { kind: 'ball', radius: 1 })).toBe(true)
  })

  it('treats a missing value and an explicit null as the same', () => {
    // A node with nothing written falls back to the declared default, so both sides arrive as the same value.
    expect(sameValue(undefined, null)).toBe(true)
  })

  it('compares scalars', () => {
    expect(sameValue(2, 2)).toBe(true)
    expect(sameValue('a', 'b')).toBe(false)
    expect(sameValue(true, false)).toBe(false)
  })
})

/**
 * How a declared number drags (ADR 0113, ADR 0152). The step is the drag's: a pixel, landing on its multiples.
 * What is typed is never snapped to it — `inspectorPanel.test.ts` types 33 into a field built at 32.98.
 */
describe('numberScrub', () => {
  it('drags a step a pixel, landing on the step, inside the bounds', () => {
    expect(numberScrub({ step: 0.05, min: 0.01 })).toEqual({ perPixel: 0.05, grain: 0.05, min: 0.01 })
    expect(numberScrub({ step: 1, min: 1, max: 89 })).toEqual({ perPixel: 1, grain: 1, min: 1, max: 89 })
  })

  it('crosses a bounded range in 200 px when there is no step, landing on the decade under a pixel', () => {
    expect(numberScrub({ min: 0, max: 0.4 })).toEqual({ perPixel: 0.002, grain: 0.001, min: 0, max: 0.4 })
  })

  it('drags a tenth a pixel with neither', () => {
    expect(numberScrub({})).toEqual({ perPixel: 0.1, grain: 0.1 })
  })
})
