// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { refField, refTargetOf, type RefDrag, type RefFieldOptions } from './refField'

/**
 * The reference field (ADR 0176, ADR 0177), Unity's object field: what it points at, a ping on a press and an open
 * on a double-click, Delete to clear, a searchable picker, and a drop — a Hierarchy row or a card through
 * `refTargetOf` (their drags ask the field under the pointer), a Project tile through the browser's drag events.
 */

const named = (d: RefDrag): string => (d.kind === 'asset' ? d.id : d.kind === 'node' ? String(d.index) : `${d.index}/${d.component}`)

const rig = (over: Partial<RefFieldOptions> = {}) => {
  document.body.replaceChildren()
  const calls: string[] = []
  let dragged: readonly string[] = []
  const field = refField({
    shown: { label: 'Zone', icon: 'object' },
    none: 'None (Object)',
    choices: () => [
      { value: 'a', label: 'Zone', icon: 'object' },
      { value: 'b', label: 'Door', icon: 'object' },
    ],
    pick: (v) => calls.push(`pick ${v ?? 'none'}`),
    ping: () => calls.push('ping'),
    open: () => calls.push('open'),
    refuse: (d) => (d.kind === 'node' && d.index === 9 ? 'out of reach' : d.kind === 'asset' && d.id !== 'tex' ? 'this takes a texture' : null),
    take: (d) => calls.push(`take ${named(d)}`),
    draggedAssets: () => dragged,
    ...over,
  })
  document.body.append(field.root)
  const $ = (sel: string): HTMLElement => document.querySelector<HTMLElement>(sel)!
  const text = (): string => $('.rf-name').textContent ?? ''
  return { field, calls, $, text, drag: (ids: readonly string[]) => void (dragged = ids) }
}

const dragEvent = (type: string): Event => new Event(type, { bubbles: true, cancelable: true })
const key = (at: HTMLElement, k: string): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  at.dispatchEvent(e)
  return e
}

describe('the reference field', () => {
  it('shows what it points at, none, or a selection that differs, with no clear button', () => {
    const { field, text, $ } = rig()
    expect(text()).toBe('Zone')
    expect(document.querySelector('.rf-x')).toBeNull()
    field.set(null)
    expect(text()).toBe('None (Object)')
    field.set('mixed')
    expect(text()).toBe('—')
    expect($('.rf-pick')).not.toBeNull()
  })

  // Unity's way: Delete on the focused field clears it, and the editor's own Delete — which deletes objects — never hears it.
  it('clears on Delete or Backspace, and keeps the key from the editor', () => {
    const { calls, $ } = rig()
    let reached = 0
    const behind = (): void => void reached++
    window.addEventListener('keydown', behind)
    key($('.rf-name'), 'Delete')
    key($('.rf-pick'), 'Backspace')
    window.removeEventListener('keydown', behind)
    expect(calls).toEqual(['pick none', 'pick none'])
    expect(reached, 'the editor never saw it').toBe(0)
  })

  it('pings on a press and opens on a double-click, and does neither when it points at nothing', () => {
    const { field, calls, $ } = rig()
    $('.rf-name').click()
    $('.rf-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    field.set(null)
    $('.rf-name').click()
    $('.rf-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(calls).toEqual(['ping', 'open'])
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

  it('lights for a row or a card it takes and takes it; greys with why for one it does not, and takes nothing', () => {
    const { field, calls, $, text } = rig()
    const target = refTargetOf(field.root)!
    expect(target.offer({ kind: 'node', index: 2 })).toBe(true)
    expect(field.root.classList.contains('rf-ok')).toBe(true)
    target.take({ kind: 'node', index: 2 })
    target.take({ kind: 'component', index: 2, component: 'col' })
    expect(target.offer({ kind: 'node', index: 9 })).toBe(false)
    expect(field.root.classList.contains('rf-no')).toBe(true)
    expect(text()).toBe('out of reach')
    target.leave()
    expect(text(), 'back to what it points at').toBe('Zone')
    target.take({ kind: 'node', index: 9 })
    expect(calls).toEqual(['take 2', 'take 2/col'])
    expect($('.rf').className).toBe('rf')
  })

  it('takes a Project tile dropped on it — the first of several — refuses a wrong one, and ignores other drags', () => {
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
    expect(over(), 'the first of several').toBe(true)
    field.root.dispatchEvent(dragEvent('drop'))
    expect(calls).toEqual(['take tex'])
    expect(text()).toBe('Zone')
  })
})
