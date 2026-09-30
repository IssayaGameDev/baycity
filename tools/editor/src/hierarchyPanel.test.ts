// @vitest-environment happy-dom
import { COLLIDER, RENDERER, type Level, type Node } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc } from './editorDoc'
import { createHierarchy } from './hierarchy'

/**
 * What the Hierarchy draws (ADR 0150): a cube per row in its kind's colour, guides for nesting, the eye at the
 * right end, and a count only for a prefab placed more than once.
 */

const box = (id: string, name: string, children: Node[] = []): Node => ({
  id,
  name,
  transform: { position: vec3(0, 0, 0) },
  components: [
    { id: `${id}-col`, type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(1, 1, 1) }, center: vec3(0, 0, 0) } },
    { id: `${id}-vis`, type: RENDERER, params: { material: '' } },
  ],
  ...(children.length === 0 ? {} : { children }),
})
const PREFAB: Node = { id: 'root', name: 'platform', transform: { position: vec3(0, 0, 0) }, components: [], children: [box('slab', 'slab')] }

/** A level of `Walls` holding a `Wall`, and a prefab placed twice; everything open. `hidden` is what the eye hides. */
const rig = (
  hidden: ReadonlySet<number> = new Set(),
  held: { index: number; name: string; colour: string } | null = null,
): { list: HTMLElement; toggles: [number, boolean][]; picked: number[] } => {
  const level: Level = { id: 'l', config: {}, nodes: [box('walls', 'Walls', [box('w1', 'Wall')])] }
  const doc = levelDoc(level)
  doc.placePrefab('a'.repeat(16), PREFAB, vec3(0, 0, 0))
  doc.placePrefab('a'.repeat(16), PREFAB, vec3(4, 0, 0))
  const list = document.createElement('div')
  document.body.replaceChildren(list)
  const toggles: [number, boolean][] = []
  const picked: number[] = []
  createHierarchy(list, {
    doc: () => doc,
    selection: () => [],
    onSelect: (i) => void picked.push(i),
    isHidden: (i) => hidden.has(i),
    onToggleHidden: (i, only) => toggles.push([i, only]),
    levelSelected: () => false,
    onSelectLevel: () => {},
    envSelected: () => false,
    onSelectEnv: () => {},
    onRename: () => {},
    onReparent: () => {},
    holders: (i) => (held !== null && i === held.index ? [{ name: held.name, colour: held.colour }] : []),
  }).setAllOpen(true)
  return { list, toggles, picked }
}

const rowOf = (list: HTMLElement, name: string): HTMLElement =>
  [...list.querySelectorAll<HTMLElement>('.row[data-index]')].find((r) => r.querySelector('.name')?.textContent === name)!

describe('the Hierarchy’s rows', () => {
  it('puts the level’s settings above the tree, with icons', () => {
    const { list } = rig()
    const settings = [...list.querySelectorAll<HTMLElement>('.row.env')]
    expect(settings.map((r) => r.querySelector('.name')!.textContent)).toEqual(['Level', 'Environment'])
    expect(settings.every((r) => r.querySelector('svg.ico') !== null)).toBe(true)
  })

  it('draws a cube per row in its kind’s colour, and counts only a prefab placed more than once', () => {
    const { list } = rig()
    const cube = (name: string): string => [...rowOf(list, name).querySelector('svg.ico')!.classList].find((c) => c.startsWith('is-'))!
    expect(cube('Walls')).toBe('is-object')
    expect(cube('platform')).toBe('is-prefab')
    expect(cube('slab')).toBe('is-piece')
    expect(rowOf(list, 'Walls').querySelector('.badge'), 'no "inline" on the level’s own objects').toBeNull()
    expect(rowOf(list, 'platform').querySelector('.badge')!.textContent).toBe('×2')
  })

  it('indents by depth, with a guide for each level above the row', () => {
    const { list } = rig()
    expect(rowOf(list, 'Walls').querySelector('.guides')).toBeNull()
    expect(rowOf(list, 'Wall').querySelector<HTMLElement>('.guides')!.style.width).toBe('16px')
    expect(rowOf(list, 'Wall').style.paddingLeft).toBe('22px')
  })

  it('keeps the eye at the right end, before the count, and says when it is shut', () => {
    const { list, toggles } = rig()
    const parts = [...rowOf(list, 'platform').children].map((c) => c.classList[0])
    expect(parts.slice(parts.indexOf('name'))).toEqual(['name', 'eye', 'badge'])
    rowOf(list, 'Walls').querySelector<HTMLButtonElement>('.eye')!.click()
    expect(toggles).toEqual([[0, false]])

    expect(rowOf(rig(new Set([0])).list, 'Walls').classList.contains('eyeshut')).toBe(true)
  })

  it('names who else has a row selected in their colour, and the row stays yours to pick (ADR 0155, ADR 0158)', () => {
    const { list, picked } = rig(new Set(), { index: 0, name: 'Ana', colour: '#12ab34' })
    const row = rowOf(list, 'Walls')
    const badge = row.querySelector<HTMLElement>('.badge.held')!
    expect(badge.textContent).toBe('Ana')
    expect(badge.style.getPropertyValue('--peer')).toBe('#12ab34')
    expect(row.classList.contains('held'), 'not dimmed').toBe(false)
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    // The press waits for the click, so a press that becomes a drag selects nothing (ADR 0176).
    expect(picked, 'not on the press').toEqual([])
    row.click()
    expect(picked).toEqual([0])
  })
})
