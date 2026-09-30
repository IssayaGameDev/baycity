// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { pressRowToDrag, type OutsideTarget } from './hierarchyDrag'

/**
 * A row dragged off the list (ADR 0176): the drag asks what is under the pointer — an Inspector reference field —
 * which lights or greys itself once, and takes the row on the drop instead of a reparent.
 */

const frame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()))
const pointer = (type: string, x: number): void => void window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 10, button: 0 }))

const drag = (ok: boolean) => {
  document.body.replaceChildren()
  const list = document.createElement('div')
  document.body.append(list)
  const calls: string[] = []
  const target: OutsideTarget = {
    key: 'field',
    offer: () => {
      calls.push('offer')
      return ok
    },
    leave: () => void calls.push('leave'),
    take: () => void calls.push('take'),
  }
  pressRowToDrag(new PointerEvent('pointerdown', { clientX: 0, clientY: 10, button: 0 }), {
    list,
    drawn: () => [],
    carried: [3],
    label: { icon: 'object', text: 'Zone', className: '' },
    canReparent: () => true,
    expand: () => {},
    drop: (parent, at) => void calls.push(`reparent ${String(parent)} ${at}`),
    outside: (x) => (x > 50 ? target : null),
  })
  return calls
}

describe('a row dragged off the Hierarchy', () => {
  it('offers itself to the field under the pointer once, and is taken there on the drop', async () => {
    const calls = drag(true)
    pointer('pointermove', 100)
    await frame()
    await frame()
    pointer('pointerup', 100)
    expect(calls).toEqual(['offer', 'take'])
  })

  it('is not taken where the field refuses it, and the field is let go of', async () => {
    const calls = drag(false)
    pointer('pointermove', 100)
    await frame()
    pointer('pointerup', 100)
    expect(calls).toEqual(['offer', 'leave'])
  })

  it('lets go of the field when the pointer moves off it', async () => {
    const calls = drag(true)
    pointer('pointermove', 100)
    await frame()
    pointer('pointermove', 20)
    await frame()
    pointer('pointerup', 20)
    expect(calls).toEqual(['offer', 'leave'])
  })
})
