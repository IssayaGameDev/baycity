import { DEFAULT_REGISTRY } from '@mp/components'
import { applyBatch, effectiveNode, hydratePrefabs, type Level, type Node, type PrefabSource } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc, prefabDoc, type Doc } from './editorDoc'
import { rowsOf } from './hierarchy'

/**
 * The prefab grid: every gesture on every kind of node, and what it must do — the target of the rebuild
 * (ADR 0151, step 1).
 *
 * The kinds: a plain object of the level, a placement, a piece (the prefab's, seen through a placement), and
 * a child the placement added under a piece. The rule they are held to is one: **a prefab in a level behaves
 * like any other object and is still a prefab** (ADR 0135) — every gesture works on every kind, and what it
 * changes on a placement is recorded on that placement alone.
 *
 * Every case checks four things: the tree the editor shows; the same tree after the level is written and
 * opened again from its file, prefabs resolved from their files; the tree the game builds; and that undoing
 * every edit gives back exactly the level it started from.
 *
 * `it.fails` marks what does not work yet — each names what the survey traced it to. The rebuild turns them
 * into `it` one by one.
 */

const TOWER = 't'.repeat(16)
const OTHER = 'o'.repeat(16)
const END = Number.MAX_SAFE_INTEGER

const node = (id: string, name: string, children?: Node[]): Node => ({
  id,
  name,
  transform: { position: vec3(0, 0, 0) },
  components: [],
  ...(children === undefined ? {} : { children }),
})
/** Tower: Base holding Door, and Top holding Bell. */
const tower = (): Node => node('root', 'Tower', [node('base', 'Base', [node('door', 'Door')]), node('top', 'Top', [node('bell', 'Bell')])])
const other = (): Node => node('oroot', 'Other', [node('leaf', 'Leaf')])
const SOURCE: PrefabSource = { root: (id) => (id === TOWER ? tower() : id === OTHER ? other() : undefined) }

type Batch = Parameters<NonNullable<Doc['onOps']>>[0]

interface World {
  readonly doc: Doc
  readonly level: Level
  readonly batches: Batch[]
  /** The level before the case's own edits, to undo back to. */
  readonly before: string
}

/** The path of labels from the top of the tree, `/`-separated. */
const pathOf = (doc: Doc, i: number): string => {
  const parts: string[] = []
  for (let at: number | null = i; at !== null; at = doc.parentOf(at)) parts.unshift(doc.label(at))
  return parts.join('/')
}
const at = (doc: Doc, path: string): number => {
  for (let i = 0; i < doc.count(); i++) if (pathOf(doc, i) === path) return i
  throw new Error(`no node at ${path}`)
}

/**
 * A level of a plain `Crate` holding `Lid`, and two placements of Tower, `T1` and `T2`. `T1` has one child of
 * its own, `Flag`, added under its piece `Top`.
 */
const world = (setup?: (doc: Doc) => void): World => {
  const level: Level = { id: 'w', config: {}, nodes: [node('crate', 'Crate', [node('lid', 'Lid')])] }
  const doc = levelDoc(level, DEFAULT_REGISTRY)
  doc.setName(doc.placePrefab(TOWER, tower(), vec3(0, 0, 0)), 'T1')
  doc.setName(doc.placePrefab(TOWER, tower(), vec3(9, 0, 0)), 'T2')
  doc.setName(doc.placeEmpty(vec3(0, 0, 0), at(doc, 'T1/Top')), 'Flag')
  setup?.(doc)
  const batches: Batch[] = []
  doc.onOps = (b) => batches.push(b)
  return { doc, level, batches, before: JSON.stringify(level) }
}

/** The editor's tree: indented labels, a prefab's pieces starred. */
const shown = (doc: Doc): string[] =>
  Array.from({ length: doc.count() }, (_, i) => `${'  '.repeat(doc.depthOf(i))}${doc.label(i)}${doc.kindOf(i) === 'inherited' ? '*' : ''}`)

