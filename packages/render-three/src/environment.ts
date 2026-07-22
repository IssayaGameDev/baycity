import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * Polished greybox lighting (content pipeline C3). Turns a bare scene into one with
 * image-based ambient (a `RoomEnvironment` baked to a PMREM), ACES tone mapping, and a
 * soft-shadowed key light — the polish comes from rendering, not art. Opt-in: the stage
 * stays unopinionated. Shared by the game and the viewer.
 */
export interface GreyboxEnvironmentOptions {
  /** Tone-mapping exposure. */
  exposure?: number
  /** Key-light world position (direction to the origin). */
  sunPosition?: readonly [number, number, number]
  sunIntensity?: number
  /** Half-extent of the shadow frustum (world units) around the origin. */
  shadowRadius?: number
  shadowMapSize?: number
  /** Distance fog far plane; omit for no fog. */
  fogFar?: number
}

export interface GreyboxEnvironment {
  sun: THREE.DirectionalLight
  fill: THREE.HemisphereLight
  dispose: () => void
}

export const applyGreyboxEnvironment = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  opts: GreyboxEnvironmentOptions = {},
): GreyboxEnvironment => {
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = opts.exposure ?? 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  // Image-based ambient: bake the neutral studio room to a PMREM and use it as the
  // scene environment (soft, directionless fill + subtle reflections on standard mats).
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTex
  pmrem.dispose()

  const bg = scene.background instanceof THREE.Color ? scene.background : new THREE.Color(0x0b1020)
  if (opts.fogFar !== undefined) scene.fog = new THREE.Fog(bg.getHex(), opts.fogFar * 0.25, opts.fogFar)

  // Key light — the shadow caster. Frustum is sized to the level footprint by the caller.
  const r = opts.shadowRadius ?? 30
  const sun = new THREE.DirectionalLight(0xffffff, opts.sunIntensity ?? 2.2)
  const [sx, sy, sz] = opts.sunPosition ?? [18, 30, 14]
  sun.position.set(sx, sy, sz)
  sun.castShadow = true
  const mapSize = opts.shadowMapSize ?? 2048
  sun.shadow.mapSize.set(mapSize, mapSize)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = Math.hypot(sx, sy, sz) + r * 2
  sun.shadow.camera.left = -r
  sun.shadow.camera.right = r
  sun.shadow.camera.top = r
  sun.shadow.camera.bottom = -r
  sun.shadow.bias = -0.0002
  sun.shadow.normalBias = 0.02
  sun.shadow.camera.updateProjectionMatrix()
  scene.add(sun)
  scene.add(sun.target) // target at origin

  // Cool sky / warm bounce fill so shadowed faces don't go dead flat.
  const fill = new THREE.HemisphereLight(0xbcd4ff, 0x2b2b2b, 0.35)
  scene.add(fill)

  return {
    sun,
    fill,
    dispose: () => {
      scene.remove(sun, sun.target, fill)
      envTex.dispose()
      if (scene.environment === envTex) scene.environment = null
      scene.fog = null
    },
  }
}
