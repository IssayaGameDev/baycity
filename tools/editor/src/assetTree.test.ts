import { buildDatabase, nameForPath, type AssetEntry, type AssetKind } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { ancestorsOf, buildTree, canMoveFolder, filterEntries, flattenTree, folderOf, gameRows, movedInto, renamedTo, subfoldersOf, type Filter } from './assetTree'

/** Paths from `content/`, starting with their library (ADR 0161): the shared one, and one entry in a game's own. */
const entry = (path: string, kind: AssetKind): AssetEntry => ({ id: path, kind, path, name: nameForPath(path) })

const db = buildDatabase([
  entry('assets/textures/stone/brick.png', 'texture'),
  entry('assets/textures/stone/slab.png', 'texture'),
  entry('assets/textures/wood/plank.png', 'texture'),
  entry('assets/textures/loose.png', 'texture'),
  entry('assets/props/crate.glb', 'model'),
  entry('assets/materials/brick.mat.json', 'material'),
  entry('assets/root.png', 'texture'),
  entry('keyboard/assets/textures/key.png', 'texture'),
])

const filter = (over: Partial<Filter> = {}): Filter => ({ libraries: ['assets'], folder: null, kind: null, search: '', ...over })

describe('folderOf', () => {
  it('is the directory part, the library’s own folder at the top', () => {
    expect(folderOf('assets/textures/stone/brick.png')).toBe('assets/textures/stone')
    expect(folderOf('assets/root.png')).toBe('assets')
  })
})

describe('ancestorsOf', () => {
  it('lists every ancestor down from the library, root first, excluding itself', () => {
    expect(ancestorsOf('assets/a/b/c')).toEqual(['assets', 'assets/a', 'assets/a/b'])
    expect(ancestorsOf('assets/a')).toEqual(['assets'])
    expect(ancestorsOf('assets')).toEqual([])
    expect(ancestorsOf('keyboard/assets/a', 'keyboard/assets')).toEqual(['keyboard/assets'])
    expect(ancestorsOf('keyboard/assets/a'), 'outside the library asked about').toEqual([])
  })
})

describe('buildTree', () => {
  const root = buildTree(db)

  it('derives folders from paths rather than storing them', () => {
    expect(root.path).toBe('assets')
    expect(root.children.map((c) => c.name)).toEqual(['materials', 'props', 'textures'])
    expect(subfoldersOf(root, 'assets/textures').map((c) => c.name)).toEqual(['stone', 'wood'])
  })

  it('draws one library: another’s files are not in it', () => {
    const keyboard = buildTree(db, [], 'keyboard/assets')
    expect(keyboard.name).toBe('keyboard assets')
    expect(flattenTree(keyboard, new Set()).map((n) => n.path)).toEqual(['keyboard/assets', 'keyboard/assets/textures'])
    expect(flattenTree(root, new Set()).some((n) => n.path.startsWith('keyboard/'))).toBe(false)
  })

  it('counts only the files directly in a folder', () => {
    const textures = root.children.find((c) => c.name === 'textures')!
    expect(textures.fileCount, 'loose.png only; stone/ and wood/ are their own').toBe(1)
    expect(subfoldersOf(root, 'assets/textures').find((c) => c.name === 'stone')!.fileCount).toBe(2)
    expect(root.fileCount, 'root.png').toBe(1)
  })

  it('records depth from the library, so a panel can indent without recomputing it', () => {
    expect(root.depth).toBe(0)
    expect(subfoldersOf(root, 'assets/textures')[0]!.depth).toBe(2)
  })

  // A path can only imply a folder that has something in it. A folder somebody just created has nothing.
  it('includes an empty folder that no path implies', () => {
    const withEmpty = buildTree(db, ['assets/textures/metal', 'assets/sfx', 'keyboard/assets/other'])
    expect(subfoldersOf(withEmpty, 'assets/textures').map((c) => c.name)).toEqual(['metal', 'stone', 'wood'])
    expect(withEmpty.children.map((c) => c.name)).toContain('sfx')
    expect(withEmpty.children.map((c) => c.name), 'another library’s folder').not.toContain('other')
    expect(subfoldersOf(withEmpty, 'assets/textures').find((c) => c.name === 'metal')!.fileCount).toBe(0)
  })

  it('invents the intermediate folders of a deep empty path', () => {
    const deep = buildTree(buildDatabase([]), ['assets/a/b/c'])
    expect(deep.children.map((c) => c.path)).toEqual(['assets/a'])
    expect(subfoldersOf(deep, 'assets/a/b').map((c) => c.path)).toEqual(['assets/a/b/c'])
  })
})

