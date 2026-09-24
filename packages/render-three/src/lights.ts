import type { WorldLight } from '@mp/content'
import * as THREE from 'three'

/**
 * Realizes the loader's `WorldLight` list as Three lights (ADR 0047). The same split the level pipeline uses:
 * `@mp/content` decides what lights exist and where, this file is the only place that knows what a
 * `THREE.SpotLight` is.
 *
 * **The sun is not here.** It belongs to `environment.ts`, where one pair of angles drives the key light, its
 * shadow frustum and the sky together (ADR 0046). These are the additional lights a level authors.
 */

/** Shadow-map resolution for a content light. Smaller than the sun's 2048: these are local, not level-wide. */
const SHADOW_MAP = 1024

export interface ContentLights {
  group: THREE.Group
  /** Re-pose the lights whose nodes move. Cheap — call every rendered frame, next to `LevelView.sync`. */
  sync: () => void
  /** How many of these actually cast, and what that costs in extra scene renders per frame. */
  readonly cost: { shadowCasters: number; shadowPasses: number }
  dispose: () => void
}

export interface ContentLightsOptions {
  /**
   * Cap on shadow-casting lights, in the order the level declares them. Beyond it, lights still light but stop
   * casting.
   *
   * Three renders forward, so each caster is a whole extra scene render per frame — and a **point** light is
   * six, because its shadow is a cube map. Without a cap, one author dropping ten shadowed point lights into a
   * level costs sixty extra scene renders against a 16 ms budget (budget 1, still unmeasured). Default 4.
   */
  maxShadowCasters?: number
  /** Suppress every content shadow, whatever the data says. What a low-quality path would set. */
  shadows?: boolean
}

/**
 * What a light *is*, with no notion of where.
 *
 * Split out so the editor and the game build lights from one implementation. `WorldLight` satisfies it
 * structurally, so the loader's list needs no conversion; the editor synthesises these from a node's `Light`
 * component and parents the result into the node's group, which positions it for free.
 */
export interface LightDesc {
  readonly kind: 'point' | 'spot' | 'directional' | 'ambient' | 'hemisphere'
  readonly color: string
  /** The upward half of a `hemisphere` light; ignored by every other kind. */
  readonly groundColor: string
  readonly intensity: number
  readonly range: number
  readonly decay: number
  readonly angleDeg: number
  readonly penumbra: number
  readonly castShadow: boolean
}

/** A `point` light's shadow is a cube: six faces, six renders. Everything else is one. */
export const shadowPassesFor = (kind: LightDesc['kind']): number => (kind === 'point' ? 6 : 1)

/** Whether this kind reads its object's rotation, and so needs a target to aim at. */
export const lightAims = (kind: LightDesc['kind']): boolean => kind === 'spot' || kind === 'directional'

