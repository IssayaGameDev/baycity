// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { refField, refTargetOf, type RefDrag, type RefFieldOptions } from './refField'

/**
 * The reference field (ADR 0176): what it points at, ✕, a searchable picker, a ping, and a drop — a Hierarchy row
 * through `refTargetOf` (the Hierarchy's drag asks the field under the pointer), a Project tile through the
 * browser's drag events.
 */

const rig = (over: Partial<RefFieldOptions> = {}) => {
  document.body.replaceChildren()
  const calls: string[] = []
  let dragged: readonly string[] = []
  const field = refField({
    shown: { label: 'Zone', icon: 'object' },
    none: 'None (object)',
    choices: () => [
      { value: 'a', label: 'Zone', icon: 'object' },
      { value: 'b', label: 'Door', icon: 'object' },
    ],
    pick: (v) => calls.push(`pick ${v ?? 'none'}`),
    ping: () => calls.push('ping'),
    refuse: (d: RefDrag) => (d.kind === 'node' ? (d.index === 9 ? 'out of reach' : null) : d.id === 'tex' ? null : 'this takes a texture'),
    take: (d: RefDrag) => calls.push(`take ${d.kind === 'node' ? d.index : d.id}`),
    draggedAssets: () => dragged,
    ...over,
  })
  document.body.append(field.root)
  const $ = (sel: string): HTMLElement => document.querySelector<HTMLElement>(sel)!
  const text = (): string => $('.rf-name').textContent ?? ''
  return { field, calls, $, text, drag: (ids: readonly string[]) => void (dragged = ids) }
}

const dragEvent = (type: string): Event => new Event(type, { bubbles: true, cancelable: true })

describe('the reference field', () => {
  it('shows what it points at, none, or a selection that differs, and clears with ✕', () => {
    const { field, calls, $, text } = rig()
    expect(text()).toBe('Zone')
    $('.rf-x').click()
    expect(calls).toEqual(['pick none'])
    field.set(null)
    expect(text()).toBe('None (object)')
    expect($('.rf-x').hidden).toBe(true)
    field.set('mixed')
    expect(text()).toBe('—')
  })

  it('pings what it points at on a press, and nothing when it points at nothing', () => {
    const { field, calls, $ } = rig()
    $('.rf-name').click()
    field.set(null)
    $('.rf-name').click()
    expect(calls).toEqual(['ping'])
  })

  it('picks from a searchable list, None first, Enter taking the first match', () => {
    const { calls, $ } = rig()
    $('.rf-pick').click()
    const rows = (): string[] => [...document.querySelectorAll('.pop-ref .rf-row')].map((r) => r.textContent ?? '')
    expect(rows()).toEqual(['None', 'Zone', 'Door'])
    const search = $('.rf-search') as HTMLInputElement
    search.value = 'do'
    search.dispatchEvent(new Event('input'))
    expect(rows()).toEqual(['Door'])
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(calls).toEqual(['pick b'])
    expect(document.querySelector('.pop-ref'), 'closed').toBeNull()
  })

  it('lights for a row it takes and takes it; greys with why for one it does not, and takes nothing', () => {
    const { field, calls, $, text } = rig()
    const target = refTargetOf(field.root)!
    expect(target.offer({ kind: 'node', index: 2 })).toBe(true)
    expect(field.root.classList.contains('rf-ok')).toBe(true)
    target.take({ kind: 'node', index: 2 })
    expect(target.offer({ kind: 'node', index: 9 })).toBe(false)
    expect(field.root.classList.contains('rf-no')).toBe(true)
    expect(text()).toBe('out of reach')
    target.leave()
    expect(text(), 'back to what it points at').toBe('Zone')
    target.take({ kind: 'node', index: 9 })
    expect(calls).toEqual(['take 2'])
    expect($('.rf').className).toBe('rf')
  })

  it('takes one Project tile dropped on it, refuses a wrong one and several, and ignores other drags', () => {
    const { field, calls, drag, text } = rig()
    const over = (): boolean => {
      const e = dragEvent('dragover')
      field.root.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(over(), 'no tile being dragged: not ours').toBe(false)
    drag(['mat'])
    expect(over()).toBe(false)
    expect(text()).toBe('this takes a texture')
    drag(['tex', 'mat'])
    expect(over()).toBe(false)
    expect(text()).toBe('one at a time')
    drag(['tex'])
    expect(over(), 'may drop').toBe(true)
    field.root.dispatchEvent(dragEvent('drop'))
    expect(calls).toEqual(['take tex'])
    expect(text()).toBe('Zone')
  })
})
