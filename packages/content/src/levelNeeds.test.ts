import { describe, expect, it } from 'vitest'

import type { AssetKind } from './assets'
import { levelIndexFile, levelIndexOf, levelNeeds, levelNeedsFile, levelOfNeedsFile, type ContentCatalog } from './levelNeeds'

/**
 * What a page downloads to play one level (ADR 0169): the level's own list, through its prefabs and materials,
 * never another game's library, and the index that picks the level.
 */

const PAD = 'aaaaaaaaaaaaaaaa'
const RED = 'bbbbbbbbbbbbbbbb'
const BRICK = 'cccccccccccccccc'
const CRATE = 'dddddddddddddddd'
const SKY = 'eeeeeeeeeeeeeeee'
const THEIRS = 'ffffffffffffffff'
const UNUSED = '1111111111111111'

const assets: Record<string, { kind: AssetKind; path: string; json?: unknown }> = {
  [PAD]: { kind: 'prefab', path: 'assets/prefabs/pad.prefab.json', json: { id: 'root', components: [{ id: 'r', type: 'Renderer', params: { model: CRATE, material: RED } }] } },
  [RED]: { kind: 'material', path: 'keyboard/assets/materials/red.mat.json', json: { shader: 'standard', params: { map: { kind: 'texture', value: BRICK } } } },
  [BRICK]: { kind: 'texture', path: 'assets/textures/brick.png' },
  [CRATE]: { kind: 'model', path: 'assets/models/crate.glb' },
  [SKY]: { kind: 'texture', path: 'assets/textures/sky.webp' },
  [THEIRS]: { kind: 'material', path: 'parkour/assets/materials/theirs.mat.json', json: { shader: 'standard', params: {} } },
  [UNUSED]: { kind: 'texture', path: 'assets/textures/unused.png' },
}

const catalog: ContentCatalog = {
  byId: (id) => assets[id],
  byPath: (path) => {
    const id = Object.keys(assets).find((k) => assets[k]?.path === path)
    return id === undefined ? undefined : { id }
  },
  contentsOf: (id) => assets[id]?.json,
}

const level = (nodes: unknown[]): unknown => ({ id: 'lv', config: {}, nodes })
const at = (path: string): string => `content/${path}`
const KEYBOARD_ONE = { game: 'keyboard', name: 'one' }

describe('a level’s list', () => {
  it('names the level and everything it uses through its prefab and material, and nothing else', () => {
    const needs = levelNeeds(KEYBOARD_ONE, level([{ id: 'p', prefab: PAD, components: [] }]), catalog, [], at)
    expect(needs.level).toBe('content/keyboard/levels/one.level.json')
    // By path: Shared's models, prefabs, textures, then the game's own library.
    expect(needs.assets.map((a) => a.id)).toEqual([CRATE, PAD, BRICK, RED])
    expect(needs.assets.find((a) => a.id === RED)).toEqual({ id: RED, kind: 'material', path: 'keyboard/assets/materials/red.mat.json', url: 'content/keyboard/assets/materials/red.mat.json' })
  })

  it('leaves out what another game’s library holds, even when the level names it', () => {
    const needs = levelNeeds(KEYBOARD_ONE, level([{ id: 'n', components: [{ id: 'c', type: 'Renderer', params: { material: THEIRS } }] }]), catalog, [], at)
    expect(needs.assets).toEqual([])
  })

  it('adds what the game’s own code loads by path, which no level names', () => {
    const needs = levelNeeds(KEYBOARD_ONE, level([]), catalog, ['assets/textures/sky.webp', 'assets/textures/not-there.png'], at)
    expect(needs.assets.map((a) => a.id)).toEqual([SKY])
  })

  it('writes each address with the server’s own mapping', () => {
    const needs = levelNeeds(KEYBOARD_ONE, level([{ id: 'n', components: [{ id: 'c', type: 'Renderer', params: { model: CRATE } }] }]), catalog, [], (p) => `assets/${p.split('/').pop()}`)
    expect(needs.level).toBe('assets/one.level.json')
    expect(needs.assets[0]?.url).toBe('assets/crate.glb')
  })
})

describe('the level index', () => {
  it('puts default first and the default is default', () => {
    expect(levelIndexOf(['b', 'default', 'a'])).toEqual({ levels: ['default', 'a', 'b'], default: 'default' })
  })

  it('falls back to the first level when there is no default', () => {
    expect(levelIndexOf(['swing'])).toEqual({ levels: ['swing'], default: 'swing' })
  })

  it('still names a default for a game with no levels, so asking fails by name', () => {
    expect(levelIndexOf([])).toEqual({ levels: [], default: 'default' })
  })
})

describe('where they are', () => {
  it('sits the index beside the levels folder and the list beside the level', () => {
    expect(levelIndexFile('keyboard')).toBe('keyboard/levels.json')
    expect(levelNeedsFile(KEYBOARD_ONE)).toBe('keyboard/levels/one.needs.json')
  })

  it('reads a list’s path back, and nothing that is not one', () => {
    expect(levelOfNeedsFile('keyboard/levels/one.needs.json')).toEqual(KEYBOARD_ONE)
    for (const path of ['keyboard/levels/one.level.json', 'keyboard/one.needs.json', 'assets/levels/one.needs.json', 'keyboard/levels/../one.needs.json']) {
      expect(levelOfNeedsFile(path), path).toBeNull()
    }
  })
})
