// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { byMenuFolder } from './componentMenu'
import { folderTree, treePicker, type TreeItem, type TreePickerOptions } from './treePicker'

/**
 * The searchable tree (ADR 0178) behind the reference fields' picker and Add Component: folders that open and shut,
 * what can be picked inside them, and a search that lists every match flat with where it is.
 */

const HIER: TreeItem[] = [
  {
    key: 'stage',
    label: 'Stage 2',
    icon: 'object',
    pickable: false,
    children: [
      { key: 'w1', label: 'Wall', icon: 'object', pickable: true },
      { key: 'plat', label: 'Platform', icon: 'object', pickable: true, children: [{ key: 'w2', label: 'Wall', icon: 'object', pickable: true }] },
    ],
  },
  { key: 'floor', label: 'Floor', icon: 'object', pickable: true },
]

const rig = (over: Partial<TreePickerOptions> = {}) => {
  document.body.replaceChildren()
  const picked: (string | null)[] = []
  const t = treePicker({ items: HIER, none: 'None', pick: (k) => void picked.push(k), ...over })
  document.body.append(t.root)
  const rows = (): string[] => [...t.root.querySelectorAll('.tp-row')].map((r) => r.querySelector('.tp-t')!.textContent ?? '')
  const row = (label: string, n = 0): HTMLElement => [...t.root.querySelectorAll<HTMLElement>('.tp-row')].filter((r) => r.querySelector('.tp-t')!.textContent === label)[n]!
  const search = (q: string): void => {
    const s = t.root.querySelector<HTMLInputElement>('.tp-search')!
    s.value = q
    s.dispatchEvent(new Event('input'))
  }
  return { t, picked, rows, row, search }
}

describe('the tree picker', () => {
  it('starts shut, opens a folder on a press, and a pickable branch by its twist', () => {
    const { rows, row, picked } = rig()
    expect(rows()).toEqual(['None', 'Stage 2', 'Floor'])
    row('Stage 2').click()
    expect(rows()).toEqual(['None', 'Stage 2', 'Wall', 'Platform', 'Floor'])
    row('Platform').querySelector<HTMLElement>('.tp-tw')!.click()
    expect(rows()).toEqual(['None', 'Stage 2', 'Wall', 'Platform', 'Wall', 'Floor'])
    expect(picked, 'opening picks nothing').toEqual([])
    row('Wall', 1).click()
    row('None').click()
    expect(picked).toEqual(['w2', null])
  })

  it('opens the way to what is chosen now, and lights it', () => {
    const { rows, row } = rig({ current: 'w2' })
    expect(rows()).toEqual(['None', 'Stage 2', 'Wall', 'Platform', 'Wall', 'Floor'])
    expect(row('Wall', 1).classList.contains('on')).toBe(true)
  })

  it('searches every level, flat, each match with where it is, and Enter takes the first', () => {
    const { t, rows, search, picked } = rig()
    search('wall')
    expect(rows()).toEqual(['Wall', 'Wall'])
    expect([...t.root.querySelectorAll('.tp-hint')].map((h) => h.textContent)).toEqual(['Stage 2', 'Stage 2 › Platform'])
    t.root.querySelector('.tp-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(picked).toEqual(['w1'])
    search('stage')
    expect(rows(), 'a folder is not a match').toEqual([])
  })

  it('opens every folder of a short list, and has no None where none is given', () => {
    document.body.replaceChildren()
    const t = treePicker({ items: HIER, openAll: true, pick: () => {} })
    const rows = [...t.root.querySelectorAll('.tp-row')].map((r) => r.querySelector('.tp-t')!.textContent)
    expect(rows).toEqual(['Stage 2', 'Wall', 'Platform', 'Wall', 'Floor'])
  })
})

describe('folderTree', () => {
  it('nests entries in their folders, in the order they first appear', () => {
    const tree = folderTree([
      { key: 'red', label: 'red', folders: ['Keyboard', 'materials'] },
      { key: 'box', label: 'Box', folders: ['Built-in'] },
      { key: 'blue', label: 'blue', folders: ['Keyboard', 'materials'] },
    ])
    expect(tree.map((f) => f.label)).toEqual(['Keyboard', 'Built-in'])
    expect(tree[0]!.children![0]!.label).toBe('materials')
    expect(tree[0]!.children![0]!.children!.map((x) => x.key)).toEqual(['red', 'blue'])
    expect(tree[0]!.pickable).toBe(false)
  })
})

describe('byMenuFolder', () => {
  it('puts the built-in folders first in their order, then the rest by name', () => {
    const groups = byMenuFolder(['Keyboard', 'Gameplay', 'Physics', 'Animation', 'Zeta', 'Rendering', 'Gameplay'], (f) => f)
    expect(groups.map((g) => g.folder)).toEqual(['Physics', 'Rendering', 'Gameplay', 'Animation', 'Keyboard', 'Zeta'])
    expect(groups[2]!.entries).toHaveLength(2)
  })
})
