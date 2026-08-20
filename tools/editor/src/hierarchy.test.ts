import { COLLIDER, RENDERER, type ComponentData, type Node, type NodeLevel } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc, prefabDoc, type Doc } from './editorDoc'
import { dropTarget, rowsOf, zoneFor, type Openness, type Row } from './hierarchy'

const blank = (): NodeLevel => ({ id: 'l', config: { fallBehavior: 'physical-fall', fallY: -20 }, nodes: [] })

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })

/** A solid, visible node. */
const solid = (id: string, position: { x: number; y: number; z: number }, half = 1, name?: string): Node => ({
  id,
  ...(name !== undefined ? { name } : {}),
  transform: { position },
  components: [
    comp(`${id}-col`, COLLIDER, { shape: { kind: 'box', halfExtents: vec3(half, half, half) }, center: vec3(0, 0, 0) }),
    comp(`${id}-vis`, RENDERER, { material: '' }),
  ],
})

/** Prefab files the palette offers — generators are gone (ADR 0027), so a placeable thing is data. */
const LIBRARY: Record<string, Node> = {
  platform: { id: 'root', name: 'platform', transform: { position: vec3(0, 0, 0) }, components: [], children: [solid('slab', vec3(0, 0, 0), 1.5)] },
}

/** A ball, so a row's fallback label is distinguishable from a box's. */
const ball = (id: string, position: { x: number; y: number; z: number }): Node => ({
  id,
  transform: { position },
  components: [
    comp(`${id}-col`, COLLIDER, { shape: { kind: 'ball', radius: 0.5 }, center: vec3(0, 0, 0) }),
    comp(`${id}-vis`, RENDERER, { material: '' }),
  ],
})

/** A prefab whose root carries only a transform, with two nodes under it. */
const twoNodes = (id: string): Node => ({
  id: 'root',
  name: id,
  transform: { position: vec3(0, 0, 0) },
  components: [],
  children: [solid('left', vec3(0, 0, 0), 1, 'left rail'), ball('right', vec3(2, 0, 0))],
})

/** A one-off: the same contents inline, with nothing to reference. */
const inline = (id: string): Node => ({ ...twoNodes(id), id })

/** Nothing expanded, which is what a freshly opened level looks like. */
const SHUT: Openness = { expanded: new Set() }
/** Every row expanded, for the tests that are about what nesting looks like when you can see it. */
const allOpen = (doc: Doc): Openness => ({ expanded: new Set(Array.from({ length: doc.count() }, (_, i) => doc.pathOf(i))) })
const open = (over: Partial<Openness> = {}): Openness => ({ ...SHUT, ...over })

/** Rows as `indent + label`, which is what the panel actually shows. */
const shape = (doc: Doc, o?: Openness): string[] =>
  rowsOf(doc, o ?? allOpen(doc)).map((r) => `${'  '.repeat(r.depth)}${r.label}`)

/**
 * Just the rows this document owns. What a placement inherits from its prefab shows by default, so the tests
 * about *tree structure* say so explicitly rather than being written around prefabs that happen to have one
 * node each.
 */
const items = (doc: Doc, o?: Openness): string[] =>
  rowsOf(doc, o ?? allOpen(doc))
    .filter((r) => r.kind === 'item')
    .map((r) => `${'  '.repeat(r.depth)}${r.label}`)

/** Four top-level platforms named a..d. */
const four = (): Doc => {
  const doc = levelDoc(blank(), LIBRARY)
  for (const n of ['a', 'b', 'c', 'd']) doc.setName(doc.place('platform', vec3(0, 0, 0)), n)
  return doc
}

/**
 * The index of the placement called `name`.
 *
 * Looked up rather than written as a literal, because indices address inherited nodes too — a level of four
 * one-node platforms numbers 0,2,4,6 — and every structural edit renumbers.
 */
const idx = (doc: Doc, name: string): number => {
  for (let i = 0; i < doc.count(); i++) if (doc.kindOf(i) === 'own' && doc.label(i) === name) return i
  throw new Error(`no placement named ${name}`)
}

describe('rowsOf: the tree', () => {
  it('gives one row per instance, indented by depth', () => {
    const doc = four()
    doc.reparent(idx(doc, 'b'), idx(doc, 'a'), 0)
    doc.reparent(idx(doc, 'c'), idx(doc, 'b'), 0)

    expect(items(doc)).toEqual(['a', '  b', '    c', 'd'])
  })

  it('reports a row with contents as expanded when it is open', () => {
    const doc = four()
    doc.reparent(idx(doc, 'b'), idx(doc, 'a'), 0)
    expect(rowsOf(doc, allOpen(doc))[0]!.expanded).toBe(true)
  })

  it('hides a shut row\'s whole subtree, however deep', () => {
    const doc = four()
    doc.reparent(idx(doc, 'b'), idx(doc, 'a'), 0)
    doc.reparent(idx(doc, 'c'), idx(doc, 'b'), 0)

    expect(items(doc, SHUT), 'nothing expanded, so only the top level').toEqual(['a', 'd'])
    // `a` expanded but `b` still shut: `b` appears, `c` does not.
    expect(items(doc, open({ expanded: new Set([doc.pathOf(idx(doc, 'a'))]) }))).toEqual(['a', '  b', 'd'])
  })

  it('comes back out of a shut subtree at the right depth', () => {
    const doc = four()
    doc.reparent(idx(doc, 'b'), idx(doc, 'a'), 0)
    // `d` is a sibling of `a`, so `a` being shut must not hide it.
    expect(items(doc, SHUT)).toEqual(['a', 'c', 'd'])
  })

  it('keys openness by path, so editing elsewhere does not shuffle it', () => {
    const doc = four()
    doc.reparent(idx(doc, 'b'), idx(doc, 'a'), 0)
    expect(doc.pathOf(idx(doc, 'c')), 'second top-level instance').toBe('1')
    expect(doc.pathOf(idx(doc, 'b')), "a's first child").toBe('0/0')
    // A piece hangs off its owner's path, so UI state keyed by path tells them apart.
    expect(doc.pathOf(idx(doc, 'a') + 1), "a's own piece").toBe('0#0')
  })
})

