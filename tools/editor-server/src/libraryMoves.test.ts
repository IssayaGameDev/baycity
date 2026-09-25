import { describe, expect, it } from 'vitest'

import type { AssetEntry } from '../../../packages/content/src/assets'
import { moveRefusal, type LibraryWorld } from './libraryMoves'

/**
 * Moving assets between libraries (ADR 0161): a level uses its own game's assets and Shared's, so a move is refused
 * when something would be left using what it may not, or needing what it cannot reach.
 */

const entry = (id: string, kind: AssetEntry['kind'], path: string): AssetEntry => ({ id, kind, path, name: path.slice(path.lastIndexOf('/') + 1).replace(/\..*$/, '') })

const PAD = 'aaaaaaaaaaaaaaaa'
const RED = 'bbbbbbbbbbbbbbbb'
const BRICK = 'cccccccccccccccc'
const KEY = 'dddddddddddddddd'

const world = (entries: AssetEntry[], files: Record<string, unknown>, levels: [string, unknown][]): LibraryWorld => ({
  entries,
  levels,
  contentsOf: (id) => files[id],
})
const placing = (prefab: string): unknown => ({ id: 'lv', config: {}, nodes: [{ id: 'p', prefab, components: [] }] })
const drawnWith = (material: string): unknown => ({ id: 'root', components: [{ id: 'r', type: 'Renderer', params: { material } }] })

describe('moving assets between libraries', () => {
  const pad = entry(PAD, 'prefab', 'assets/prefabs/pad.prefab.json')
  const red = entry(RED, 'material', 'assets/materials/red.mat.json')
  const brick = entry(BRICK, 'texture', 'assets/textures/brick.png')
  const files = { [PAD]: drawnWith(RED), [RED]: { shader: 'standard', params: { map: { kind: 'texture', value: BRICK } } } }

  it('lets a game take what only its own levels use', () => {
    const w = world([pad, red, brick], files, [['keyboard/a', placing(PAD)]])
    expect(moveRefusal([pad], 'keyboard', w)).toBeNull()
  })

  it('refuses while another game’s level uses it, directly or through a prefab — and says how many', () => {
    const w = world([pad, red, brick], files, [
      ['keyboard/a', placing(PAD)],
      ['parkour/b', placing(PAD)],
      ['parkour/c', placing(PAD)],
      ['swing/d', placing(PAD)],
    ])
    expect(moveRefusal([pad], 'keyboard', w)).toBe('used by 2 parkour levels and 1 swing level')
    expect(moveRefusal([brick], 'keyboard', w), 'the texture, through the prefab’s material').toBe('used by 2 parkour levels and 1 swing level')
  })

  it('refuses while a Shared asset uses it: Shared is anyone’s, so it may use only Shared', () => {
    const w = world([pad, red, brick], files, [])
    expect(moveRefusal([brick], 'keyboard', w)).toBe("used by Shared's material red and Shared's prefab pad")
  })

  it('refuses leaving behind what it needs in another game’s library, unless that moves too', () => {
    const key = entry(KEY, 'texture', 'keyboard/assets/textures/key.png')
    const own = entry(RED, 'material', 'keyboard/assets/materials/red.mat.json')
    const w = world([own, key], { [RED]: { shader: 'standard', params: { map: { kind: 'texture', value: KEY } } } }, [])
    expect(moveRefusal([own], null, w)).toBe("uses keyboard's texture key: move it too, or into Shared first")
    expect(moveRefusal([own, key], null, w), 'both at once, as a folder').toBeNull()
  })

  it('always lets something go to Shared that uses only Shared', () => {
    const own = entry(PAD, 'prefab', 'keyboard/assets/prefabs/pad.prefab.json')
    const w = world([own, red, brick], files, [['parkour/b', placing(PAD)]])
    expect(moveRefusal([own], null, w)).toBeNull()
  })
})
