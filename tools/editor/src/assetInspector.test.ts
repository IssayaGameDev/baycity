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
  const store = new Map<string, MaterialAsset>([[M, { shader: 'standard', params: { color: { kind: 'color', value: '#ff0000' }, tiling: { kind: 'vec2', value: { x: 1, y: 1 } } } }]])
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  const inspector = createAssetInspector(container, {
    db: () => buildDatabase([{ id: M, kind: 'material', path: 'materials/m.mat.json', name: 'm' }]),
    urlOf: (p) => p,
    materialOf: (id) => store.get(id),
    // What the library does: take the edit at once.
    onMaterialChanged: (id, material) => void store.set(id, material),
  })
  inspector.show(M)
  const row = (label: string): HTMLElement => [...container.querySelectorAll<HTMLElement>('.a-row')].find((r) => r.querySelector('.a-label')?.textContent === label)!
  return { store, container, row }
}

describe('editing a material', () => {
  it('keeps an earlier field when a later one is edited', () => {
    const { store, row } = rig()
    const colour = row('colour').querySelector<HTMLInputElement>('input')!
    colour.value = '#00ff00'
    colour.dispatchEvent(new Event('input'))
    const roughness = row('roughness').querySelector<HTMLInputElement>('input')!
    roughness.value = '0.3'
    roughness.dispatchEvent(new Event('change'))
    expect(store.get(M)!.params.color).toEqual({ kind: 'color', value: '#00ff00' })
    expect(store.get(M)!.params.roughness).toEqual({ kind: 'number', value: 0.3 })
    expect(row('colour').querySelector('input'), 'the field being dragged is still the one on screen').toBe(colour)
  })

  it('keeps the x of a tiling when its y is edited', () => {
    const { store, row } = rig()
    const [x, y] = [...row('tiling').querySelectorAll<HTMLInputElement>('input')]
    x!.value = '2'
    x!.dispatchEvent(new Event('change'))
    y!.value = '3'
    y!.dispatchEvent(new Event('change'))
    expect(store.get(M)!.params.tiling).toEqual({ kind: 'vec2', value: { x: 2, y: 3 } })
  })
})
