import { describe, expect, it } from 'vitest'

import {
  assetsOfKind,
  buildDatabase,
  isAnimationAsset,
  kindForPath,
  materialDependencies,
  nameForPath,
} from './assets'
import type { AssetEntry, MaterialAsset } from './assets'

const entry = (id: string, kind: AssetEntry['kind'], path: string): AssetEntry => ({
  id,
  kind,
  path,
  name: nameForPath(path),
})

describe('kindForPath', () => {
  it('recognises each kind by extension, case-insensitively', () => {
    expect(kindForPath('textures/brick.png')).toBe('texture')
    expect(kindForPath('textures/BRICK.PNG')).toBe('texture')
    expect(kindForPath('props/crate.glb')).toBe('model')
    expect(kindForPath('props/crate.gltf')).toBe('model')
    expect(kindForPath('sfx/jump.wav')).toBe('sound')
    expect(kindForPath('ui/Inter.ttf')).toBe('font')
  })

  // Compound extensions rather than a magic folder, so a file keeps its kind wherever it is moved.
  it('recognises materials, shaders and clips by compound extension, at any path', () => {
    expect(kindForPath('materials/brick.mat.json')).toBe('material')
    expect(kindForPath('anywhere/deep/brick.mat.json')).toBe('material')
    expect(kindForPath('shaders/water.shader.json')).toBe('shader')
    expect(kindForPath('animations/rise-4m.anim.json')).toBe('animation')
  })

  it('is not fooled by a plain .json, which is a level or a prefab', () => {
    expect(kindForPath('something.json')).toBeUndefined()
  })

  it('ignores sidecars, or the importer would try to give ids ids', () => {
    expect(kindForPath('textures/brick.png.meta')).toBeUndefined()
  })

  it('ignores anything else', () => {
    expect(kindForPath('README.md')).toBeUndefined()
    expect(kindForPath('LICENSE')).toBeUndefined()
    expect(kindForPath('textures/')).toBeUndefined()
  })
})

describe('nameForPath', () => {
  it('strips the directory and the extension', () => {
    expect(nameForPath('textures/stone/brick_01.png')).toBe('brick_01')
  })

  it('strips a compound extension whole', () => {
    expect(nameForPath('materials/brick.mat.json'), 'not "brick.mat"').toBe('brick')
    expect(nameForPath('shaders/water.shader.json')).toBe('water')
    expect(nameForPath('animations/rise-4m.anim.json'), 'not "rise-4m.anim"').toBe('rise-4m')
  })

  it('leaves a dotfile alone rather than eating its name', () => {
    expect(nameForPath('.gitkeep')).toBe('.gitkeep')
  })
})

describe('database', () => {
  const db = buildDatabase([
    entry('t1', 'texture', 'textures/zinc.png'),
    entry('t2', 'texture', 'textures/alder.png'),
    entry('m1', 'model', 'props/crate.glb'),
  ])

  it('indexes by id', () => {
    expect(db.byId['t1']?.path).toBe('textures/zinc.png')
    expect(db.byId['nope']).toBeUndefined()
  })

  it('lists one kind, name-sorted — the order a panel shows', () => {
    expect(assetsOfKind(db, 'texture').map((e) => e.name)).toEqual(['alder', 'zinc'])
    expect(assetsOfKind(db, 'sound')).toEqual([])
  })
})

describe('materialDependencies', () => {
  const material = (params: MaterialAsset['params']): MaterialAsset => ({ shader: 'standard', params })

  it('collects the texture slots a preload pass has to fetch', () => {
    const deps = materialDependencies(
      material({
        albedo: { kind: 'texture', value: 'tex-a' },
        normal: { kind: 'texture', value: 'tex-b' },
        roughness: { kind: 'number', value: 0.5 },
      }),
    )
    expect(deps.sort()).toEqual(['tex-a', 'tex-b'])
  })

  it('skips empty slots', () => {
    expect(materialDependencies(material({ albedo: { kind: 'texture', value: null } }))).toEqual([])
  })

  it('is empty for a material with no textures at all', () => {
    expect(materialDependencies(material({ color: { kind: 'color', value: '#fff' } }))).toEqual([])
  })
})

describe('isAnimationAsset', () => {
  it('accepts a clip, including an empty one', () => {
    expect(isAnimationAsset({ keys: [] })).toBe(true)
    expect(isAnimationAsset({ keys: [{ t: 0, position: { x: 0, y: 0, z: 0 } }] })).toBe(true)
  })

  // Every JSON asset kind is told apart structurally, so the checks must not overlap: a prefab has
  // `components`, a material has `shader`, a clip has `keys`.
  it('rejects the other JSON assets, and anything shapeless', () => {
    expect(isAnimationAsset({ shader: 'standard', params: {} }), 'a material').toBe(false)
    expect(isAnimationAsset({ id: 'root', components: [] }), 'a prefab').toBe(false)
    expect(isAnimationAsset({ keys: 3 })).toBe(false)
    expect(isAnimationAsset({})).toBe(false)
    expect(isAnimationAsset(null)).toBe(false)
    expect(isAnimationAsset('keys')).toBe(false)
  })
})
