import type { MaterialAsset } from '@mp/content'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { BUILTIN_SHADERS, compileMaterial, defaultParams, registerShader, shaderDef } from './shaders'

const material = (shader: string, params: MaterialAsset['params'] = {}): MaterialAsset => ({ shader, params })
const noTextures = (): null => null

describe('built-in shaders', () => {
  it('offers standard and unlit', () => {
    expect(BUILTIN_SHADERS).toContain('standard')
    expect(BUILTIN_SHADERS).toContain('unlit')
  })

  it('declares its own parameters, which is what drives the inspector', () => {
    const def = shaderDef('standard')!
    expect(def.params.map((p) => p.key)).toEqual([
      'color',
      'metalness',
      'roughness',
      'emissive',
      'emissiveIntensity',
      'albedo',
      'tiling',
    ])
  })

  it('has a default for every parameter, so a partial material still renders', () => {
    const def = shaderDef('standard')!
    const defaults = defaultParams(def)
    for (const p of def.params) expect(defaults[p.key], p.key).toBeDefined()
  })

  it('is undefined for a name nothing registered', () => {
    expect(shaderDef('does-not-exist')).toBeUndefined()
  })
})

describe('compileMaterial', () => {
  it('maps standard onto MeshStandardMaterial', () => {
    const m = compileMaterial(
      material('standard', {
        color: { kind: 'color', value: '#ff0000' },
        metalness: { kind: 'number', value: 0.25 },
        roughness: { kind: 'number', value: 0.5 },
      }),
      noTextures,
    ) as THREE.MeshStandardMaterial

    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(m.color.getHexString()).toBe('ff0000')
    expect(m.metalness).toBe(0.25)
    expect(m.roughness).toBe(0.5)
  })

  it('maps unlit onto MeshBasicMaterial, which ignores the scene lighting', () => {
    const m = compileMaterial(material('unlit', { color: { kind: 'color', value: '#00ff00' } }), noTextures)
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial)
  })

  it('falls back to the shader\'s defaults for anything the material omits', () => {
    const m = compileMaterial(material('standard'), noTextures) as THREE.MeshStandardMaterial
    expect(m.roughness, "standard's default").toBe(0.85)
    expect(m.metalness).toBe(0)
  })

  // A material whose shader was deleted still has to render *something*, or a missing file turns into an
  // invisible level rather than a wrong-looking one.
  it('renders a material naming an unregistered shader as standard', () => {
    const m = compileMaterial(material('ghost', { roughness: { kind: 'number', value: 0.1 } }), noTextures)
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect((m as THREE.MeshStandardMaterial).roughness, 'matching parameters still apply').toBe(0.1)
  })

  it('ignores a value whose type does not match the parameter', () => {
    const m = compileMaterial(
      material('standard', { roughness: { kind: 'color', value: '#fff' } }),
      noTextures,
    ) as THREE.MeshStandardMaterial
    expect(m.roughness, 'a colour is not a roughness').toBe(0)
  })

  it('resolves a texture slot through the caller, and clones so tiling is per-material', () => {
    const shared = new THREE.Texture()
    const m = compileMaterial(
      material('standard', {
        albedo: { kind: 'texture', value: 'tex-1' },
        tiling: { kind: 'vec2', value: { x: 4, y: 2 } },
      }),
      (id) => (id === 'tex-1' ? shared : null),
    ) as THREE.MeshStandardMaterial

    expect(m.map).not.toBeNull()
    expect(m.map).not.toBe(shared) // else the next material's tiling would overwrite this one's
    expect(m.map!.repeat.x).toBe(4)
    expect(m.map!.repeat.y).toBe(2)
    expect(shared.repeat.x, 'the cached original is untouched').toBe(1)
  })

  it('leaves the map unset when the slot is empty or unresolved', () => {
    const empty = compileMaterial(material('standard', { albedo: { kind: 'texture', value: null } }), noTextures)
    expect((empty as THREE.MeshStandardMaterial).map).toBeNull()

    const dangling = compileMaterial(material('standard', { albedo: { kind: 'texture', value: 'gone' } }), noTextures)
    expect((dangling as THREE.MeshStandardMaterial).map).toBeNull()
  })
})

describe('registerShader', () => {
  // The extension point: a custom shader arrives with its own parameters and nothing else changes.
  it('adds a shader that compileMaterial then uses', () => {
    registerShader({
      name: 'test-wireframe',
      params: [{ key: 'tint', label: 'tint', kind: 'color', fallback: { kind: 'color', value: '#123456' } }],
      build: (read) => new THREE.MeshBasicMaterial({ color: read.color('tint'), wireframe: true }),
    })

    expect(shaderDef('test-wireframe')).toBeDefined()
    const m = compileMaterial(material('test-wireframe'), noTextures) as THREE.MeshBasicMaterial
    expect(m.wireframe).toBe(true)
    expect(m.color.getHexString(), "the custom shader's own default").toBe('123456')
  })
})