/** The game's tree: what `effectiveNode` builds, which is what the loader instantiates. No stars — it has no pieces. */
const built = (level: Level): string[] => {
  const out: string[] = []
  const walk = (n: Node, depth: number): void => {
    const r = effectiveNode(level, n, DEFAULT_REGISTRY)
    out.push(`${'  '.repeat(depth)}${r.name ?? n.name ?? n.id}`)
    for (const kid of r.children) walk(kid, depth + 1)
  }
  for (const n of level.nodes) walk(n, 0)
  return out
}

/** The level written out and opened again, its prefabs resolved from their files rather than carried along. */
const reopened = (level: Level): Doc => {
  const copy = JSON.parse(JSON.stringify(level)) as Level
  delete copy.prefabs
  hydratePrefabs(copy, SOURCE)
  return levelDoc(copy, DEFAULT_REGISTRY)
}

/** All four checks. */
const holds = (w: World, expected: readonly string[]): void => {
  expect(shown(w.doc), 'what the editor shows').toEqual(expected)
  const back = reopened(w.level)
  expect(shown(back), 'the same after writing and reopening').toEqual(expected)
  expect(built(back.asLevel()), 'what the game builds').toEqual(expected.map((l) => l.replace(/\*$/, '')))
  for (const b of [...w.batches].reverse()) applyBatch(w.level, b.inverses)
  expect(JSON.stringify(w.level), 'undo gives back the level it started from').toBe(w.before)
}

const T1 = ['T1', '  Base*', '    Door*', '  Top*', '    Bell*', '    Flag']
const T2 = ['T2', '  Base*', '    Door*', '  Top*', '    Bell*']
const CRATE = ['Crate', '  Lid']
const START = [...CRATE, ...T1, ...T2]

describe('the prefab grid: the world it runs on', () => {
  it('starts as described', () => {
    holds(world(), START)
  })
})

describe('the prefab grid: rename and switch off', () => {
  // The node, and which line of `START` shows it.
  for (const [kind, path, line] of [
    ['a plain object', 'Crate/Lid', 1],
    ['a placement', 'T1', 2],
    ['a piece', 'T1/Top', 5],
    ['an added child', 'T1/Top/Flag', 7],
  ] as const) {
    it(`renames ${kind}, on this placement only`, () => {
      const w = world()
      w.doc.setName(at(w.doc, path), 'X')
      const leaf = path.split('/').pop()!
      holds(w, START.map((l, n) => (n === line ? l.replace(leaf, 'X') : l)))
    })

    it(`switches off ${kind}`, () => {
      const w = world()
      const i = at(w.doc, path)
      w.doc.setNodeEnabled(i, false)
      expect(w.doc.nodeEnabled(at(w.doc, path))).toBe(false)
      holds(w, START)
    })
  }
})

describe('the prefab grid: delete', () => {
  it('deletes a plain object', () => {
    const w = world()
    w.doc.remove(at(w.doc, 'Crate/Lid'))
    holds(w, ['Crate', ...T1, ...T2])
  })

  it('deletes a placement', () => {
    const w = world()
    w.doc.remove(at(w.doc, 'T1'))
    holds(w, [...CRATE, ...T2])
  })

  it('deletes a piece from one placement, with what hangs under it', () => {
    const w = world()
    w.doc.remove(at(w.doc, 'T1/Top'))
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', ...T2])
  })

  // B3: `find` reports the placement as an added child's parent, so the undo puts it back under the placement.
  it.fails('deletes an added child, and undo puts it back under its piece', () => {
    const w = world()
    w.doc.remove(at(w.doc, 'T1/Top/Flag'))
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Top*', '    Bell*', ...T2])
  })
})

