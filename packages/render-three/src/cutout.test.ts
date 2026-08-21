import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { createCutoutMask, cutoutCoverage, injectCutout, type CutoutState } from './cutout'

/**
 * The GLSL cannot be run here, so what is tested is the geometry (`cutoutCoverage`, which the shader
 * transcribes) and the shader edit itself (`injectCutout`, a pure string transform).
 *
 * The cone is deliberately the *whole* test now. Two earlier versions tried to keep the hole off the floor
 * from inside the shader — stop short of the character, then a depth slab — and both were wrong on screen:
 * a plane perpendicular to the view slices the hole into a half circle and swallows a low ceiling, and a
 * depth slab only holds for a surface square-on to the camera, so an oblique platform got a band across it
 * instead of a disc. Which surfaces are masked is settled outside the shader now (`setOccluders`), so what
 * is left here is the cone, and the cone has to be a cone.
 *
 * The target is 10 m along +Z from the eye.
 */
const state = (over: Partial<CutoutState> = {}): CutoutState => ({
  camera: { x: 0, y: 0, z: 0 },
  target: { x: 0, y: 0, z: 10 },
  radius: 1,
  feather: 0.5,
  strength: 1,
  ...over,
})

describe('the cutout cone', () => {
  it('covers a point on the sight line, inside the obstruction', () => {
    expect(cutoutCoverage(state(), { x: 0, y: 0, z: 6.5 })).toBe(1)
  })

  it('covers nothing at all when the strength is 0', () => {
    expect(cutoutCoverage(state({ strength: 0 }), { x: 0, y: 0, z: 6.5 })).toBe(0)
  })

  it('scales the whole hole by the strength, so the fade is a fade and not a shrink', () => {
    expect(cutoutCoverage(state({ strength: 0.4 }), { x: 0, y: 0, z: 6.5 })).toBeCloseTo(0.4, 6)
  })

  /**
   * Past the character the cone stops widening rather than stopping dead. Cutting it off at the character's
   * depth is a plane perpendicular to the view — the same mistake twice over — and it shows as a hard
   * straight edge across the hole wherever the occluder carries on behind them.
   */
  it('holds its width past the character instead of ending in a straight edge', () => {
    const s = state() // radius 1 at the target, 10 m out
    expect(cutoutCoverage(s, { x: 0, y: 0, z: 12 }), 'on the axis, past the target').toBe(1)
    expect(cutoutCoverage(s, { x: 1.6, y: 0, z: 12 }), 'and no wider than at the target').toBeCloseTo(0, 6)
    // At 60% of the way out the cone is 60% as wide, so the same offset is outside it.
    expect(cutoutCoverage(s, { x: 0.95, y: 0, z: 6 })).toBeCloseTo(0, 6)
    expect(cutoutCoverage(s, { x: 0.95, y: 0, z: 12 })).toBeGreaterThan(0)
  })

  it('leaves everything behind the eye alone', () => {
    expect(cutoutCoverage(state(), { x: 0, y: 0, z: -3 })).toBe(0)
  })

  // A ceiling right above the character's head is the case both earlier shapes missed: it is barely nearer
  // to the eye than they are, so anything that keeps a margin around the character keeps it too.
  it('covers a ceiling a hand above the character, camera overhead', () => {
    const s = state({ camera: { x: 0, y: 10, z: 0 }, target: { x: 0, y: 0, z: 0 } })
    expect(cutoutCoverage(s, { x: 0, y: 0.4, z: 0 })).toBe(1)
  })

  // The cone is the whole reason the hole reads as a constant disc on screen. Two points at the same
  // angle from the sight line but different depths must get the same coverage; a cylinder would not.
  it('is a cone, not a cylinder: coverage follows the angle, not the distance', () => {
    const s = state()
    // The half-coverage radius is 1.25x the inner one, and the inner one is `radius * along / span`.
    const near = cutoutCoverage(s, { x: 0.125 * 6.2, y: 0, z: 6.2 })
    const far = cutoutCoverage(s, { x: 0.125 * 6.8, y: 0, z: 6.8 })
    // Not exact: the feather's outer radius carries an epsilon so a zero-width ramp cannot divide by 0.
    expect(near).toBeCloseTo(far, 4)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(1)
  })

  it('falls off across the feather and reaches zero outside it', () => {
    const s = state({ feather: 0.5 })
    // At 6.5 m along a 10 m boom the inner radius is 0.65 and the outer one 0.975.
    const inner = cutoutCoverage(s, { x: 0.65, y: 0, z: 6.5 })
    const mid = cutoutCoverage(s, { x: 0.8125, y: 0, z: 6.5 })
    const outer = cutoutCoverage(s, { x: 0.975, y: 0, z: 6.5 })
    expect(inner).toBe(1)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(outer).toBeCloseTo(0, 6)
  })

  it('covers nothing when the eye is on the target', () => {
    expect(cutoutCoverage(state({ target: { x: 0, y: 0, z: 0 } }), { x: 0, y: 0, z: 0 })).toBe(0)
  })
})

