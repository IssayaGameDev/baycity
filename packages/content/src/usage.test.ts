import { describe, expect, it } from 'vitest'

import { assetsUsedBy, levelsUsing } from './usage'

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
