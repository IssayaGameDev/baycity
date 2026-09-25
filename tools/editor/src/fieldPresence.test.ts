// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fieldRow } from './controls'
import { createFieldPresence, spotOf, type Ring, type Spot } from './fieldPresence'

/**
 * Who is in which Inspector field (ADR 0160): a line is named by its card and its label, this tab's moves are
 * reported — leaving a moment late — and everyone else's are ringed, again after the panel is rebuilt.
 */

const input = (): HTMLInputElement => document.createElement('input')

/** A panel of two cards, as the object Inspector draws them: a Transform and a Collider, a line each or two. */
const panel = (): HTMLElement => {
  const container = document.createElement('div')
  const card = (name: string, ...lines: HTMLElement[]): HTMLElement => {
    const c = document.createElement('div')
    c.dataset.card = name
    c.append(...lines)
    return c
  }
  container.append(card('@transform', fieldRow('position', input()), fieldRow('scale', input())), card('Collider#0', fieldRow('position', input())))
  document.body.replaceChildren(container)
  return container
}
const lineOf = (container: HTMLElement, card: string, field: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-card="${card}"] [data-field="${field}"]`)!

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('this tab, in a field', () => {
  it('names a line by its card and its label, the same line in another card apart', () => {
    const c = panel()
    expect(spotOf(lineOf(c, '@transform', 'position').querySelector('input'), c)).toEqual({ card: '@transform', field: 'position' })
    expect(spotOf(lineOf(c, 'Collider#0', 'position').querySelector('input'), c)).toEqual({ card: 'Collider#0', field: 'position' })
    expect(spotOf(c, c), 'between lines is no line').toBeNull()
  })

  it('reports going in at once, moving across as one move, and leaving a moment late', () => {
    const c = panel()
    const said: (Spot | null)[] = []
    createFieldPresence(c, { report: (s) => said.push(s), rings: () => [] })
    const position = lineOf(c, '@transform', 'position').querySelector('input')!
    const scale = lineOf(c, '@transform', 'scale').querySelector('input')!
    position.focus()
    expect(said).toEqual([{ card: '@transform', field: 'position' }])
    scale.focus()
    expect(said.at(-1), 'the next line, with no "out" between').toEqual({ card: '@transform', field: 'scale' })
    scale.blur()
    expect(said, 'not yet').toHaveLength(2)
    vi.advanceTimersByTime(200)
    expect(said.at(-1)).toBeNull()
  })

  it('counts a press as being in it: a number being dragged takes no focus', () => {
    const c = panel()
    const said: (Spot | null)[] = []
    createFieldPresence(c, { report: (s) => said.push(s), rings: () => [] })
    lineOf(c, '@transform', 'scale').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(said).toEqual([{ card: '@transform', field: 'scale' }])
    window.dispatchEvent(new PointerEvent('pointerup'))
    vi.advanceTimersByTime(200)
    expect(said.at(-1)).toBeNull()
  })
})

describe('the others, as rings', () => {
  it('rings their line in their colour with their names, and again once the panel is rebuilt', async () => {
    const c = panel()
    const rings: Ring[] = [
      { card: '@transform', field: 'position', name: 'Ana', colour: '#ff0000' },
      { card: '@transform', field: 'position', name: 'Bob', colour: '#00ff00' },
    ]
    const fields = createFieldPresence(c, { report: () => undefined, rings: () => rings })
    fields.repaint()
    const line = lineOf(c, '@transform', 'position')
    expect(line.classList.contains('peer-in')).toBe(true)
    expect(line.style.getPropertyValue('--peer')).toBe('#ff0000')
    expect(line.title).toBe('Ana and Bob are in this field')
    expect(lineOf(c, 'Collider#0', 'position').classList.contains('peer-in'), 'the same label in another card').toBe(false)

    // A rebuild: the lines are new, and ringed as they arrive.
    const fresh = panel()
    c.replaceChildren(...fresh.childNodes)
    document.body.replaceChildren(c)
    await vi.runAllTimersAsync()
    expect(lineOf(c, '@transform', 'position').classList.contains('peer-in')).toBe(true)

    rings.length = 0
    fields.repaint()
    expect(lineOf(c, '@transform', 'position').classList.contains('peer-in'), 'gone when they leave').toBe(false)
    expect(lineOf(c, '@transform', 'position').hasAttribute('title')).toBe(false)
  })
})
