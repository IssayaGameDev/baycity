import type { MaterialAsset, MaterialValue } from '@mp/content'
import * as THREE from 'three'

/**
 * Shaders, and the materials that instance them.
 *
 * A material is **a shader plus values for that shader's parameters** — so the property set belongs to the
 * shader, not to the material schema. That is what stops "add a normal map" from being a change to
 * `@mp/content`, what lets a custom shader arrive without touching this file's callers, and what lets one
 * generic inspector edit any material: it reads the parameter list off the shader and renders a field per
 * entry.
 *
 * We are parameterising Three.js, not writing an engine. A built-in shader is a thin description of one of
 * Three's material classes and how its parameters map onto it. A custom shader would describe uniforms for
 * a `ShaderMaterial` the same way — the registry is the seam, and `compile` is the only thing that needs
 * to know the difference.
 */
export type ShaderParamKind = MaterialValue['kind']

export interface ShaderParam {
  key: string
  label: string
  kind: ShaderParamKind
  /** Value used when a material omits this parameter, so a partial material still renders. */
  fallback: MaterialValue
  /** Numbers only: the range a slider should offer. */
  min?: number
  max?: number
  step?: number
}

export interface ShaderDef {
  name: string
  /** What a material of this shader supplies. Drives both compilation and the inspector. */
  params: readonly ShaderParam[]
  /** Turn parameter values into a Three material. `texture` resolves an asset id to a loaded texture. */
  build: (read: ParamReader) => THREE.Material
}

/** Reads a material's parameters, falling back to the shader's defaults for anything absent. */
export interface ParamReader {
  color: (key: string) => THREE.Color
  number: (key: string) => number
  vec2: (key: string) => { x: number; y: number }
  boolean: (key: string) => boolean
  /** The loaded texture in that slot, or `null` when empty or still unloaded. */
  texture: (key: string) => THREE.Texture | null
}

const num = (value: number): MaterialValue => ({ kind: 'number', value })

/**
 * `standard` — the default for 3D objects: colour, PBR scalars, an albedo map. Maps onto
 * `MeshStandardMaterial`, so it gets the pipeline's IBL, shadows and AO for free.
 */
const STANDARD: ShaderDef = {
  name: 'standard',
  params: [
    { key: 'color', label: 'colour', kind: 'color', fallback: { kind: 'color', value: '#cccccc' } },
    { key: 'metalness', label: 'metalness', kind: 'number', fallback: num(0), min: 0, max: 1, step: 0.01 },
    { key: 'roughness', label: 'roughness', kind: 'number', fallback: num(0.85), min: 0, max: 1, step: 0.01 },
    { key: 'emissive', label: 'emissive', kind: 'color', fallback: { kind: 'color', value: '#000000' } },
    { key: 'emissiveIntensity', label: 'emissive ×', kind: 'number', fallback: num(1), min: 0, max: 4, step: 0.01 },
    { key: 'albedo', label: 'albedo map', kind: 'texture', fallback: { kind: 'texture', value: null } },
    { key: 'tiling', label: 'tiling', kind: 'vec2', fallback: { kind: 'vec2', value: { x: 1, y: 1 } } },
  ],
  build: (read) => {
    const map = read.texture('albedo')
    const tiling = read.vec2('tiling')
    if (map !== null) {
      // Wrapping has to be repeat for tiling to mean anything, and the texture is shared between
      // materials, so this clones rather than mutating the cached original.
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.repeat.set(tiling.x, tiling.y)
      map.colorSpace = THREE.SRGBColorSpace
    }
    return new THREE.MeshStandardMaterial({
      color: read.color('color'),
      metalness: read.number('metalness'),
      roughness: read.number('roughness'),
      emissive: read.color('emissive'),
      emissiveIntensity: read.number('emissiveIntensity'),
      ...(map !== null ? { map } : {}),
    })
  },
}