describe('rowsOf: prefab pieces', () => {
  // Reversed by ADR 0033. A piece carries the visuals, the collider and the trigger, so hiding it by default
  // was hiding the object you came to edit — and reaching it took two clicks through an overloaded twist.
  it('shows pieces by default, under the instance they belong to', () => {
    const doc = four()
    expect(shape(doc)).toEqual(['a', '  box', 'b', '  box', 'c', '  box', 'd', '  box'])
  })

  it('addresses an inherited row by its own index, under the placement it belongs to', () => {
    const doc = levelDoc(blank(), { ...LIBRARY, pair: twoNodes('pair') })
    doc.place('pair', vec3(0, 0, 0))

    const rows = rowsOf(doc, allOpen(doc))
    // `index` is the node's *own* index: an inherited node is addressable, so it is no longer its owner's
    // index with a child number beside it. `parent` is what says whose it is.
    expect(rows.map((r) => `${r.kind}:${r.index}.${r.pieceIndex}@${r.depth}`)).toEqual(['item:0.-1@0', 'inherited:1.0@1', 'inherited:2.1@1'])
    expect(
      rows.slice(1).every((r) => r.parent === 0),
      'both belong to the placement',
    ).toBe(true)
    // The authored name, falling back to the collider shape. It used to be `box · <style>`, which stopped
    // meaning anything when style died (ADR 0028) — and a name is what distinguishes three boxes anyway.
    expect(rows[1]!.label, 'the name when it has one').toBe('left rail')
    expect(rows[2]!.label, 'the collider shape when it does not').toBe('ball')
  })

  it('has nothing inherited in prefab mode, where every node is the definition', () => {
    const rows = rowsOf(prefabDoc(twoNodes('p')), allOpen(prefabDoc(twoNodes('p'))))
    expect(rows.every((r) => r.kind === 'item'), 'no row is a reference into something else').toBe(true)
    expect(rows).toHaveLength(3) // the root and its two nodes
  })

  /**
   * The bug this replaced. One twist wrote to whichever of two sets the row happened to need, so an instance
   * that gained a child stopped writing to the pieces set — and its pieces could never be shown again.
   */
  it('shows inherited nodes and children together, so a child cannot hide them', () => {
    const doc = levelDoc(blank(), { ...LIBRARY, pair: twoNodes('pair') })
    const placement = doc.place('pair', vec3(0, 0, 0))
    doc.reparent(doc.place('pair', vec3(0, 1, 0)), placement, 0)

    const rows = rowsOf(doc, allOpen(doc))
    expect(rows.filter((r) => r.kind === 'inherited' && r.parent === 0)).toHaveLength(2)
    expect(
      rows.some((r) => r.kind === 'item' && r.depth === 1),
      'and the child is there too',
    ).toBe(true)
  })

  it('hides inherited nodes and children behind the one twist', () => {
    const doc = levelDoc(blank(), { ...LIBRARY, pair: twoNodes('pair') })
    const placement = doc.place('pair', vec3(0, 0, 0))
    doc.reparent(doc.place('pair', vec3(0, 1, 0)), placement, 0)

    const rows = rowsOf(doc, SHUT)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.expandable, 'still openable').toBe(true)
    expect(rows[0]!.expanded).toBe(false)
  })
})

describe('rowsOf: annotations', () => {
  it('badges a shared prefab with its count, and marks an inline one-off', () => {
    const doc = four()
    const badged = rowsOf(doc, allOpen(doc)).filter((r) => r.kind === 'item')
    expect(badged).toHaveLength(4)
    expect(badged.every((r) => r.badge === '×4')).toBe(true)

    const level = blank()
    level.nodes.push(inline('oneoff'))
    expect(rowsOf(levelDoc(level, LIBRARY), { expanded: new Set(['0']) })[0]!.badge).toBe('inline')
  })

  it('reports the parent and sibling index a drop needs', () => {
    const doc = four()
    doc.reparent(idx(doc, 'c'), idx(doc, 'a'), 0)
    // Instance rows only: a drop targets an instance, and piece rows now sit between them (ADR 0033).
    const rows = rowsOf(doc, allOpen(doc)).filter((r) => r.kind === 'item')

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
