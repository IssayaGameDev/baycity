import { describe, expect, it } from 'vitest'

import { boundState, dragSpeed, peersOf, sameValue } from './inspector'

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
 * A number field's drag speed must not constrain what can be typed (ADR 0113).
 *
 * Tweakpane's `step` does both jobs, and its constraint is anchored to the value the field was built with:
 * `createStepConstraint(params, initialValue)` → `new StepConstraint(step, initialValue)`, whose `constrain`
 * is `o + round((v - o) / step) * step` with `o = initialValue % step`. A scale field built showing 32.98
 * with `step: 0.05` therefore cannot be set to 33 at all.
 *
 * The arithmetic is reproduced here rather than imported so this test says *why* `step` is banned, and keeps
 * saying it if the library changes.
 */
describe('dragSpeed', () => {
  it('asks for a pointer increment and no step at all', () => {
    expect(dragSpeed(0.05)).toEqual({ pointerScale: 0.05 })
    expect(Object.keys(dragSpeed(0.05))).not.toContain('step')
  })

  it('documents the trap it exists to avoid', () => {
    // Tweakpane's StepConstraint, verbatim.
    const constrain = (value: number, step: number, origin: number): number => {
      const o = origin % step
      return o + Math.round((value - o) / step) * step
    }
    // A field built showing 32.98, step 0.05: Kodjo's exact three attempts.
    const at = (v: number): number => Number(constrain(v, 0.05, 32.98).toFixed(4))
    expect(at(32.99), 'typing 32.99 gives back 32.98').toBe(32.98)
    expect(at(33), 'typing 33 gives back 32.98 — the value is unreachable').toBe(32.98)
    expect(at(33.01), 'typing 33.01 jumps to 33.03').toBe(33.03)
    // And with no step there is nothing to snap to, which is what `dragSpeed` guarantees.
  })
})