// Representative of what Three hands `onBeforeCompile`: the anchors, and nothing else that matters.
const shader = (): { vertexShader: string; fragmentShader: string } => ({
  vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
  fragmentShader: '#include <common>\nvoid main() {\n\tgl_FragColor = vec4( 1.0 );\n}',
})

describe('the shader edit', () => {
  it('captures the world position after the vertex is transformed', () => {
    const out = injectCutout(shader())
    expect(out.injected).toBe(true)
    expect(out.vertexShader).toContain('varying vec3 mpCutWorld;')
    // After `<project_vertex>`, which is where `transformed` is final. Before it, skinning and morphs
    // have not been applied and an animated mesh would report the wrong position.
    const at = out.vertexShader.indexOf('mpCutWorld =')
    expect(at).toBeGreaterThan(out.vertexShader.indexOf('#include <project_vertex>'))
  })

  it('discards at the top of the fragment main, before any lighting', () => {
    const out = injectCutout(shader())
    const main = out.fragmentShader.indexOf('void main() {')
    expect(out.fragmentShader.indexOf('discard')).toBeGreaterThan(main)
    expect(out.fragmentShader.indexOf('discard')).toBeLessThan(out.fragmentShader.indexOf('gl_FragColor'))
  })

  it('declares every uniform it reads', () => {
    const out = injectCutout(shader())
    const declared: Record<string, string> = {
      mpCutCamera: 'vec3',
      mpCutTarget: 'vec3',
      mpCutRadius: 'float',
      mpCutFeather: 'float',
      mpCutStrength: 'float',
    }
    for (const [name, type] of Object.entries(declared)) {
      expect(out.fragmentShader, name).toContain(`uniform ${type} ${name};`)
    }
  })

  // A hand-written ShaderMaterial has no `<project_vertex>`. It must come out untouched rather than
  // half-patched, which would fail to compile and take the level's whole render with it.
  it('leaves a shader with no anchor exactly as it was', () => {
    const odd = { vertexShader: 'void main() {}', fragmentShader: 'void main() {}' }
    const out = injectCutout(odd)
    expect(out.injected).toBe(false)
    expect(out.vertexShader).toBe(odd.vertexShader)
    expect(out.fragmentShader).toBe(odd.fragmentShader)
  })
})

/**
 * Against Three's own sources, not the fake above. The injection hooks two string anchors in shaders this
 * package does not own, so a Three upgrade that renames or reorders them would silently stop the effect —
 * and `injected: false` is deliberately quiet, because the alternative is a level that fails to compile.
 * This is the noisy part.
 */
