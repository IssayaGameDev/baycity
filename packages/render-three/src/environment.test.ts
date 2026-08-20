import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { installSky } from './environment'

/**
 * The sky (ADR 0045). Only `installSky` is tested — `loadSky` is that plus a network fetch, which needs a
 * browser. What matters here is the two things that are easy to get wrong and invisible when wrong: the
 * texture has to be told it is equirectangular sRGB, and disposing has to put the old background back.
 */

describe('installSky', () => {
  it('hangs the texture behind the scene as equirectangular sRGB', () => {
    const scene = new THREE.Scene()
    const texture = new THREE.Texture()
    const sky = installSky(scene, texture)

    expect(scene.background).toBe(texture)
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping)
    // Without this the sky is decoded as linear data and comes out washed out.
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(sky.texture).toBe(texture)
  })

  // The stage installs a solid colour, and the parkour render step reads `scene.background` back to restore
  // it after the overlay pass. Leaving null behind would take the clear colour with it.
  it('restores the previous background on dispose', () => {
    const scene = new THREE.Scene()
    const before = new THREE.Color(0x0b1020)
    scene.background = before
    installSky(scene, new THREE.Texture()).dispose()
    expect(scene.background).toBe(before)
  })

  it('leaves a background somebody else installed in the meantime alone', () => {
    const scene = new THREE.Scene()
    const sky = installSky(scene, new THREE.Texture())
    const later = new THREE.Color(0xffffff)
    scene.background = later
    sky.dispose()
    expect(scene.background).toBe(later)
  })

  it('does not touch the scene environment, so a sky never relights the level', () => {
    const scene = new THREE.Scene()
    const env = new THREE.Texture()
    scene.environment = env
    installSky(scene, new THREE.Texture())
    expect(scene.environment).toBe(env)
  })
})
