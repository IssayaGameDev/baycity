import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { effectiveNode } from './nodes'
import { hydratePrefabs, prefabRefsIn, stripHydrated, type PrefabSource } from './prefabs'
import type { Level, Node } from './types'

const PAD = 'aaaaaaaaaaaaaaaa'
const RAIL = 'bbbbbbbbbbbbbbbb'

const pad = (name = 'pad'): Node => ({ id: 'root', name, transform: { position: vec3(0, 0, 0) }, components: [], children: [{ id: 'p0', transform: { position: vec3(0, 0, 0) }, components: [] }] })
const placement = (id: string, prefab: string, extra: Partial<Node> = {}): Node => ({ id, transform: { position: vec3(1, 0, 0) }, components: [], prefab, ...extra })

const level = (nodes: Node[], prefabs?: Record<string, Node>): Level => ({ id: 'lv', config: {}, ...(prefabs !== undefined ? { prefabs } : {}), nodes })
const source = (files: Record<string, Node>): PrefabSource => ({ root: (id) => files[id] })
const TYPES = { get: () => undefined }

describe('resolving a prefab reference', () => {
  it('collects every reference once, at any depth', () => {
    const l = level([placement('a', PAD, { children: [placement('a1', RAIL)] }), placement('b', PAD)])
    expect(prefabRefsIn(l)).toEqual([PAD, RAIL])
  })

  it('fills the table from the files and shares one object with every level that holds it', () => {
    const file = pad()
    const a = level([placement('x', PAD)])
    const b = level([placement('y', PAD)])
    expect(hydratePrefabs(a, { root: () => file })).toEqual({ filled: [PAD], missing: [] })
    hydratePrefabs(b, { root: () => file })
    // The same object, not a copy: this is what makes an edit to a prefab reach every level using it.
    expect(a.prefabs![PAD]).toBe(file)
    expect(b.prefabs![PAD]).toBe(file)
  })

  it('a reference with no file is named, and the placement resolves to its own layer alone', () => {
    const l = level([placement('a', PAD), placement('b', RAIL)])
    expect(hydratePrefabs(l, source({ [PAD]: pad() })).missing).toEqual([RAIL])
    expect(Object.keys(l.prefabs!)).toEqual([PAD])
    const gone = effectiveNode(l, l.nodes[1]!, TYPES)
    expect(gone.children).toEqual([])
    expect(gone.inheritedCount).toBe(0)
    expect(gone.transform.position, 'it keeps its own place in the level').toEqual(vec3(1, 0, 0))
  })

  /**
   * The rule that lets migrated and unmigrated content coexist with no version field. An old level carries its
   * own definitions under name keys; hydration must leave them be, and stripping must not take them, or the
   * level would lose its prefabs on its first write.
   */
  it('never clobbers a definition that is already there, and reports it as not filled', () => {
    const own = pad('mine')
    const other = pad('theirs')
    const l = level([placement('a', 'Trampoline')], { Trampoline: own })
    expect(hydratePrefabs(l, source({ Trampoline: other }))).toEqual({ filled: [], missing: [] })
    expect(l.prefabs!['Trampoline']).toBe(own)
  })

  it('is idempotent: a second pass fills nothing and changes nothing', () => {
    const l = level([placement('a', PAD)])
    hydratePrefabs(l, source({ [PAD]: pad() }))
    expect(hydratePrefabs(l, source({ [PAD]: pad() }))).toEqual({ filled: [], missing: [] })
    expect(Object.keys(l.prefabs!)).toEqual([PAD])
  })

  it('a level with no placements gets no table at all', () => {
    const l = level([{ id: 'plain', transform: { position: vec3(0, 0, 0) }, components: [] }])
    expect(hydratePrefabs(l, source({ [PAD]: pad() })).filled).toEqual([])
    expect(l.prefabs).toBeUndefined()
  })
})

describe('what goes back to disk', () => {
  it('drops what hydration filled and leaves the references, so a file holds neither definition twice', () => {
    const l = level([placement('a', PAD)])
    const { filled } = hydratePrefabs(l, source({ [PAD]: pad() }))
    expect(JSON.parse(JSON.stringify(stripHydrated(l, filled)))).toEqual({
      id: 'lv',
      config: {},
      nodes: [{ id: 'a', transform: { position: vec3(1, 0, 0) }, components: [], prefab: PAD }],
    })
    expect(l.prefabs, 'the level in memory keeps resolving').not.toBeUndefined()
  })

  it("keeps an unmigrated level's own table, and drops only the hydrated entry beside it", () => {
    const l = level([placement('a', 'Trampoline'), placement('b', PAD)], { Trampoline: pad('mine') })
    const { filled } = hydratePrefabs(l, source({ [PAD]: pad() }))
    expect(filled).toEqual([PAD])
    expect(Object.keys(stripHydrated(l, filled).prefabs!), 'the old table survives the write').toEqual(['Trampoline'])
  })

  it('strips nothing when nothing was filled', () => {
    const l = level([placement('a', 'Trampoline')], { Trampoline: pad('mine') })
    expect(stripHydrated(l, [])).toBe(l)
  })
})