describe('the prefab grid: duplicate', () => {
  it('duplicates a plain object beside it', () => {
    const w = world()
    w.doc.duplicate(at(w.doc, 'Crate/Lid'))
    holds(w, ['Crate', '  Lid', '  Lid', ...T1, ...T2])
  })

  // B7: the copy keeps the added child's id, so inserting it fails.
  it.fails('duplicates a placement beside it, its own children included', () => {
    const w = world()
    w.doc.duplicate(at(w.doc, 'T1'))
    holds(w, [...CRATE, ...T1, ...T1, ...T2])
  })

  // B12: the copy goes to the end of the placement, not beside the piece.
  it.fails('duplicates a piece beside it, as an object of the level', () => {
    const w = world()
    w.doc.duplicate(at(w.doc, 'T1/Base'))
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Base', '    Door', '  Top*', '    Bell*', '    Flag', ...T2])
  })

  // B2: the copy lands at the top of the level.
  it.fails('duplicates an added child beside it', () => {
    const w = world()
    w.doc.duplicate(at(w.doc, 'T1/Top/Flag'))
    holds(w, [...CRATE, ...T1, '    Flag', ...T2])
  })
})

describe('the prefab grid: create a child', () => {
  const create = (under: string): World => {
    const w = world()
    w.doc.setName(w.doc.placeEmpty(vec3(0, 0, 0), at(w.doc, under)), 'New')
    return w
  }

  it('under a plain object', () => {
    holds(create('Crate'), ['Crate', '  Lid', '  New', ...T1, ...T2])
  })

  it('under a placement', () => {
    holds(create('T1'), [...CRATE, ...T1, '  New', ...T2])
  })

  // B9: undo removes the child and leaves `overrides.base: { addedChildren: [] }` behind (`tidyOverride`).
  it.fails('under a piece', () => {
    holds(create('T1/Base'), [...CRATE, 'T1', '  Base*', '    Door*', '    New', '  Top*', '    Bell*', '    Flag', ...T2])
  })

  it('under an added child', () => {
    holds(create('T1/Top/Flag'), [...CRATE, ...T1, '      New', ...T2])
  })
})

describe('the prefab grid: reorder among siblings', () => {
  it('reorders placements at the top of the level', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T2'), null, 0)
    holds(w, [...T2, ...CRATE, ...T1])
  })

  // B14: a reorder goes through reparent, which takes the piece out as a copy.
  it.fails('reorders a piece, which stays a piece', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Top'), at(w.doc, 'T1'), 0)
    holds(w, [...CRATE, 'T1', '  Top*', '    Bell*', '    Flag', '  Base*', '    Door*', ...T2])
  })

  // An added child is always listed after its inherited siblings unless an order is recorded, and a drop
  // never records one.
  it.fails('puts an added child before an inherited sibling', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Top/Flag'), at(w.doc, 'T1/Top'), 0)
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Top*', '    Flag', '    Bell*', ...T2])
  })
})

describe('the prefab grid: move into something else', () => {
  it('moves a plain object into a placement', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'Crate'), at(w.doc, 'T1'), END)
    holds(w, [...T1, '  Crate', '    Lid', ...T2])
  })

  // B9, as creating a child under a piece: undo leaves an empty record.
  it.fails('moves a plain object into a piece', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'Crate'), at(w.doc, 'T1/Base'), END)
    holds(w, ['T1', '  Base*', '    Door*', '    Crate', '      Lid', '  Top*', '    Bell*', '    Flag', ...T2])
  })

  it('moves a placement into a plain object', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1'), at(w.doc, 'Crate'), END)
    holds(w, [...CRATE, ...T1.map((l) => `  ${l}`), ...T2])
  })

  it('moves a piece out to the top of the level, as a copy the placement no longer has', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Top/Bell'), null, END)
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Top*', '    Flag', ...T2, 'Bell'])
  })

  it('moves a piece into another piece of its placement', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Base/Door'), at(w.doc, 'T1/Top'), END)
    holds(w, [...CRATE, 'T1', '  Base*', '  Top*', '    Bell*', '    Flag', '    Door', ...T2])
  })

  // B3: the undo of the move puts it back under the placement rather than under its piece.
  it.fails('moves an added child out to the top of the level', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Top/Flag'), null, END)
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Top*', '    Bell*', ...T2, 'Flag'])
  })

  // B8: `prefabRefsIn` does not walk added children, so a prefab placed only there is not resolved on reopen.
  it.fails('moves a placement into a piece of another placement, and it still resolves', () => {
    const w = world((doc) => doc.setName(doc.placePrefab(OTHER, other(), vec3(0, 0, 0)), 'O1'))
    w.doc.reparent(at(w.doc, 'O1'), at(w.doc, 'T2/Top'), END)
    holds(w, [...CRATE, ...T1, ...T2, '    O1', '      Leaf*'])
  })

  // U5: the menu offers it and `paste` refuses a piece.
  it.fails('pastes into a piece', () => {
    const w = world()
    const clip = w.doc.copy(at(w.doc, 'Crate'))!
    w.doc.paste(clip, at(w.doc, 'T1/Base'))
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '    Crate', '      Lid', '  Top*', '    Bell*', '    Flag', ...T2])
  })
})