describe('the anchors Three actually ships', () => {
  // `standard` is what every material asset compiles to; `basic` is the `unlit` shader.
  const real: readonly [string, THREE.ShaderLibShader][] = [
    ['standard', THREE.ShaderLib.standard],
    ['basic', THREE.ShaderLib.basic],
  ]

  it.each(real)('%s has both anchors, and defines `transformed` before the vertex one', (_name, lib) => {
    expect(lib.fragmentShader).toContain('void main() {')
    const at = lib.vertexShader.indexOf('#include <project_vertex>')
    const begin = lib.vertexShader.indexOf('#include <begin_vertex>')
    expect(at, 'no vertex anchor').toBeGreaterThan(-1)
    expect(begin, '`transformed` is declared there').toBeGreaterThan(-1)
    expect(begin).toBeLessThan(at)
  })

  it.each(real)('injects into the real %s shader', (_name, lib) => {
    expect(injectCutout(lib).injected).toBe(true)
  })
})

describe('the mask', () => {
  it('reports what it was set to, and keeps the rest', () => {
    const mask = createCutoutMask(state())
    mask.set({ strength: 0.5 })
    expect(mask.state().strength).toBe(0.5)
    expect(mask.state().radius).toBe(1)
  })

  // The caller hands it a per-frame scratch vector; aliasing it would make `state()` lie a frame later.
  it('copies the vectors it is given rather than holding on to them', () => {
    const mask = createCutoutMask(state())
    const target = { x: 1, y: 2, z: 3 }
    mask.set({ target })
    target.x = 99
    expect(mask.state().target.x).toBe(1)
  })

  /**
   * A **copy**, and the original untouched. This is the whole point of the third design: a material is
   * shared by every piece using it, and only some of them are in the way. Patching in place fades the
   * level; cloning is what makes the mask per-mesh.
   */
  it('copies the material and leaves the original alone', () => {
    const mask = createCutoutMask(state())
    const plain = new THREE.MeshStandardMaterial({ color: 0x445566 })
    const before = plain.onBeforeCompile
    const masked = mask.variant(plain)
    expect(masked).not.toBe(plain)
    expect(plain.onBeforeCompile, 'the shared original must not be patched').toBe(before)
    expect(masked.onBeforeCompile).not.toBe(before)
    expect((masked as THREE.MeshStandardMaterial).color.getHex(), 'the surface still looks like itself').toBe(0x445566)
  })

  /**
   * One `onBeforeCompile` closure across every variant, because `Material.customProgramCacheKey` defaults
   * to its source text — a per-variant closure would still stringify the same, but sharing the function is
   * what makes one compiled program guaranteed rather than incidental.
   */
  it('gives every variant the same patch', () => {
    const mask = createCutoutMask(state())
    const a = mask.variant(new THREE.MeshStandardMaterial())
    const b = mask.variant(new THREE.MeshBasicMaterial())
    expect(a.onBeforeCompile).toBe(b.onBeforeCompile)
  })

  it('hands the shader its uniforms, sharing the objects `set` writes to', () => {
    const mask = createCutoutMask(state())
    const masked = mask.variant(new THREE.MeshStandardMaterial())
    const compiled = { ...shader(), uniforms: {} as Record<string, { value: unknown }> }
    ;(masked.onBeforeCompile as unknown as (s: typeof compiled) => void)(compiled)
    const strength = (): unknown => compiled.uniforms['mpCutStrength']?.value
    expect(strength()).toBe(1)
    // Set *after* compilation: the material is already on screen and the hole still has to open.
    mask.set({ strength: 0.25 })
    expect(strength()).toBe(0.25)
  })

  it('patches the copy for real, so a variant actually dithers', () => {
    const mask = createCutoutMask(state())
    const masked = mask.variant(new THREE.MeshStandardMaterial())
    const compiled = { ...THREE.ShaderLib.standard, uniforms: {} as Record<string, { value: unknown }> }
    ;(masked.onBeforeCompile as unknown as (s: typeof compiled) => void)(compiled)
    expect(compiled.fragmentShader).toContain('discard')
    expect(compiled.vertexShader).toContain('mpCutWorld =')
  })
})