describe('flattenTree', () => {
  it('is depth-first with parents before children', () => {
    expect(flattenTree(buildTree(db), new Set()).map((n) => n.path)).toEqual([
      'assets',
      'assets/materials',
      'assets/props',
      'assets/textures',
      'assets/textures/stone',
      'assets/textures/wood',
    ])
  })

  it('stops at a collapsed folder but keeps its siblings', () => {
    expect(flattenTree(buildTree(db), new Set(['assets/textures'])).map((n) => n.path)).toEqual(['assets', 'assets/materials', 'assets/props', 'assets/textures'])
  })
})

describe('filterEntries', () => {
  it('shows one folder, not its subfolders', () => {
    expect(filterEntries(db, filter({ folder: 'assets/textures' })).map((e) => e.name)).toEqual(['loose'])
  })

  it('looks in every folder of every library it is given when no folder is chosen: a search', () => {
    expect(filterEntries(db, filter({ libraries: ['keyboard/assets', 'assets'], kind: 'texture' })).map((e) => e.name)).toEqual([
      'brick',
      'key',
      'loose',
      'plank',
      'root',
      'slab',
    ])
  })

  it('filters by kind across the whole library when no folder is chosen, and no further', () => {
    expect(filterEntries(db, filter({ kind: 'texture' })).map((e) => e.path)).toEqual([
      'assets/textures/stone/brick.png',
      'assets/textures/loose.png',
      'assets/textures/wood/plank.png',
      'assets/root.png',
      'assets/textures/stone/slab.png',
    ])
    expect(filterEntries(db, filter({ libraries: ['keyboard/assets'], kind: 'texture' })).map((e) => e.name)).toEqual(['key'])
  })

  it('combines folder and kind', () => {
    expect(filterEntries(db, filter({ folder: 'assets/textures/stone', kind: 'texture' })).map((e) => e.name)).toEqual(['brick', 'slab'])
    expect(filterEntries(db, filter({ folder: 'assets/textures/stone', kind: 'model' }))).toEqual([])
  })

  it('searches by name, case-insensitively', () => {
    expect(filterEntries(db, filter({ search: 'BRI' })).map((e) => e.path).sort()).toEqual([
      'assets/materials/brick.mat.json',
      'assets/textures/stone/brick.png',
    ])
  })

  it('shows the library’s top folder only, not everything, when that is selected', () => {
    expect(filterEntries(db, filter({ folder: 'assets' })).map((e) => e.name)).toEqual(['root'])
  })
})

describe('canMoveFolder', () => {
  it('refuses a folder into itself or its own descendants', () => {
    expect(canMoveFolder('assets/textures', 'assets/textures')).toBe(false)
    expect(canMoveFolder('assets/textures', 'assets/textures/stone')).toBe(false)
  })

  it('refuses a library’s own folder, which is not a movable thing', () => {
    expect(canMoveFolder('assets', 'assets/textures')).toBe(false)
    expect(canMoveFolder('keyboard/assets', 'assets/textures')).toBe(false)
  })

  it('refuses a move to where it already is', () => {
    expect(canMoveFolder('assets/textures/stone', 'assets/textures')).toBe(false)
  })

  it('allows a real move, including up to the library’s top', () => {
    expect(canMoveFolder('assets/textures/stone', 'assets/props')).toBe(true)
    expect(canMoveFolder('assets/textures/stone', 'assets')).toBe(true)
  })

  // The trap: a prefix match on the string, without the slash, would refuse this.
  it('is not fooled by a sibling whose name starts the same', () => {
    expect(canMoveFolder('assets/textures', 'assets/textures-old')).toBe(true)
  })
})

describe('movedInto / renamedTo', () => {
  it('keeps the name when moving, including to the library’s top', () => {
    expect(movedInto('assets/textures/stone/brick.png', 'assets/props')).toBe('assets/props/brick.png')
    expect(movedInto('assets/textures/stone/brick.png', 'assets')).toBe('assets/brick.png')
  })

  it('keeps the folder when renaming, including at the library’s top', () => {
    expect(renamedTo('assets/textures/stone/brick.png', 'slab.png')).toBe('assets/textures/stone/slab.png')
    expect(renamedTo('assets/root.png', 'other.png')).toBe('assets/other.png')
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
