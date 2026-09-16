import { buildDatabase, nameForPath, type AssetEntry, type AssetKind } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { ancestorsOf, buildTree, canMoveFolder, filterEntries, flattenTree, folderOf, gameRows, movedInto, renamedTo, subfoldersOf, type Filter } from './assetTree'

const entry = (path: string, kind: AssetKind): AssetEntry => ({ id: path, kind, path, name: nameForPath(path) })

const db = buildDatabase([
  entry('textures/stone/brick.png', 'texture'),
  entry('textures/stone/slab.png', 'texture'),
  entry('textures/wood/plank.png', 'texture'),
  entry('textures/loose.png', 'texture'),
  entry('props/crate.glb', 'model'),
  entry('materials/brick.mat.json', 'material'),
  entry('root.png', 'texture'),
])

const filter = (over: Partial<Filter> = {}): Filter => ({ folder: null, kind: null, search: '', recursive: false, ...over })

describe('folderOf', () => {
  it('is the directory part, and empty at the root', () => {
    expect(folderOf('textures/stone/brick.png')).toBe('textures/stone')
    expect(folderOf('root.png')).toBe('')
  })
})

describe('ancestorsOf', () => {
  it('lists every ancestor, root first, excluding itself', () => {
    expect(ancestorsOf('a/b/c')).toEqual(['', 'a', 'a/b'])
    expect(ancestorsOf('a')).toEqual([''])
    expect(ancestorsOf('')).toEqual([])
  })
})

describe('buildTree', () => {
  const root = buildTree(db)

  it('derives folders from paths rather than storing them', () => {
    expect(root.children.map((c) => c.name)).toEqual(['materials', 'props', 'textures'])
    expect(subfoldersOf(root, 'textures').map((c) => c.name)).toEqual(['stone', 'wood'])
  })

  it('counts only the files directly in a folder', () => {
    const textures = root.children.find((c) => c.name === 'textures')!
    expect(textures.fileCount, 'loose.png only; stone/ and wood/ are their own').toBe(1)
    expect(subfoldersOf(root, 'textures').find((c) => c.name === 'stone')!.fileCount).toBe(2)
    expect(root.fileCount, 'root.png').toBe(1)
  })

  it('records depth, so a panel can indent without recomputing it', () => {
    expect(root.depth).toBe(0)
    expect(subfoldersOf(root, 'textures')[0]!.depth).toBe(2)
  })

  // A path can only imply a folder that has something in it. A folder somebody just created has nothing.
  it('includes an empty folder that no path implies', () => {
    const withEmpty = buildTree(db, ['textures/metal', 'sfx'])
    expect(subfoldersOf(withEmpty, 'textures').map((c) => c.name)).toEqual(['metal', 'stone', 'wood'])
    expect(withEmpty.children.map((c) => c.name)).toContain('sfx')
    expect(subfoldersOf(withEmpty, 'textures').find((c) => c.name === 'metal')!.fileCount).toBe(0)
  })

  it('invents the intermediate folders of a deep empty path', () => {
    const deep = buildTree(buildDatabase([]), ['a/b/c'])
    expect(deep.children.map((c) => c.path)).toEqual(['a'])
    expect(subfoldersOf(deep, 'a/b').map((c) => c.path)).toEqual(['a/b/c'])
  })
})

describe('flattenTree', () => {
  it('is depth-first with parents before children', () => {
    expect(flattenTree(buildTree(db), new Set()).map((n) => n.path)).toEqual([
      '',
      'materials',
      'props',
      'textures',
      'textures/stone',
      'textures/wood',
    ])
  })

  it('stops at a collapsed folder but keeps its siblings', () => {
    expect(flattenTree(buildTree(db), new Set(['textures'])).map((n) => n.path)).toEqual(['', 'materials', 'props', 'textures'])
  })
})