describe('the prefab grid: one storage for what a placement adds', () => {
  // B1: a child created on a placement goes in the placement's own `children` (ADR 0130), not in its record.
  it.fails('keeps a child added to a placement in the placement’s differences', () => {
    const w = world()
    w.doc.placeEmpty(vec3(0, 0, 0), at(w.doc, 'T1'))
    const t1 = w.level.nodes.find((n) => n.name === 'T1')!
    expect(t1.children, 'nothing in the placement’s own children').toBeUndefined()
    expect(t1.overrides?.root?.addedChildren?.length).toBe(1)
  })

  // B13: a component added on the placement goes in its own `components`, which Revert and Apply never read.
  it.fails('counts a component added to a placement as a difference, and Revert takes it away', () => {
    const w = world()
    const t1 = at(w.doc, 'T1')
    w.doc.addComponent(t1, 'Hazard')
    expect(w.doc.placementOverrides(t1).length).toBeGreaterThan(0)
    w.doc.revertPlacement(t1)
    expect(w.doc.components(at(w.doc, 'T1')).map((c) => c.type)).not.toContain('Hazard')
  })
})

describe('the prefab grid: Revert and Apply', () => {
  // B4: the batch clears Top's record, Flag with it, and then tries to remove Flag.
  it.fails('reverts a placement to its prefab, however it differs', () => {
    const w = world()
    const t1 = at(w.doc, 'T1')
    w.doc.setName(at(w.doc, 'T1/Top'), 'Roof')
    w.doc.setNodeEnabled(at(w.doc, 'T1/Base'), false)
    w.doc.revertPlacement(t1)
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Top*', '    Bell*', ...T2])
  })

  // B6: `overridesOf` does not read `nodeEnabled`, so the difference is never counted, reverted or applied.
  it.fails('counts a piece switched off on one placement as a difference', () => {
    const w = world()
    w.doc.setNodeEnabled(at(w.doc, 'T2/Base'), false)
    expect(w.doc.placementOverrides(at(w.doc, 'T2')).map((o) => o.index)).toContain(at(w.doc, 'T2/Base'))
  })
})

describe('the prefab grid: the Hierarchy agrees with the tree', () => {
  // B10: `childCount` counts the prefab's children and not what a placement adds under a piece.
  it.fails('opens a piece whose only child is one the placement added', () => {
    const w = world((doc) => doc.placeEmpty(vec3(0, 0, 0), at(doc, 'T1/Base/Door')))
    const all = { expanded: new Set(Array.from({ length: w.doc.count() }, (_, i) => w.doc.pathOf(i))) }
    const door = rowsOf(w.doc, all).find((r) => r.index === at(w.doc, 'T1/Base/Door'))!
    expect(door.expandable).toBe(true)
  })
})

describe('the prefab grid: a prefab edited on its own', () => {
  // B11: dropping above the root makes a second root, which the prefab's file never writes.
  it.fails('keeps one root: nothing can be moved beside it', () => {
    const doc = prefabDoc(tower(), DEFAULT_REGISTRY)
    const base = at(doc, 'Tower/Base')
    expect(doc.canReparent(base, null)).toBe(false)
  })
})
