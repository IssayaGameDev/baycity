// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { listField } from './listField'

/**
 * The list field (ADR 0182): a row per entry under one header, each edit the whole list, rows added at their
 * defaults, taken out, and an optional colour left to auto.
 */

const ITEM = {
  cap: { kind: 'color', default: '#e8e6e1', label: 'cap' },
  letter: { kind: 'color', default: '', optional: true, label: 'letter' },
  weight: { kind: 'number', default: 1, label: 'weight' },
} as const

const rig = (value: Record<string, unknown>[]) => {
  document.body.replaceChildren()
  const written: Record<string, unknown>[][] = []
  const field = listField({ item: ITEM, value, title: 'key colours', write: (rows, ongoing) => void (ongoing !== true && written.push(rows)), settle: () => {} })
  document.body.append(field.root)
  const rows = (): HTMLElement[] => [...field.root.querySelectorAll<HTMLElement>('.lf-row')]
  return { field, written, rows }
}

describe('a list field', () => {
  it('names the row’s fields once, and draws a row per entry', () => {
    const { field, rows } = rig([{ cap: '#ff0000', letter: '', weight: 2 }, { cap: '#00ff00', letter: '#000000', weight: 1 }])
    expect([...field.root.querySelectorAll('.lf-h')].map((h) => h.textContent)).toEqual(['cap', 'letter', 'weight'])
    expect(rows()).toHaveLength(2)
  })

  it('writes the whole list on an edit, the other rows and fields as they are', () => {
    const { rows, written } = rig([{ cap: '#ff0000', letter: '', weight: 2 }, { cap: '#00ff00', letter: '#000000', weight: 1 }])
    const number = rows()[1]!.querySelector<HTMLInputElement>('.sf-v')!
    number.value = '5'
    number.dispatchEvent(new Event('blur'))
    expect(written.at(-1)).toEqual([{ cap: '#ff0000', letter: '', weight: 2 }, { cap: '#00ff00', letter: '#000000', weight: 5 }])
  })

  it('adds a row at its defaults, and takes one out', () => {
    const { field, rows, written } = rig([{ cap: '#ff0000', letter: '', weight: 2 }])
    field.root.querySelector<HTMLElement>('.lf-add')!.click()
    expect(written.at(-1)).toEqual([{ cap: '#ff0000', letter: '', weight: 2 }, { cap: '#e8e6e1', letter: '', weight: 1 }])
    rows()[0]!.querySelector<HTMLElement>('.lf-x')!.click()
    expect(written.at(-1)).toEqual([{ cap: '#e8e6e1', letter: '', weight: 1 }])
  })

  it('leaves an optional colour to auto, and gives it one when auto is unticked', () => {
    const { rows, written } = rig([{ cap: '#ff0000', letter: '', weight: 1 }])
    const auto = rows()[0]!.querySelector<HTMLInputElement>('.lf-auto input')!
    expect(auto.checked).toBe(true)
    auto.click()
    expect((written.at(-1)![0] as { letter: string }).letter).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('shows a list changed elsewhere', () => {
    const { field, rows } = rig([{ cap: '#ff0000', letter: '', weight: 1 }])
    field.set([{ cap: '#ff0000', letter: '', weight: 1 }, { cap: '#0000ff', letter: '', weight: 1 }])
    expect(rows()).toHaveLength(2)
  })
})