describe('filterEntries', () => {
  it('shows one folder, not its subfolders, by default', () => {
    expect(filterEntries(db, filter({ folder: 'textures' })).map((e) => e.name)).toEqual(['loose'])
  })

  it('includes subfolders when asked', () => {
    expect(filterEntries(db, filter({ folder: 'textures', recursive: true })).map((e) => e.name)).toEqual([
      'brick',
      'loose',
      'plank',
      'slab',
    ])
  })

  // The two axes are independent: "textures in this folder" and "every material anywhere" are both real
  // questions, and a kind-as-tab panel can only answer the second.
  it('filters by kind across the whole database when no folder is chosen', () => {
    expect(filterEntries(db, filter({ kind: 'texture' })).map((e) => e.path)).toEqual([
      'textures/stone/brick.png',
      'textures/loose.png',
      'textures/wood/plank.png',
      'root.png',
      'textures/stone/slab.png',
    ])
  })

  it('combines folder and kind', () => {
    expect(filterEntries(db, filter({ folder: 'textures/stone', kind: 'texture' })).map((e) => e.name)).toEqual(['brick', 'slab'])
    expect(filterEntries(db, filter({ folder: 'textures/stone', kind: 'model' }))).toEqual([])
  })

  it('searches by name, case-insensitively', () => {
    expect(filterEntries(db, filter({ search: 'BRI' })).map((e) => e.path).sort()).toEqual([
      'materials/brick.mat.json',
      'textures/stone/brick.png',
    ])
  })

  it('shows the root folder only, not everything, when the root is selected', () => {
    expect(filterEntries(db, filter({ folder: '' })).map((e) => e.name)).toEqual(['root'])
  })
})

describe('canMoveFolder', () => {
  it('refuses a folder into itself or its own descendants', () => {
    expect(canMoveFolder('textures', 'textures')).toBe(false)
    expect(canMoveFolder('textures', 'textures/stone')).toBe(false)
  })

  it('refuses the root, which is not a movable thing', () => {
    expect(canMoveFolder('', 'textures')).toBe(false)
  })

  it('refuses a move to where it already is', () => {
    expect(canMoveFolder('textures/stone', 'textures')).toBe(false)
  })

  it('allows a real move, including up to the root', () => {
    expect(canMoveFolder('textures/stone', 'props')).toBe(true)
    expect(canMoveFolder('textures/stone', '')).toBe(true)
  })

  // The trap: a prefix match on the string, without the slash, would refuse this.
  it('is not fooled by a sibling whose name starts the same', () => {
    expect(canMoveFolder('textures', 'textures-old')).toBe(true)
  })
})

describe('movedInto / renamedTo', () => {
  it('keeps the name when moving, including to the root', () => {
    expect(movedInto('textures/stone/brick.png', 'props')).toBe('props/brick.png')
    expect(movedInto('textures/stone/brick.png', '')).toBe('brick.png')
  })

  it('keeps the folder when renaming, including at the root', () => {
    expect(renamedTo('textures/stone/brick.png', 'slab.png')).toBe('textures/stone/slab.png')
    expect(renamedTo('root.png', 'other.png')).toBe('other.png')
  })
})

describe('grouping levels under their games (ADR 0108)', () => {
  const GAMES = [
    { name: 'keyboard', label: 'Keyboard' },
    { name: 'parkour', label: 'Parkour' },
    { name: 'swing', label: 'Swing' },
  ]

  it('puts each level under its own game, games by label and default first', () => {
    const rows = gameRows(GAMES, [
      { name: 'parkour/level1', mode: 'parkour' },
      { name: 'keyboard/keyboard2', mode: 'keyboard' },
      { name: 'parkour/default', mode: 'parkour' },
      { name: 'keyboard/default', mode: 'keyboard' },
    ])
    expect(rows.map((r) => r.name)).toEqual(['keyboard', 'parkour', 'swing'])
    // Both games own a `default`, which is the whole point of the folders.
    expect(rows[0]!.levels.map((l) => l.name)).toEqual(['default', 'keyboard2'])
    expect(rows[1]!.levels.map((l) => l.name)).toEqual(['default', 'level1'])
  })

  it('keeps the qualified name, which is what opening one needs', () => {
    const rows = gameRows(GAMES, [{ name: 'swing/swing', mode: 'swing' }])
    expect(rows[2]!.levels).toEqual([{ qualified: 'swing/swing', name: 'swing' }])
  })

  it('still lists a game with no levels — that is where the first one is made', () => {
    expect(gameRows(GAMES, []).map((r) => r.levels.length)).toEqual([0, 0, 0])
  })

  it('falls back to the name prefix when the listing carries no mode', () => {
    expect(gameRows(GAMES, [{ name: 'keyboard/kb' }])[0]!.levels[0]!.name).toBe('kb')
  })

  it('drops a level whose game this build does not have, rather than inventing a row for it', () => {
    const rows = gameRows(GAMES, [{ name: 'oldgame/thing', mode: 'oldgame' }, { name: 'swing/swing', mode: 'swing' }])
    expect(rows.map((r) => r.name)).toEqual(['keyboard', 'parkour', 'swing'])
    expect(rows.flatMap((r) => r.levels).map((l) => l.qualified)).toEqual(['swing/swing'])
  })
})
