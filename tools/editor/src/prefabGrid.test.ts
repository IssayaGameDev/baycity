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
 * Seventeen of these failed before the rebuild, each for a traced cause; the comments on them say what used
 * to go wrong.
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

  // Undo puts it back in its piece's record: `find` knows which record holds it (ADR 0151).
  it('deletes an added child, and undo puts it back under its piece', () => {
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

  // The copy re-mints the ids of what the placement added too, and follows them in its recorded order.
  it('duplicates a placement beside it, its own children included', () => {
    const w = world()
    w.doc.duplicate(at(w.doc, 'T1'))
    holds(w, [...CRATE, ...T1, ...T1, ...T2])
  })

  // Beside it, in the placement's record, placed by a recorded order — not at the end of the placement.
  it('duplicates a piece beside it, as an object of the level', () => {
    const w = world()
    w.doc.duplicate(at(w.doc, 'T1/Base'))
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Base', '    Door', '  Top*', '    Bell*', '    Flag', ...T2])
  })

  // Beside it in the same record — it used to land at the top of the level.
  it('duplicates an added child beside it', () => {
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

  // Undo leaves no `addedChildren: []` behind: `tidyOverride` tidies every field (ADR 0151).
  it('under a piece', () => {
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

  // A drop among its siblings is a reorder, recorded as the placement's order; it used to take the piece out as a copy.
  it('reorders a piece, which stays a piece', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Top'), at(w.doc, 'T1'), 0)
    holds(w, [...CRATE, 'T1', '  Top*', '    Bell*', '    Flag', '  Base*', '    Door*', ...T2])
  })

  // An added child is listed after its inherited siblings unless an order is recorded — which a drop now does.
  it('puts an added child before an inherited sibling', () => {
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

  // Undo leaves no empty record behind, as for creating a child under a piece.
  it('moves a plain object into a piece', () => {
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

  // Out of a record is a removal and an insert, whose undo puts it back in the record (ADR 0151).
  it('moves an added child out to the top of the level', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Top/Flag'), null, END)
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Top*', '    Bell*', ...T2, 'Flag'])
  })

  // `prefabRefsIn` walks what placements added, so a prefab placed only there is resolved when the level is opened again.
  it('moves a placement into a piece of another placement, and it still resolves', () => {
    const w = world((doc) => doc.setName(doc.placePrefab(OTHER, other(), vec3(0, 0, 0)), 'O1'))
    w.doc.reparent(at(w.doc, 'O1'), at(w.doc, 'T2/Top'), END)
    holds(w, [...CRATE, ...T1, ...T2, '    O1', '      Leaf*'])
  })

  // A piece takes a pasted child into its record, like any other child.
  it('pastes into a piece', () => {
    const w = world()
    const clip = w.doc.copy(at(w.doc, 'Crate'))!
    w.doc.paste(clip, at(w.doc, 'T1/Base'))
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '    Crate', '      Lid', '  Top*', '    Bell*', '    Flag', ...T2])
  })
})

describe('the prefab grid: one storage for what a placement adds', () => {
  // One storage (ADR 0151): in the record of the prefab's root, not in the placement's own `children` (ADR 0130).
  it('keeps a child added to a placement in the placement’s differences', () => {
    const w = world()
    w.doc.placeEmpty(vec3(0, 0, 0), at(w.doc, 'T1'))
    const t1 = w.level.nodes.find((n) => n.name === 'T1')!
    expect(t1.children, 'nothing in the placement’s own children').toBeUndefined()
    expect(t1.overrides?.root?.addedChildren?.length).toBe(1)
  })

  // In the root's record too, where Revert and Apply look — not in the placement's own `components`.
  it('counts a component added to a placement as a difference, and Revert takes it away', () => {
    const w = world()
    const t1 = at(w.doc, 'T1')
    w.doc.addComponent(t1, 'Hazard')
    expect(w.doc.placementOverrides(t1).length).toBeGreaterThan(0)
    w.doc.revertPlacement(t1)
    expect(w.doc.components(at(w.doc, 'T1')).map((c) => c.type)).not.toContain('Hazard')
  })
})

describe('the prefab grid: Revert and Apply', () => {
  // Every record cleared in one batch. It used to clear Top's record, Flag with it, then try to remove Flag.
  it('reverts a placement to its prefab, however it differs', () => {
    const w = world()
    const t1 = at(w.doc, 'T1')
    w.doc.setName(at(w.doc, 'T1/Top'), 'Roof')
    w.doc.setNodeEnabled(at(w.doc, 'T1/Base'), false)
    w.doc.revertPlacement(t1)
    holds(w, [...CRATE, 'T1', '  Base*', '    Door*', '  Top*', '    Bell*', ...T2])
  })

  // Every field counts, from the one list (`tree.ts`); `nodeEnabled` used to be missed.
  it('counts a piece switched off on one placement as a difference', () => {
    const w = world()
    w.doc.setNodeEnabled(at(w.doc, 'T2/Base'), false)
    expect(w.doc.placementOverrides(at(w.doc, 'T2')).map((o) => o.index)).toContain(at(w.doc, 'T2/Base'))
  })
})

/**
 * Apply, checked on the prefab itself: the ops a placement's Apply sends are run over the prefab's own
 * document, and the prefab must come out looking like the placement did.
 */
describe('the prefab grid: Apply makes the prefab match', () => {
  /** The prefab's tree after `ops`, as indented names. */
  const applied = (ops: readonly import('@mp/content').Op[]): string[] => {
    const prefab: Level = { id: 'p', config: {}, nodes: [tower()] }
    applyBatch(prefab, ops)
    return built(prefab)
  }
  /** What the placement shows, as the prefab would have it: its name the prefab's, no stars. */
  const asPrefab = (w: World, placement: string): string[] => {
    const lines = shown(w.doc)
    const from = lines.indexOf(placement)
    const rest = lines.slice(from + 1)
    const end = rest.findIndex((l) => !l.startsWith('  '))
    return ['Tower', ...(end < 0 ? rest : rest.slice(0, end)).map((l) => l.replace(/\*$/, ''))]
  }

  it('carries a piece’s added children and their order, from one piece', () => {
    const w = world()
    w.doc.reparent(at(w.doc, 'T1/Top/Flag'), at(w.doc, 'T1/Top'), 0)
    const plan = w.doc.overrideOpsFor(at(w.doc, 'T1/Top'))!
    expect(applied(plan.ops)).toEqual(['Tower', '  Base', '    Door', '  Top', '    Flag', '    Bell'])
  })

  it('carries a piece switched off', () => {
    const w = world()
    w.doc.setNodeEnabled(at(w.doc, 'T2/Base'), false)
    const plan = w.doc.overrideOpsFor(at(w.doc, 'T2/Base'))!
    expect(plan.ops).toContainEqual({ kind: 'setNodeEnabled', id: 'base', enabled: false })
  })

  it('carries everything at once from the placement: removals, renames, added children, order', () => {
    const w = world()
    w.doc.remove(at(w.doc, 'T1/Base/Door'))
    w.doc.setName(at(w.doc, 'T1/Top'), 'Roof')
    w.doc.setName(w.doc.placeEmpty(vec3(0, 0, 0), at(w.doc, 'T1')), 'Mast')
    w.doc.reparent(at(w.doc, 'T1/Mast'), at(w.doc, 'T1'), 0)
    expect(applied(w.doc.placementOverrideOps(at(w.doc, 'T1'))!.ops)).toEqual(asPrefab(w, 'T1'))
  })
})

describe('the prefab grid: unlink', () => {
  // The level authored what the placement added, so the level's references to it must keep working.
  it('keeps the ids of what the placement added, and re-mints the prefab’s', () => {
    const w = world()
    const flag = w.level.nodes[1]!.overrides!.top!.addedChildren![0]!.id
    w.doc.unlinkNode(at(w.doc, 'T1'))
    const t1 = w.level.nodes[1]!
    const top = t1.children!.find((k) => k.name === 'Top')!
    expect(top.id, 'a piece becomes the level’s own, with an id of its own').not.toBe('top')
    expect(top.children!.map((k) => k.id)).toContain(flag)
    holds(w, [...CRATE, 'T1', '  Base', '    Door', '  Top', '    Bell', '    Flag', ...T2])
  })
})

describe('the prefab grid: the Hierarchy agrees with the tree', () => {
  // `childCount` counts what the tree shows, what a placement added under a piece included.
  it('opens a piece whose only child is one the placement added', () => {
    const w = world((doc) => doc.placeEmpty(vec3(0, 0, 0), at(doc, 'T1/Base/Door')))
    const all = { expanded: new Set(Array.from({ length: w.doc.count() }, (_, i) => w.doc.pathOf(i))) }
    const door = rowsOf(w.doc, all).find((r) => r.index === at(w.doc, 'T1/Base/Door'))!
    expect(door.expandable).toBe(true)
  })
})

describe('the prefab grid: a prefab edited on its own', () => {
  // A second root would be lost: the prefab's file writes only its root.
  it('keeps one root: nothing can be moved beside it', () => {
    const doc = prefabDoc(tower(), DEFAULT_REGISTRY)
    const base = at(doc, 'Tower/Base')
    expect(doc.canReparent(base, null)).toBe(false)
  })
})
