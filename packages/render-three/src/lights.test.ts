import type { WorldLight } from '@mp/content'
import { quat, vec3 } from '@mp/core'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { addLights, createLight, lightAims, shadowPassesFor, type LightDesc } from './lights'

/**
 * Content lights (ADR 0047).
 *
 * The shadow cap is the part worth testing hardest. Three renders forward, so a caster is a whole extra scene
 * render per frame and a point light is six of them — and nothing in a level file stops an author adding twenty.
 */

const desc = (over: Partial<LightDesc> = {}): LightDesc => ({
  kind: 'point',
  color: '#ffffff',
  groundColor: '#808080',
  intensity: 4,
  range: 12,
  decay: 2,
  angleDeg: 40,
  penumbra: 0.3,
  castShadow: false,
  ...over,
})

const world = (over: Partial<WorldLight> = {}): WorldLight => ({
  node: 'n0',
  ...desc(),
  position: vec3(0, 0, 0),
  rotation: quat(0, 0, 0, 1),
  visible: true,
  ...over,
})

describe('shadowPassesFor', () => {
  // The number that makes the cap necessary: a point shadow is a cube map.
  it('charges a point light six passes and everything else one', () => {
    expect(shadowPassesFor('point')).toBe(6)
    expect(shadowPassesFor('spot')).toBe(1)
    expect(shadowPassesFor('directional')).toBe(1)
    expect(shadowPassesFor('ambient')).toBe(1)
  })
})

describe('lightAims', () => {
  it('is true only for the kinds that read a rotation', () => {
    expect(lightAims('spot')).toBe(true)
    expect(lightAims('directional')).toBe(true)
    expect(lightAims('point')).toBe(false)
    expect(lightAims('ambient')).toBe(false)
  })
})

describe('createLight', () => {
  it('builds the three kind that matches', () => {
    expect(createLight(desc({ kind: 'point' }), false)).toBeInstanceOf(THREE.PointLight)
    expect(createLight(desc({ kind: 'spot' }), false)).toBeInstanceOf(THREE.SpotLight)
    expect(createLight(desc({ kind: 'directional' }), false)).toBeInstanceOf(THREE.DirectionalLight)
    expect(createLight(desc({ kind: 'ambient' }), false)).toBeInstanceOf(THREE.AmbientLight)
  })

  // Authored colours are sRGB; three works in linear. Mid grey is 0.216 linear, not 0.502.
  it('reads the colour as sRGB', () => {
    expect(createLight(desc({ color: '#808080' }), false).color.r).toBeCloseTo(0.2158, 3)
  })

  it('converts the cone angle from degrees', () => {
    const l = createLight(desc({ kind: 'spot', angleDeg: 45 }), false) as THREE.SpotLight
    expect(l.angle).toBeCloseTo(Math.PI / 4, 6)
  })

  it('carries range and falloff onto the three light', () => {
    const l = createLight(desc({ kind: 'point', range: 7, decay: 1.5 }), false) as THREE.PointLight
    expect(l.distance).toBe(7)
    expect(l.decay).toBe(1.5)
  })

  /** A range of 0 means unbounded, which a shadow camera's far plane cannot be. */
  it('gives an unbounded light a finite shadow far plane', () => {
    const l = createLight(desc({ kind: 'point', range: 0, castShadow: true }), true) as THREE.PointLight
    expect(l.shadow.camera.far).toBeGreaterThan(0)
    expect(Number.isFinite(l.shadow.camera.far)).toBe(true)
  })
})

