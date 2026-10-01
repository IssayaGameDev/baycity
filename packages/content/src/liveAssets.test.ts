import { describe, expect, it } from 'vitest'

import { applyAssetOps, diffAssetOps, gameDocId, gameOfDocId, isAssetOp, isLiveAssetPath, LiveAssetError, mergeAssetOps, validateLiveAsset, type AssetOp } from './liveAssets'

/**
 * A data-file asset's ops (ADR 0159): set a value at a path, or remove it — nothing about what the file means —
 * with an inverse for every one, and the diff that turns one version into another.
 */

const red = { shader: 'standard', params: { color: { kind: 'color', value: '#ff0000' }, roughness: { kind: 'number', value: 0.5 } } }

describe('applying ops', () => {
  it('sets and removes by path, on a copy, with inverses that undo it in reverse', () => {
    const ops: AssetOp[] = [
      { kind: 'set', path: ['params', 'color', 'value'], value: '#00ff00' },
      { kind: 'unset', path: ['params', 'roughness'] },
      { kind: 'set', path: ['params', 'metalness'], value: { kind: 'number', value: 1 } },
    ]
    const { json, inverses } = applyAssetOps(red, ops)
    expect(json).toEqual({ shader: 'standard', params: { color: { kind: 'color', value: '#00ff00' }, metalness: { kind: 'number', value: 1 } } })
    expect(red.params.color.value, 'the original is untouched').toBe('#ff0000')
    expect(applyAssetOps(json, [...inverses].reverse()).json).toEqual(red)
  })

  it('removing what is not there changes nothing, and undoes to nothing', () => {
    const { json, inverses } = applyAssetOps(red, [{ kind: 'unset', path: ['params', 'nope', 'deeper'] }])
    expect(json).toEqual(red)
    expect(applyAssetOps(json, inverses).json).toEqual(red)
  })

  it('refuses a path through something that is not an object', () => {
    expect(() => applyAssetOps(red, [{ kind: 'set', path: ['shader', 'x'], value: 1 }])).toThrow(LiveAssetError)
    expect(() => applyAssetOps(red, [{ kind: 'set', path: [], value: 1 }])).toThrow(LiveAssetError)
  })
})

describe('the diff between two versions', () => {
  it('is the ops that turn one into the other, and nothing for the same', () => {
    const after = { shader: 'standard', params: { color: { kind: 'color', value: '#123456' } } }
    const ops = diffAssetOps(red, after)
    expect(ops).toEqual([
      { kind: 'set', path: ['params', 'color', 'value'], value: '#123456' },
      { kind: 'unset', path: ['params', 'roughness'] },
    ])
    expect(applyAssetOps(red, ops).json).toEqual(after)
    expect(diffAssetOps(red, structuredClone(red))).toEqual([])
  })

  it('sets an array or a changed type whole', () => {
    expect(diffAssetOps({ a: [1, 2] }, { a: [1, 3] })).toEqual([{ kind: 'set', path: ['a'], value: [1, 3] }])
    expect(diffAssetOps({ a: 1 }, { a: { b: 2 } })).toEqual([{ kind: 'set', path: ['a'], value: { b: 2 } }])
  })
})

describe('merging two lists of ops', () => {
  it('keeps the newest per path and does what applying both in order does', () => {
    const first: AssetOp[] = [
      { kind: 'set', path: ['params', 'color', 'value'], value: '#111111' },
      { kind: 'set', path: ['params', 'roughness', 'value'], value: 0.2 },
    ]
    const then: AssetOp[] = [
      { kind: 'set', path: ['params', 'color'], value: { kind: 'color', value: '#222222' } },
      { kind: 'set', path: ['params', 'roughness', 'value'], value: 0.4 },
    ]
    const merged = mergeAssetOps(first, then)
    expect(merged, 'the colour value is under the colour replaced').toHaveLength(2)
    expect(applyAssetOps(red, merged).json).toEqual(applyAssetOps(applyAssetOps(red, first).json, then).json)
  })
})

describe('what is live, and what a material must be', () => {
  it('knows its kinds by path', () => {
    expect(isLiveAssetPath('materials/brick.mat.json')).toBe(true)
    expect(isLiveAssetPath('prefabs/pad.prefab.json'), 'a prefab is its own kind of document').toBe(false)
    expect(isLiveAssetPath('textures/t.png')).toBe(false)
  })

  it('accepts a material and names what is wrong with one that is not', () => {
    expect(validateLiveAsset('material', red)).toBeNull()
    expect(validateLiveAsset('material', { params: {} })).toMatch(/shader/)
    expect(validateLiveAsset('material', { shader: 'standard', params: { color: '#fff' } })).toMatch(/color/)
    expect(validateLiveAsset('texture', {})).toMatch(/not a live asset/)
  })

  it('accepts a game’s data file (ADR 0162): its components by name, its settings numbers or curve points', () => {
    expect(validateLiveAsset('game', { components: ['Hazard'] })).toBeNull()
    expect(validateLiveAsset('game', { components: [], settings: { keyPitch: 1, speed: [{ x: 0, y: 10 }] } })).toBeNull()
    expect(validateLiveAsset('game', { settings: {} })).toMatch(/components/)
    expect(validateLiveAsset('game', { components: [], settings: { keyPitch: '1' } })).toMatch(/keyPitch/)
    expect(validateLiveAsset('game', { components: [], settings: { speed: [{ x: 0 }] } })).toMatch(/speed/)
    expect([gameDocId('keyboard'), gameOfDocId('game:keyboard'), gameOfDocId('0123456789abcdef')]).toEqual(['game:keyboard', 'keyboard', null])
  })

  it('takes a data asset as a live document by its shape alone (ADR 0181): the server has no game’s code', () => {
    expect(isLiveAssetPath('keyboard/assets/red.data.json')).toBe(true)
    expect(validateLiveAsset('data', { type: 'KeyboardStyle', fields: { placeholder: '#ffffff' } })).toBeNull()
    expect(validateLiveAsset('data', { fields: {} })).toMatch(/type/)
  })

  it('checks ops off the wire', () => {
    expect(isAssetOp({ kind: 'set', path: ['a'], value: null })).toBe(true)
    expect(isAssetOp({ kind: 'unset', path: ['a'] })).toBe(true)
    expect(isAssetOp({ kind: 'set', path: ['a'] })).toBe(false)
    expect(isAssetOp({ kind: 'set', path: [1], value: 1 })).toBe(false)
  })
})
