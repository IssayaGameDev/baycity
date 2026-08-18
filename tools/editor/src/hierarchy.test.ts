import type { Level, Prefab } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc, prefabDoc, type Doc } from './editorDoc'
import { dropTarget, rowsOf, zoneFor, type Openness, type Row } from './hierarchy'

const blank = (): Level => ({ id: 'l', config: { fallBehavior: 'physical-fall', fallY: -20 }, instances: [] })

const twoPieces = (id: string): Prefab => ({
  id,
  pieces: [
    { collider: { kind: 'box', halfExtents: vec3(1, 1, 1) }, transform: { position: vec3(0, 0, 0) }, visual: { kind: 'primitive', style: 'platform' } },
    { collider: { kind: 'ball', radius: 0.5 }, transform: { position: vec3(2, 0, 0) } },
  ],
})

const ALL_OPEN: Openness = { collapsed: new Set(), piecesOpen: new Set() }
const open = (over: Partial<Openness> = {}): Openness => ({ ...ALL_OPEN, ...over })

/** Rows as `indent + label`, which is what the panel actually shows. */
const shape = (doc: Doc, o: Openness = ALL_OPEN): string[] =>
  rowsOf(doc, o).map((r) => `${'  '.repeat(r.depth)}${r.label}`)

/** Four top-level platforms named a..d. */
const four = (): Doc => {
  const doc = levelDoc(blank(), {})
  for (const n of ['a', 'b', 'c', 'd']) doc.setName(doc.place('platform', vec3(0, 0, 0)), n)
  return doc
}

describe('rowsOf: the tree', () => {
  it('gives one row per instance, indented by depth', () => {
    const doc = four()
    doc.reparent(1, 0, 0) // b under a
    doc.reparent(2, 1, 0) // c under b

    expect(shape(doc)).toEqual(['a', '  b', '    c', 'd'])
  })

  it('shows child instances by default — the tree is the point', () => {
    const doc = four()
    doc.reparent(1, 0, 0)
    expect(rowsOf(doc, ALL_OPEN)[0]!.expanded).toBe(true)
  })

  it('hides a collapsed row\'s whole subtree, however deep', () => {
    const doc = four()
    doc.reparent(1, 0, 0) // b under a
    doc.reparent(2, 1, 0) // c under b

    expect(shape(doc, open({ collapsed: new Set([doc.pathOf(0)]) })), 'a shut, so b and c go too').toEqual(['a', 'd'])
    expect(shape(doc, open({ collapsed: new Set([doc.pathOf(1)]) })), 'b shut hides only c').toEqual(['a', '  b', 'd'])
  })

  it('comes back out of a collapsed subtree at the right depth', () => {
    const doc = four()
    doc.reparent(1, 0, 0) // b under a
    // `d` is a sibling of `a`, so collapsing `a` must not hide it.
    expect(shape(doc, open({ collapsed: new Set([doc.pathOf(0)]) }))).toEqual(['a', 'c', 'd'])
  })

  it('keys openness by path, so editing elsewhere does not shuffle it', () => {
    const doc = four()
    doc.reparent(1, 0, 0)
    // Second top-level instance's path, whatever its depth-first index becomes.
    expect(doc.pathOf(2)).toBe('1')
    expect(doc.pathOf(1), "a's first child").toBe('0/0')
  })
})

describe('rowsOf: prefab pieces', () => {
  it('keeps pieces shut by default — they are detail, not structure', () => {
    const doc = four()
    expect(shape(doc)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reveals pieces when opened, addressed by item and piece index', () => {
    const level = blank()
    level.instances.push({ prefab: twoPieces('x'), transform: { position: vec3(0, 0, 0) } })
    const doc = levelDoc(level, {})

    const rows = rowsOf(doc, open({ piecesOpen: new Set([doc.pathOf(0)]) }))
    expect(rows.map((r) => `${r.kind}:${r.index}.${r.pieceIndex}@${r.depth}`)).toEqual([
      'item:0.-1@0',
      'piece:0.0@1',
      'piece:0.1@1',
    ])
    expect(rows[1]!.label, 'style shown when the piece has one').toBe('box · platform')
    expect(rows[2]!.label, 'and omitted when it does not').toBe('ball')
  })

  it('offers no piece rows in prefab mode, where the item already *is* the piece', () => {
    const doc = prefabDoc(twoPieces('p'))
    const rows = rowsOf(doc, open({ piecesOpen: new Set(['0', '1']) }))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => !r.expandable)).toBe(true)
  })
})

describe('rowsOf: annotations', () => {
  it('badges a shared prefab with its count, and marks an inline one-off', () => {
    const doc = four()
    expect(rowsOf(doc, ALL_OPEN).every((r) => r.badge === '×4')).toBe(true)

    const level = blank()
    level.instances.push({ prefab: twoPieces('oneoff'), transform: { position: vec3(0, 0, 0) } })
    expect(rowsOf(levelDoc(level, {}), ALL_OPEN)[0]!.badge).toBe('inline')
  })

  it('reports the parent and sibling index a drop needs', () => {
    const doc = four()
    doc.reparent(2, 0, 0) // c under a
    const rows = rowsOf(doc, ALL_OPEN)

    expect(rows[1]!.parent, "c's parent is a").toBe(0)
    expect(rows[1]!.siblingIndex).toBe(0)
    expect(rows[2]!.parent, 'b is top level').toBeNull()
    expect(rows[2]!.siblingIndex, 'and second among the top-level instances').toBe(1)
  })
})

describe('zoneFor', () => {
  it('splits an item row into above / onto / below', () => {
    expect(zoneFor(2, 20, true)).toBe('above')
    expect(zoneFor(10, 20, true)).toBe('onto')
    expect(zoneFor(18, 20, true)).toBe('below')
  })

  it('has no middle where nothing can be parented — a piece row', () => {
    expect(zoneFor(9, 20, false)).toBe('above')
    expect(zoneFor(11, 20, false)).toBe('below')
  })

  // A row measured before layout has zero height. The guard matters (no divide by zero); which band a
  // degenerate row reports does not, so long as it is a real one.
  it('survives a zero-height row rather than dividing by it', () => {
    expect(zoneFor(0, 0, true)).toBe('above')
  })
})

describe('dropTarget', () => {
  const row = (over: Partial<Row> = {}): Row => ({
    kind: 'item',
    index: 5,
    pieceIndex: -1,
    depth: 1,
    path: '0/2',
    parent: 0,
    siblingIndex: 2,
    label: 'x',
    badge: '',
    linked: true,
    hasChildren: false,
    expandable: false,
    expanded: false,
    ...over,
  })

  it('makes a dropped item a child when dropped onto a row', () => {
    expect(dropTarget(row(), 'onto').parent, 'the row itself becomes the parent').toBe(5)
  })

  it('inserts among the row\'s siblings when dropped above or below', () => {
    expect(dropTarget(row(), 'above')).toEqual({ parent: 0, at: 2 })
    expect(dropTarget(row(), 'below')).toEqual({ parent: 0, at: 3 })
  })

  it('inserts at the top level for a row that has no parent', () => {
    expect(dropTarget(row({ parent: null, siblingIndex: 0 }), 'above')).toEqual({ parent: null, at: 0 })
  })
})