/**
 * `unlit` — colour and a texture, no lighting response (`MeshBasicMaterial`). For things that should read
 * as flat: sprites in the world, markers, anything meant to ignore the scene's lighting.
 */
const UNLIT: ShaderDef = {
  name: 'unlit',
  params: [
    { key: 'color', label: 'colour', kind: 'color', fallback: { kind: 'color', value: '#ffffff' } },
    { key: 'albedo', label: 'texture', kind: 'texture', fallback: { kind: 'texture', value: null } },
    { key: 'tiling', label: 'tiling', kind: 'vec2', fallback: { kind: 'vec2', value: { x: 1, y: 1 } } },
    { key: 'transparent', label: 'transparent', kind: 'boolean', fallback: { kind: 'boolean', value: false } },
  ],
  build: (read) => {
    const map = read.texture('albedo')
    const tiling = read.vec2('tiling')
    if (map !== null) {
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.repeat.set(tiling.x, tiling.y)
      map.colorSpace = THREE.SRGBColorSpace
    }
    const transparent = read.boolean('transparent')
    return new THREE.MeshBasicMaterial({
      color: read.color('color'),
      transparent,
      ...(map !== null ? { map } : {}),
    })
  },
}

const BUILTIN: Record<string, ShaderDef> = { standard: STANDARD, unlit: UNLIT }

/** Built-in shader names, in the order a shader picker should offer them. */
export const BUILTIN_SHADERS: readonly string[] = Object.keys(BUILTIN)

/**
 * The shader a material names, or `undefined` if nothing is registered under it. A custom shader asset
 * registers here; a missing one is a render-time fallback rather than a load error, because a material
 * whose shader has been deleted still has to open in an editor.
 */
export const shaderDef = (name: string): ShaderDef | undefined => BUILTIN[name]

/** Register a shader — the extension point for custom shaders (asset-defined uniforms + GLSL). */
export const registerShader = (def: ShaderDef): void => {
  BUILTIN[def.name] = def
}

/** The shader's own defaults as a material — what an unparameterised piece of that shader looks like. */
export const defaultParams = (def: ShaderDef): Record<string, MaterialValue> => {
  const out: Record<string, MaterialValue> = {}
  for (const p of def.params) out[p.key] = p.fallback
  return out
}

/**
 * Compile a material asset into a Three material. `textureFor` resolves a texture asset id to a loaded
 * texture (`null` if absent) — the compiler never loads anything itself, so it stays synchronous and the
 * preload pass stays the one place that knows about fetching.
 *
 * A material naming an unregistered shader compiles as `standard` with whatever parameters do match, so a
 * broken reference is a wrong-looking surface rather than a missing one.
 */
export const compileMaterial = (
  material: MaterialAsset,
  textureFor: (assetId: string) => THREE.Texture | null,
): THREE.Material => {
  const def = shaderDef(material.shader) ?? STANDARD
  const byKey = new Map(def.params.map((p) => [p.key, p]))

  const valueOf = (key: string): MaterialValue | undefined => material.params[key] ?? byKey.get(key)?.fallback

  const read: ParamReader = {
    color: (key) => {
      const v = valueOf(key)
      return new THREE.Color(v?.kind === 'color' ? v.value : '#ffffff')
    },
    number: (key) => {
      const v = valueOf(key)
      return v?.kind === 'number' ? v.value : 0
    },
    vec2: (key) => {
      const v = valueOf(key)
      return v?.kind === 'vec2' ? v.value : { x: 1, y: 1 }
    },
    boolean: (key) => {
      const v = valueOf(key)
      return v?.kind === 'boolean' ? v.value : false
    },
    texture: (key) => {
      const v = valueOf(key)
      if (v?.kind !== 'texture' || v.value === null) return null
      const tex = textureFor(v.value)
      // Cloned so per-material tiling and colour space cannot write back onto the shared cache entry.
      return tex === null ? null : tex.clone()
    },
  }

  return def.build(read)
}