describe('addLights', () => {
  it('adds one object per light, plus a target for the ones that aim', () => {
    const scene = new THREE.Scene()
    const lights = addLights(scene, [world({ kind: 'point' }), world({ kind: 'spot' })])
    // point, spot, and the spot's target
    expect(lights.group.children.length).toBe(3)
    lights.dispose()
  })

  it('caps shadow casters and reports the cost', () => {
    const scene = new THREE.Scene()
    const wanting = Array.from({ length: 6 }, () => world({ kind: 'point', castShadow: true }))
    const lights = addLights(scene, wanting, { maxShadowCasters: 2 })
    expect(lights.cost.shadowCasters).toBe(2)
    expect(lights.cost.shadowPasses).toBe(12) // two cube maps
    const casting = lights.group.children.filter((o) => o instanceof THREE.Light && o.castShadow)
    expect(casting.length).toBe(2)
    lights.dispose()
  })

  // Otherwise a level of unshadowed lights would exhaust the cap and the one light that asked would miss out.
  it('only spends the cap on lights that asked to cast', () => {
    const scene = new THREE.Scene()
    const lights = addLights(scene, [world(), world(), world({ castShadow: true })], { maxShadowCasters: 1 })
    expect(lights.cost.shadowCasters).toBe(1)
    lights.dispose()
  })

  it('never casts when shadows are off entirely', () => {
    const scene = new THREE.Scene()
    const lights = addLights(scene, [world({ castShadow: true })], { shadows: false })
    expect(lights.cost.shadowCasters).toBe(0)
    lights.dispose()
  })

  it('refuses to let an ambient light cast, since it has no direction', () => {
    const scene = new THREE.Scene()
    const lights = addLights(scene, [world({ kind: 'ambient', castShadow: true })], { maxShadowCasters: 4 })
    expect(lights.cost.shadowCasters).toBe(0)
    lights.dispose()
  })

  /** A lamp on a moving platform: the loader mutates `position`, `sync` carries it to the three light. */
  it('re-poses a moved light on sync', () => {
    const scene = new THREE.Scene()
    const moving = world({ kind: 'point' })
    const lights = addLights(scene, [moving])
    moving.position = vec3(3, 4, 5)
    lights.sync()
    const object = lights.group.children.find((o) => o instanceof THREE.PointLight)!
    expect(object.position.toArray()).toEqual([3, 4, 5])
    lights.dispose()
  })

  it('aims a spot down its own forward, which is -Z', () => {
    const scene = new THREE.Scene()
    const spot = world({ kind: 'spot', position: vec3(0, 5, 0) })
    const lights = addLights(scene, [spot])
    lights.sync()
    const object = lights.group.children.find((o) => o instanceof THREE.SpotLight) as THREE.SpotLight
    // Unrotated, forward is -Z, so the target sits one unit that way from the light.
    expect(object.target.position.z).toBeCloseTo(spot.position.z - 1, 6)
    expect(object.target.position.y).toBeCloseTo(5, 6)
    lights.dispose()
  })

  it('takes the group back out of the scene on dispose', () => {
    const scene = new THREE.Scene()
    const lights = addLights(scene, [world()])
    expect(scene.children).toContain(lights.group)
    lights.dispose()
    expect(scene.children).not.toContain(lights.group)
  })
})

/** The hemisphere fill is content now (ADR 0048), so it comes through the same path as every other light. */
describe('a hemisphere light', () => {
  it('builds a HemisphereLight with both halves', () => {
    const l = createLight(desc({ kind: 'hemisphere', color: '#ffffff', groundColor: '#000000' }), false) as THREE.HemisphereLight
    expect(l).toBeInstanceOf(THREE.HemisphereLight)
    expect(l.color.r).toBeCloseTo(1, 6)
    expect(l.groundColor.r).toBeCloseTo(0, 6)
  })

  it('never aims and never casts, since it has no direction', () => {
    expect(lightAims('hemisphere')).toBe(false)
    const scene = new THREE.Scene()
    const lights = addLights(scene, [world({ kind: 'hemisphere', castShadow: true })], { maxShadowCasters: 4 })
    expect(lights.cost.shadowCasters).toBe(0)
    lights.dispose()
  })

  // Its node's transform is inert — Kodjo's call, made knowing that. Worth pinning so nobody "fixes" it.
  it('is not re-posed by sync, because three reads only the world Y axis', () => {
    const scene = new THREE.Scene()
    const moving = world({ kind: 'hemisphere' })
    const lights = addLights(scene, [moving])
    moving.position = vec3(9, 9, 9)
    lights.sync()
    const object = lights.group.children.find((o) => o instanceof THREE.HemisphereLight)!
    expect(object.position.toArray()).toEqual([0, 0, 0])
    lights.dispose()
  })
})

/** A sequence disabling a node takes its light with it (ADR 0137), whatever kind the light is. */
describe('a light whose node is disabled', () => {
  it('goes off on the next sync, and comes back', () => {
    const scene = new THREE.Scene()
    const point = world({ kind: 'point' })
    const ambient = world({ kind: 'ambient' })
    const lights = addLights(scene, [point, ambient])
    const objects = lights.group.children.filter((o): o is THREE.Light => o instanceof THREE.Light)
    point.visible = false
    ambient.visible = false
    lights.sync()
    expect(objects.map((o) => o.visible)).toEqual([false, false])
    point.visible = true
    lights.sync()
    expect(objects[0]!.visible).toBe(true)
    lights.dispose()
  })
})
