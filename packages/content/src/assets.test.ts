import { describe, expect, it } from 'vitest'

import {
  assetsOfKind,
  buildDatabase,
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
  it('recognises materials and shaders by compound extension, at any path', () => {
    expect(kindForPath('materials/brick.mat.json')).toBe('material')
    expect(kindForPath('anywhere/deep/brick.mat.json')).toBe('material')
    expect(kindForPath('shaders/water.shader.json')).toBe('shader')
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
