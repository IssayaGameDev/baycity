// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { pressCardToDrag } from './cardDrag'
import type { OutsideTarget } from './hierarchyDrag'

/**
 * A card dragged by its header onto a reference field (ADR 0177): Unity's dragged component header. Over the field
 * it is a link, not a reorder; a card that cannot move — a prefab's component — still links.
 */

const pointer = (type: string, x: number, y: number): PointerEvent => new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })

const cards = (movable: boolean) => {
  document.body.replaceChildren()
  const list = document.createElement('div')
  const made = [0, 1].map((i) => {
    const c = document.createElement('div')
    c.className = `isec${movable ? ' movable' : ''}`
    c.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 80, left: 0, right: 280, width: 280, height: 80, x: 0, y: i * 100, toJSON: () => ({}) })
    list.append(c)
    return c
  })
  document.body.append(list)
  const calls: string[] = []
  const target: OutsideTarget = {
    key: 'field',
    offer: () => {
      calls.push('offer')
      return true
    },
    leave: () => void calls.push('leave'),
    take: () => void calls.push('take'),
  }
  const press = (card: HTMLElement): void =>
    pressCardToDrag(pointer('pointerdown', 10, 10), card, {
      ...(movable ? { drop: (from: number, to: number) => void calls.push(`move ${from} ${to}`) } : {}),
      label: { icon: 'component', text: 'zone (Collider)' },
      outside: (x) => (x > 500 ? target : null),
    })
  return { made, calls, press }
}

describe('a card dragged onto a reference field', () => {
  it('is taken there, and moves nothing', () => {
    const { made, calls, press } = cards(true)
    press(made[0]!)
    window.dispatchEvent(pointer('pointermove', 600, 150))
    window.dispatchEvent(pointer('pointerup', 600, 150))
    expect(calls).toEqual(['offer', 'take'])
  })

  it('still reorders over the cards', () => {
    const { made, calls, press } = cards(true)
    press(made[0]!)
    window.dispatchEvent(pointer('pointermove', 10, 150))
    window.dispatchEvent(pointer('pointerup', 10, 150))
    expect(calls).toEqual(['move 0 1'])
  })

  it('links when it cannot move', () => {
    const { made, calls, press } = cards(false)
    press(made[1]!)
    window.dispatchEvent(pointer('pointermove', 600, 10))
    window.dispatchEvent(pointer('pointerup', 600, 10))
    expect(calls).toEqual(['offer', 'take'])
  })
})
