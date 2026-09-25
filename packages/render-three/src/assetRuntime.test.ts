import type { MaterialAsset, VisualItem } from '@mp/content'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { buildDatabase } from '@mp/content'

import { assetIdsIn, createAssetRuntime } from './assetRuntime'

const visual = (over: Partial<VisualItem>): VisualItem => ({
  collider: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
  model: undefined,
  material: undefined,
  visible: true,
  opacity: 1,
  fades: false,
  animated: false,
  drawScale: { x: 1, y: 1, z: 1 },
  colliderHandles: [],
  ...over,
})

describe('assetIdsIn', () => {
  it('collects the files a draw list references, once each', () => {
    const ids = assetIdsIn([visual({ model: 'aaaaaaaaaaaaaaaa', material: 'mmmmmmmmmmmmmmmm' }), visual({ material: 'mmmmmmmmmmmmmmmm' })])
    expect(ids.sort()).toEqual(['aaaaaaaaaaaaaaaa', 'mmmmmmmmmmmmmmmm'])
  })

  it('leaves out a built-in shape: it is geometry this package builds, not a file to fetch (ADR 0090)', () => {
    expect(assetIdsIn([visual({ model: 'builtin:rounded-box', material: 'mmmmmmmmmmmmmmmm' })])).toEqual(['mmmmmmmmmmmmmmmm'])
    expect(assetIdsIn([visual({ model: 'builtin:sphere' })])).toEqual([])
  })
})

/**
 * Whether a load brought anything new: a caller that drew before the assets arrived redraws only then. Drawing
 * again for nothing was half of what made an undo in the editor take a second.
 */
describe('load', () => {
  const runtime = () =>
    createAssetRuntime({
      db: buildDatabase([{ id: 'mmmmmmmmmmmmmmmm', kind: 'material', path: 'assets/red.mat.json', name: 'red' }]),
      urlOf: (path) => path,
      materialOf: () => ({ shader: 'standard', params: {} }),
    })

  it('says true when something arrived, and false once it is held', async () => {
    const r = runtime()
    expect(await r.load(['mmmmmmmmmmmmmmmm'])).toBe(true)
    expect(r.material('mmmmmmmmmmmmmmmm')).not.toBeNull()
    expect(await r.load(['mmmmmmmmmmmmmmmm'])).toBe(false)
  })

  it('says false for what there is nothing to fetch for: a built-in shape, an id nobody knows', async () => {
    expect(await runtime().load(['builtin:box', 'gggggggggggggggg', ''])).toBe(false)
  })
})

/**
 * A material edited while it is drawn (ADR 0157): the object every mesh holds takes the new values, so the next
 * frame shows them and nothing is rebuilt — until the shader changes class, which only a rebuild can show.
 */
describe('refreshMaterial', () => {
  const M = 'mmmmmmmmmmmmmmmm'
  const rig = () => {
    let asset: MaterialAsset = { shader: 'standard', params: { color: { kind: 'color', value: '#ff0000' } } }
    const r = createAssetRuntime({
      db: buildDatabase([{ id: M, kind: 'material', path: 'assets/red.mat.json', name: 'red' }]),
      urlOf: (path) => path,
      materialOf: () => asset,
    })
    return { r, set: (next: MaterialAsset) => void (asset = next) }
  }

  it('changes the material meshes hold, in place', async () => {
    const { r, set } = rig()
    await r.load([M])
    const held = r.material(M) as THREE.MeshStandardMaterial
    set({ shader: 'standard', params: { color: { kind: 'color', value: '#0000ff' }, roughness: { kind: 'number', value: 0.2 } } })
    expect(await r.refreshMaterial(M)).toBe(true)
    expect(r.material(M), 'the same object').toBe(held)
    expect(held.color.getHexString()).toBe('0000ff')
    expect(held.roughness).toBe(0.2)
  })

  it('replaces it, and says so, when the shader changes class', async () => {
    const { r, set } = rig()
    await r.load([M])
    const held = r.material(M)
    set({ shader: 'unlit', params: {} })
    expect(await r.refreshMaterial(M)).toBe(false)
    expect(r.material(M)).not.toBe(held)
    expect(r.material(M)).toBeInstanceOf(THREE.MeshBasicMaterial)
  })

  it('has nothing to do for a material never loaded', async () => {
    const { r } = rig()
    expect(await r.refreshMaterial(M)).toBe(true)
    expect(r.material(M)).toBeNull()
    await r.refreshTexture('tttttttttttttttt')
  })
})