export const createLight = (light: LightDesc, casts: boolean): THREE.Light => {
  const color = new THREE.Color().setStyle(light.color, THREE.SRGBColorSpace)
  switch (light.kind) {
    case 'ambient':
      // No position, no direction, no shadow. A flat lift on everything.
      return new THREE.AmbientLight(color, light.intensity)
    case 'hemisphere':
      // Sky colour down, ground colour up. No position either: three reads only the world's Y axis, which is
      // why its node's transform is inert (ADR 0048).
      return new THREE.HemisphereLight(color, new THREE.Color().setStyle(light.groundColor, THREE.SRGBColorSpace), light.intensity)
    case 'directional': {
      const l = new THREE.DirectionalLight(color, light.intensity)
      l.castShadow = casts
      if (casts) {
        l.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP)
        // A content directional has no level-wide framing to size a frustum from, so it gets a local one.
        const r = 20
        l.shadow.camera.left = -r
        l.shadow.camera.right = r
        l.shadow.camera.top = r
        l.shadow.camera.bottom = -r
        l.shadow.camera.near = 0.5
        l.shadow.camera.far = 120
        l.shadow.bias = -0.0002
        l.shadow.normalBias = 0.02
        l.shadow.camera.updateProjectionMatrix()
      }
      return l
    }
    case 'spot': {
      const l = new THREE.SpotLight(color, light.intensity)
      l.distance = light.range
      l.decay = light.decay
      l.angle = THREE.MathUtils.degToRad(light.angleDeg)
      l.penumbra = light.penumbra
      l.castShadow = casts
      if (casts) {
        l.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP)
        l.shadow.camera.near = 0.5
        // A range of 0 means unbounded, which a shadow camera cannot be.
        l.shadow.camera.far = light.range > 0 ? light.range : 100
        l.shadow.bias = -0.0005
        l.shadow.normalBias = 0.02
      }
      return l
    }
    case 'point': {
      const l = new THREE.PointLight(color, light.intensity)
      l.distance = light.range
      l.decay = light.decay
      l.castShadow = casts
      if (casts) {
        l.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP)
        l.shadow.camera.near = 0.5
        l.shadow.camera.far = light.range > 0 ? light.range : 100
        l.shadow.bias = -0.0005
        l.shadow.normalBias = 0.02
      }
      return l
    }
  }
}

/** The node's forward, `-Z` rotated by its orientation — the axis Unity points a light down. */
const FORWARD = new THREE.Vector3(0, 0, -1)

export const addLights = (scene: THREE.Scene, lights: readonly WorldLight[], opts: ContentLightsOptions = {}): ContentLights => {
  const group = new THREE.Group()
  const cap = opts.shadows === false ? 0 : (opts.maxShadowCasters ?? 4)
  const posed: { light: WorldLight; object: THREE.Light; target: THREE.Object3D | undefined }[] = []
  let shadowCasters = 0
  let shadowPasses = 0

  for (const light of lights) {
    // Only counted against the cap when the data actually asked to cast, so a level of unshadowed lights
    // never uses it up.
    const wants = light.castShadow && light.kind !== 'ambient' && light.kind !== 'hemisphere'
    const casts = wants && shadowCasters < cap
    if (casts) {
      shadowCasters += 1
      shadowPasses += shadowPassesFor(light.kind)
    }

    const object = createLight(light, casts)
    object.position.set(light.position.x, light.position.y, light.position.z)

    let target: THREE.Object3D | undefined
    if (lightAims(light.kind)) {
      // Three aims a directional or spot at a target object, so the node's rotation becomes a point in front
      // of it. The target has to be in the scene graph for its world matrix to update.
      target = new THREE.Object3D()
      group.add(target)
      const l = object as THREE.DirectionalLight | THREE.SpotLight
      l.target = target
    }

    group.add(object)
    posed.push({ light, object, target })
  }

  const q = new THREE.Quaternion()
  const dir = new THREE.Vector3()
  const sync = (): void => {
    for (const { light, object, target } of posed) {
      // Off while a sequence has its node disabled (ADR 0137), whatever kind it is.
      object.visible = light.visible
      // Neither of these reads a position, so there is nothing to re-pose.
      if (light.kind === 'ambient' || light.kind === 'hemisphere') continue
      object.position.set(light.position.x, light.position.y, light.position.z)
      if (target === undefined) continue
      q.set(light.rotation.x, light.rotation.y, light.rotation.z, light.rotation.w)
      dir.copy(FORWARD).applyQuaternion(q)
      target.position.copy(object.position).add(dir)
    }
  }
  sync()

  scene.add(group)

  return {
    group,
    sync,
    cost: { shadowCasters, shadowPasses },
    dispose: () => {
      for (const { object } of posed) {
        // A shadow's render target is the only thing a light owns that needs freeing.
        if ('shadow' in object && object.shadow !== null && object.shadow !== undefined) object.shadow.dispose()
        object.dispose()
      }
      scene.remove(group)
      group.clear()
    },
  }
}
