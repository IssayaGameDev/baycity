import { describe, expect, it } from 'vitest'

import { assetsUsedBy, levelsUsing, libraryRefusal, outOfLibrary, usersOf } from './usage'

/**
 * Which levels use which asset (ADR 0161): an id anywhere in a level is a reference, and so is every id in what it
 * uses — a prefab's materials, a material's textures.
 */

const PAD = 'aaaaaaaaaaaaaaaa'
const RED = 'bbbbbbbbbbbbbbbb'
const BRICK = 'cccccccccccccccc'
const CRATE = 'dddddddddddddddd'
const GLOW = 'eeeeeeeeeeeeeeee'
const LOOSE = 'ffffffffffffffff'

/** The files: a prefab drawn with a material that has a texture, and a material a game's own component names. */
const files: Record<string, unknown> = {
  [PAD]: { id: 'root', components: [{ id: 'r', type: 'Renderer', params: { model: CRATE, material: RED } }] },
  [RED]: { shader: 'standard', params: { map: { kind: 'texture', value: BRICK } } },
  [GLOW]: { shader: 'unlit', params: {} },
}
const known = new Set([PAD, RED, BRICK, CRATE, GLOW, LOOSE])
const isAssetId = (s: string): boolean => known.has(s)
const contentsOf = (id: string): unknown => files[id]

const level = (nodes: unknown[], extra: Record<string, unknown> = {}): unknown => ({ id: 'lv', config: {}, nodes, ...extra })

describe('what a level uses', () => {
  it('follows a placement to its prefab, the prefab to its material and model, the material to its texture', () => {
    const lv = level([{ id: 'p', prefab: PAD, components: [] }])
    expect([...assetsUsedBy(lv, isAssetId, contentsOf)].sort()).toEqual([PAD, RED, BRICK, CRATE].sort())
  })

  it('finds an id in any field — a game’s own component, which no shared list of fields knows', () => {
    const lv = level([{ id: 's', components: [{ id: 'c', type: 'StepPad', params: { activeMaterial: GLOW, perStep: 2 } }] }])
    expect([...assetsUsedBy(lv, isAssetId, contentsOf)]).toEqual([GLOW])
  })

  it('counts values, not keys, and nothing that is not a known id', () => {
    // A frozen copy's table is keyed by its prefab's id; with no placement naming it, nothing uses the prefab.
    const lv = level([{ id: 'n', name: 'Obstacle 1', components: [] }], { prefabs: { [PAD]: { id: 'root', components: [] } } })
    expect([...assetsUsedBy(lv, isAssetId, contentsOf)]).toEqual([])
  })

  it('walks what a frozen copy draws with', () => {
    const lv = level([], { prefabs: { [PAD]: { id: 'root', components: [{ id: 'r', type: 'Renderer', params: { material: GLOW } }] } } })
    expect([...assetsUsedBy(lv, isAssetId, contentsOf)]).toEqual([GLOW])
  })

  it('stops at a loop rather than walking it for ever', () => {
    const loop: Record<string, unknown> = { [PAD]: { ref: RED }, [RED]: { ref: PAD } }
    expect([...assetsUsedBy({ uses: PAD }, isAssetId, (id) => loop[id])].sort()).toEqual([PAD, RED].sort())
  })
})

describe('which levels use an asset', () => {
  it('names every level using it, directly or through something else, and leaves out what nobody uses', () => {
    const usage = levelsUsing(
      [
        ['parkour/b', level([{ id: 'p', prefab: PAD, components: [] }])],
        ['keyboard/a', level([{ id: 'm', components: [{ id: 'r', type: 'Renderer', params: { material: RED } }] }])],
      ],
      isAssetId,
      contentsOf,
    )
    expect(usage.get(RED), 'placed through the prefab in one, named outright in the other').toEqual(['keyboard/a', 'parkour/b'])
    expect(usage.get(BRICK)).toEqual(['keyboard/a', 'parkour/b'])
    expect(usage.get(CRATE)).toEqual(['parkour/b'])
    expect(usage.has(LOOSE)).toBe(false)
  })
})

describe('who uses an asset (ADR 0165)', () => {
  it('names the levels and the assets using it, directly or through what they use, sorted', () => {
    const levels = [
      ['kb/b', level([{ id: 'n', prefab: PAD, transform: { position: { x: 0, y: 0, z: 0 } }, components: [] }])],
      ['kb/a', level([{ id: 'm', transform: { position: { x: 0, y: 0, z: 0 } }, components: [{ id: 'c', type: 'Renderer', params: { material: RED } }] }])],
      ['kb/c', level([])],
    ] as const
    const assets = Object.entries(files)
    expect(usersOf(BRICK, levels, assets, isAssetId, contentsOf)).toEqual({ levels: ['kb/a', 'kb/b'], assets: [PAD, RED] })
    expect(usersOf(PAD, levels, assets, isAssetId, contentsOf)).toEqual({ levels: ['kb/b'], assets: [] })
    expect(usersOf(LOOSE, levels, assets, isAssetId, contentsOf)).toEqual({ levels: [], assets: [] })
  })
})

/** The rule every write is refused by (ADR 0161, ADR 0218): what something of `user`'s uses and may not. */
describe('what something uses out of its libraries', () => {
  const PATHS: Record<string, string> = {
    [PAD]: 'assets/prefabs/Pad.prefab.json',
    [RED]: 'assets/materials/Red.mat.json',
    [BRICK]: 'keyboard/assets/textures/brick.png',
    [CRATE]: 'assets/models/crate.glb',
    [GLOW]: 'racing/assets/materials/Glow.mat.json',
  }
  const pathOf = (id: string): string | undefined => PATHS[id]
  const drawn = (material: string): unknown => ({ id: 'n', components: [{ id: 'r', type: 'Renderer', params: { material } }] })

  it('finds a game’s asset in Shared’s, through what it uses', () => {
    expect(outOfLibrary(null, drawn(RED), isAssetId, contentsOf, pathOf), 'its texture is Keyboard’s').toEqual(['keyboard/assets/textures/brick.png'])
    expect(outOfLibrary('keyboard', drawn(RED), isAssetId, contentsOf, pathOf), 'Keyboard may').toEqual([])
    expect(outOfLibrary('keyboard', drawn(GLOW), isAssetId, contentsOf, pathOf), 'another game’s').toEqual(['racing/assets/materials/Glow.mat.json'])
  })

  it('says why, naming what it uses, a few at most', () => {
    expect(libraryRefusal(null, [])).toBeNull()
    expect(libraryRefusal(null, ['keyboard/assets/textures/brick.png'])).toBe("Shared uses only Shared’s assets, and this uses keyboard's brick.png")
    expect(libraryRefusal('keyboard', ['racing/assets/materials/Glow.mat.json'])).toBe("keyboard uses only its own assets and Shared’s, and this uses racing's Glow.mat.json")
    expect(libraryRefusal(null, ['a/assets/1', 'a/assets/2', 'a/assets/3', 'a/assets/4', 'a/assets/5'])).toBe("Shared uses only Shared’s assets, and this uses a's 1, a's 2, a's 3 and 2 more")
  })
})
