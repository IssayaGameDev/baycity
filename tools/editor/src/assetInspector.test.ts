// @vitest-environment happy-dom
import { buildDatabase, type MaterialAsset } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { createAssetInspector } from './assetInspector'

/**
 * A material stays up across edits (ADR 0157): the panel is not redrawn after each one, so every edit is made
 * from the material as it is now — an edit made from the copy it was drawn with put back every field since.
 */

const M = 'mmmmmmmmmmmmmmmm'
const rig = () => {
  const edits: { label: string; ongoing: boolean }[] = []
  const openers: { name: string; colour: string }[] = []
  const store = new Map<string, MaterialAsset>([[M, { shader: 'standard', params: { color: { kind: 'color', value: '#ff0000' }, tiling: { kind: 'vec2', value: { x: 1, y: 1 } } } }]])
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  const inspector = createAssetInspector(container, {
    db: () => buildDatabase([{ id: M, kind: 'material', path: 'materials/m.mat.json', name: 'm' }]),
    urlOf: (p) => p,
    materialOf: (id) => store.get(id),
    // What the library does: take the edit at once.
    onMaterialChanged: (id, material, label, ongoing = false) => {
      store.set(id, material)
      edits.push({ label, ongoing })
    },
    openers: () => openers,
  })
  inspector.show(M)
  const row = (label: string): HTMLElement => [...container.querySelectorAll<HTMLElement>('.irow')].find((r) => r.querySelector('.irow-l')?.textContent === label)!
  return { store, container, row, inspector, edits, openers }
}

/** Type into a number field (\`controls.ts\`): it is written when the field lets go of the keyboard. */
const typeInto = (input: HTMLInputElement, text: string): void => {
  input.value = text
  input.dispatchEvent(new Event('blur'))
}
/** Drag a number field sideways by \`dx\` pixels. */
const drag = (field: HTMLElement, steps: readonly number[]): void => {
  field.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0 }))
  for (const x of steps) field.dispatchEvent(new PointerEvent('pointermove', { clientX: x }))
  field.dispatchEvent(new PointerEvent('pointerup', { clientX: steps.at(-1) ?? 0 }))
}

describe('editing a material', () => {
  it('keeps an earlier field when a later one is edited', () => {
    const { store, row } = rig()
    const colour = row('colour').querySelector<HTMLInputElement>('input.clr-s')!
    colour.value = '#00ff00'
    colour.dispatchEvent(new Event('input'))
    typeInto(row('roughness').querySelector<HTMLInputElement>('.sf-v')!, '0.3')
    expect(store.get(M)!.params.color).toEqual({ kind: 'color', value: '#00ff00' })
    expect(store.get(M)!.params.roughness).toEqual({ kind: 'number', value: 0.3 })
    expect(row('colour').querySelector('input.clr-s'), 'the field being dragged is still the one on screen').toBe(colour)
  })

  it('shows someone else’s edit in place, but not in the field being worked in (ADR 0159)', () => {
    const { store, row, inspector } = rig()
    const colour = row('colour').querySelector<HTMLInputElement>('input.clr-s')!
    const roughness = row('roughness').querySelector<HTMLElement>('.sf')!
    // A click opens a number for typing: what is being typed is the person's.
    drag(roughness, [])
    const typing = roughness.querySelector<HTMLInputElement>('.sf-v')!
    typing.value = '0.4'
    store.set(M, { shader: 'standard', params: { color: { kind: 'color', value: '#0000ff' }, roughness: { kind: 'number', value: 0.9 } } })
    inspector.refresh(M)
    expect(row('colour').querySelector('input.clr-s'), 'not redrawn').toBe(colour)
    expect(colour.value).toBe('#0000ff')
    expect(row('colour').querySelector<HTMLInputElement>('.clr-v')!.value, 'its code too').toBe('#0000ff')
    expect(typing.value, 'the field in use keeps what is being typed').toBe('0.4')
    store.set(M, { shader: 'unlit', params: {} })
    inspector.refresh(M)
    expect(row('colour')?.querySelector('input.clr-s') ?? null, 'a new shader redraws').not.toBe(colour)
  })

  it('keeps the x of a tiling when its y is edited', () => {
    const { store, row } = rig()
    const [x, y] = [...row('tiling').querySelectorAll<HTMLInputElement>('.sf-v')]
    typeInto(x!, '2')
    typeInto(y!, '3')
    expect(store.get(M)!.params.tiling).toEqual({ kind: 'vec2', value: { x: 2, y: 3 } })
  })

  it('names each edit for the undo history, and a colour drag as one that ends when the picker closes', () => {
    const { row, edits } = rig()
    const colour = row('colour').querySelector<HTMLInputElement>('input.clr-s')!
    colour.focus()
    for (const v of ['#110000', '#220000']) {
      colour.value = v
      colour.dispatchEvent(new Event('input'))
    }
    colour.dispatchEvent(new Event('change'))
    expect(edits, 'each step, the value it settled on, then the end, which writes nothing').toEqual([
      { label: 'm colour', ongoing: true },
      { label: 'm colour', ongoing: true },
      { label: 'm colour', ongoing: false },
      { label: 'm colour', ongoing: false },
    ])
    expect(document.activeElement, 'the keyboard goes back to the editor, for Ctrl+Z').not.toBe(colour)
  })

  it('makes a number drag one entry, and letting go writes nothing more', () => {
    const { store, row, edits } = rig()
    const before = (store.get(M)!.params.roughness as { value: number } | undefined)?.value ?? 0.5
    drag(row('roughness').querySelector<HTMLElement>('.sf')!, [4, 5, 6])
    const ongoing = edits.map((e) => e.ongoing)
    expect(ongoing.slice(0, -2).every((o) => o), 'each step is ongoing').toBe(true)
    expect(ongoing.slice(-2), 'then the value it let go on, and the end').toEqual([false, false])
    expect(ongoing.length).toBeGreaterThan(2)
    expect(new Set(edits.map((e) => e.label))).toEqual(new Set(['m roughness']))
    expect((store.get(M)!.params.roughness as { value: number }).value).not.toBe(before)
  })
})

describe('who else has it open (ADR 0159)', () => {
  it('shows their icons in their colours, and follows them without redrawing the fields', () => {
    const { container, row, inspector, openers } = rig()
    const icons = (): string[] => [...container.querySelectorAll<HTMLElement>('.a-openers .pp')].map((i) => `${i.textContent} ${i.style.getPropertyValue('--pc')} ${i.title}`)
    expect(icons()).toEqual([])
    const colour = row('colour').querySelector('input.clr-s')
    openers.push({ name: 'Ana Lima', colour: '#ff0000' })
    inspector.openersChanged()
    expect(icons()).toEqual(['AL #ff0000 Ana Lima has this open'])
    expect(row('colour').querySelector('input.clr-s'), 'the fields stay').toBe(colour)
    openers.length = 0
    inspector.openersChanged()
    expect(icons()).toEqual([])
  })
})
