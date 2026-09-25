// @vitest-environment happy-dom
import type { AssetEntry, Level, Node, UnlinkDeps } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { deletedBy, deleteWording, severalWording, unlinkedLevel } from './fileActions'

/**
 * What deleting takes with it (ADR 0097): a prefab is unlinked from every placement first, and a folder is every
 * prefab in it — deleting one used to remove its prefabs as plain files, leaving placements that drew nothing.
 */

const asset = (path: string, kind: AssetEntry['kind'], id = path): AssetEntry => ({ id, kind, path, name: path.slice(path.lastIndexOf('/') + 1).replace(/\..*$/, '') })
const LIBRARY = [
  asset('materials/brick.mat.json', 'material'),
  asset('prefabs/Basic/pad.prefab.json', 'prefab'),
  asset('prefabs/Basic/ramp.prefab.json', 'prefab'),
  asset('prefabs/Basic/wood.png', 'texture'),
  asset('prefabs/Basic-old/door.prefab.json', 'prefab'),
]

describe('what a delete covers', () => {
  it('is the file alone for a file, and a prefab only when it is one', () => {
    expect(deletedBy(LIBRARY, 'materials/brick.mat.json')).toEqual({ name: 'brick', folder: false, inside: 0, prefabs: [] })
    expect(deletedBy(LIBRARY, 'prefabs/Basic/pad.prefab.json').prefabs.map((p) => p.name)).toEqual(['pad'])
  })

  it('is everything under a folder, its prefabs among it, and not a folder that only starts the same', () => {
    const covered = deletedBy(LIBRARY, 'prefabs/Basic')
    expect(covered).toMatchObject({ name: 'Basic', folder: true, inside: 3 })
    expect(covered.prefabs.map((p) => p.name)).toEqual(['pad', 'ramp'])
    expect(deletedBy(LIBRARY, 'prefabs').prefabs, 'deeper folders too').toHaveLength(3)
  })
})

describe('a level file the delete rewrites', () => {
  const at = (x: number): Node['transform'] => ({ position: { x, y: 0, z: 0 } })
  const prefab = (name: string): Node => ({ id: 'root', name, transform: at(0), components: [], children: [{ id: 'piece', transform: at(1), components: [] }] })
  const source = { root: (id: string): Node | undefined => (id === 'GONE' || id === 'KEPT' ? prefab(id) : undefined) }
  const deps: UnlinkDeps = { types: { get: () => undefined }, freshId: (() => { let n = 0; return () => `n${++n}` })(), refKeysOf: () => [] }
  const file = (): Level => ({
    id: 'lv',
    config: {},
    nodes: [
      { id: 'a', transform: at(0), components: [], prefab: 'GONE' },
      { id: 'b', transform: at(5), components: [], prefab: 'KEPT' },
    ],
  })

  it('unlinks the deleted prefab and leaves every other one a reference, with no copy of it in the file', () => {
    const out = unlinkedLevel(file(), ['GONE'], source, deps)!
    expect(out.nodes[0]!.prefab, 'unlinked').toBeUndefined()
    expect(out.nodes[0]!.children?.length, 'keeps what it drew').toBe(1)
    expect(out.nodes[1]!.prefab, 'still a reference').toBe('KEPT')
    expect(out.prefabs, 'no frozen copy of KEPT, nor of GONE').toBeUndefined()
  })

  it('keeps a table the level carried of its own, and leaves a level placing none of them alone', () => {
    const own = prefab('own copy')
    const level: Level = { ...file(), prefabs: { KEPT: own } }
    expect(unlinkedLevel(level, ['GONE'], source, deps)!.prefabs).toEqual({ KEPT: own })
    expect(unlinkedLevel(file(), ['ELSEWHERE'], source, deps)).toBeNull()
  })
})

describe('what the delete asks', () => {
  it('says the same as before for one prefab', () => {
    const one = deletedBy(LIBRARY, 'prefabs/Basic/pad.prefab.json')
    expect(deleteWording(one, 0, []).body).toBe('Nothing places it. The file and its id go for good — a prefab created again later gets a new id.')
    expect(deleteWording(one, 2, ['keyboard/keyboard2'])).toEqual({
      title: 'Delete pad?',
      body: 'Used by 2 in this level and 1 other level (keyboard/keyboard2). Those objects stay where they are and keep what they are drawing; they just stop being copies of this prefab. The file and its id go for good.',
    })
  })

  it('names a folder’s prefabs and what places them', () => {
    const folder = deletedBy(LIBRARY, 'prefabs/Basic')
    expect(deleteWording(folder, 0, ['keyboard/default', 'parkour/level1'])).toEqual({
      title: 'Delete Basic and the 3 assets in it?',
      body: 'It holds 2 prefabs: pad, ramp. Used by 2 other levels (keyboard/default, parkour/level1). Those objects stay where they are and keep what they are drawing; they just stop being copies of those prefabs. The files and their ids go for good.',
    })
    expect(deleteWording(deletedBy(LIBRARY, 'prefabs/Basic-old'), 0, []).body).toBe('It holds the prefab door. Nothing places it. The files and their ids go for good.')
  })
})

describe('deleting several at once (ADR 0166)', () => {
  it('asks once: how many, the files going, and what becomes of placed prefabs among them', () => {
    expect(severalWording(3, 5, 0, 0, [])).toEqual({ title: 'Delete 3 items?', body: '5 assets and their ids go for good.' })
    expect(severalWording(2, 2, 1, 2, ['kb/a'])).toEqual({
      title: 'Delete 2 items?',
      body: '2 assets and their ids go for good. A prefab among them is used by 2 in this level and 1 other level (kb/a): those objects stay where they are and keep what they are drawing; they just stop being copies.',
    })
  })
})
