import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import type { EnvironmentConfig } from '@mp/content'

import { createProceduralSky, DEFAULT_SKY_PARAMS, sunDirection, type ProceduralSky, type SkyParams, type SunAngles } from './sky'

/**
 * Polished greybox lighting (content pipeline C3). Turns a bare scene into one with image-based ambient, ACES
 * tone mapping, and a soft-shadowed key light — the polish comes from rendering, not art. Opt-in: the stage
 * stays unopinionated. Shared by the game, the editor and the viewer.
 *
 * **The sun is one input** (ADR 0046). Elevation and azimuth drive the key light, its shadow frustum, the sky
 * shader and the environment map together. It used to be a raw `sunPosition` vector with the sky, when there
 * was one, lit independently — which is exactly how a scene ends up lit from a direction its sky disagrees
 * with. Two numbers, one owner, no drift.
 */
export interface GreyboxEnvironmentOptions {
  /** Tone-mapping exposure. */
  exposure?: number
  /** Sun elevation above the horizon, degrees. */
  sunElevation?: number
  /** Sun azimuth, degrees, about +Y from +X toward +Z. */
  sunAzimuth?: number
  sunIntensity?: number
  /** Half-extent of the shadow frustum (world units) around the origin. */
  shadowRadius?: number
  shadowMapSize?: number
  /** Distance fog far plane; omit for no fog. */
  fogFar?: number
  /**
   * Procedural sky as the background *and* the source of ambient. Default on.
   *
   * Off falls back to what this did before: a neutral `RoomEnvironment` PMREM and whatever background the
   * stage set. Kept because it is what a headless or GPU-less path gets, and because it is the control when
   * comparing the sky against a photograph.
   */
  sky?: boolean
  skyParams?: Partial<SkyParams>
  /** Cubemap face size for the sky bake. 512 already exceeds what a gradient can use. */
  skyFaceSize?: number
  /**
   * How much the environment map lights the scene (`scene.environmentIntensity`). Separate from
   * `scene.backgroundIntensity`, so turning this down does **not** dim the sky you look at.
   *
   * Defaults to 0.2 with the sky on. At 1 the measured irradiance on an up-facing surface is
   * `[0.19, 1.59, 4.03]` — blue twenty-one times red, and stronger than the 2.4 key light, so a saturated sky
   * washes the whole scene blue and flattens its shadows. The red channel being 0.19 is the part that hurts:
   * a warm material gets essentially no fill.
   */
  environmentIntensity?: number
  /**
   * Hemisphere fill intensity. Defaults to **0** with the sky on, 0.35 without.
   *
   * Zero because the fill is **content** now: a node with a `Light` of kind `hemisphere` (ADR 0048). It used to
   * be hardcoded at 0.4 as the neutral counterweight to the sky's blue cast, and leaving that in alongside an
   * authored one would light every level twice. Kept as an option so the no-sky path is unchanged and a debug
   * pane can still reach it.
   */
  fillIntensity?: number
}

export interface GreyboxEnvironment {
  sun: THREE.DirectionalLight
  /**
   * Hemisphere fill. With the sky on it is white over mid grey and exists to neutralise the environment's
   * colour cast; without one it is the cool-over-dark pair that complements the studio PMREM.
   */
  fill: THREE.HemisphereLight
  sky: ProceduralSky | null
  /** Live sun angles. Mutate, then `refresh()`. Shaped for a Tweakpane binding. */
  sunAngles: SunAngles
  /** Live sky parameters. Mutate, then `refresh()`. */
  skyParams: SkyParams
  /** Re-derive everything from `sunAngles` and `skyParams`: light, shadow frustum, sky bake, PMREM. */
  refresh: () => void
  /**
   * Apply a level's `config.environment` (ADR 0048). Any part absent falls back to the renderer's defaults, so
   * a level that pins only its sun keeps this sky.
   *
   * One call for all three, because they are coupled: the sun's angles move the sky's glow (ADR 0046), and
   * `ambient` is the strength of the environment map the sky bakes. Setting one without rebaking is what would
   * let them disagree.
   */
  applyEnvironment: (env: Partial<EnvironmentConfig> | undefined) => void
  dispose: () => void
}

export interface Sky {
  texture: THREE.Texture
  /** Restore whatever background was there before, and free the texture. */
  dispose: () => void
}

/**
 * Put an equirectangular texture behind the scene (ADR 0045).
 *
 * **Background only.** `scene.environment` keeps the neutral `RoomEnvironment` PMREM that
 * `applyGreyboxEnvironment` installs, so hanging a sky does not relight the level. Lighting *from* the sky is
 * a different change and a worse one with this image: it is 8-bit sRGB, so it carries no sun. A PMREM built
 * from it would give flat ambient with none of the directional energy an HDR sky has.
 *
 * Split from `loadSky` so the half with no I/O in it is testable.
 */
export const installSky = (scene: THREE.Scene, texture: THREE.Texture): Sky => {
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  const previous = scene.background
  scene.background = texture
  return {
    texture,
    dispose: () => {
      if (scene.background === texture) scene.background = previous
      texture.dispose()
    },
  }
}

/**
 * Load an equirectangular sky and install it, or warn and return `null` if it will not load, leaving the
 * background as it was. A missing sky costs the backdrop, not the session — the same call `addLevel` makes for
 * a material reference that has gone stale.
 */
export const loadSky = async (scene: THREE.Scene, url: string): Promise<Sky | null> => {
  try {
    return installSky(scene, await new THREE.TextureLoader().loadAsync(url))
  } catch (cause) {
    console.warn(`sky: could not load ${url}`, cause)
    return null
  }
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

  const withSky = opts.sky !== false
  const sunAngles: SunAngles = { elevationDeg: opts.sunElevation ?? 30, azimuthDeg: opts.sunAzimuth ?? 38 }
  const skyParams: SkyParams = { ...DEFAULT_SKY_PARAMS, ...opts.skyParams }

  // Ambient. With the sky on it comes from the sky itself, which is only honest now that the sky is HDR: a
  // Preetham bake carries real sun energy, where an 8-bit photograph carries none (ADR 0045, ADR 0046).
  // Without it, the neutral studio room, as before.
  scene.environmentIntensity = opts.environmentIntensity ?? (withSky ? 0.2 : 1)

  const sky = withSky ? createProceduralSky(renderer, opts.skyFaceSize) : null
  let roomEnv: THREE.Texture | null = null
  if (sky === null) {
    const pmrem = new THREE.PMREMGenerator(renderer)
    roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = roomEnv
    pmrem.dispose()
  }

  const bg = scene.background instanceof THREE.Color ? scene.background : new THREE.Color(0x0b1020)
  if (opts.fogFar !== undefined) scene.fog = new THREE.Fog(bg.getHex(), opts.fogFar * 0.25, opts.fogFar)

  // Key light — the shadow caster. Frustum is sized to the level footprint by the caller.
  const r = opts.shadowRadius ?? 30
  const distance = r * 1.25
  const sun = new THREE.DirectionalLight(0xffffff, opts.sunIntensity ?? 2.2)
  sun.castShadow = true
  const mapSize = opts.shadowMapSize ?? 2048
  sun.shadow.mapSize.set(mapSize, mapSize)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = distance + r * 2
  sun.shadow.camera.left = -r
  sun.shadow.camera.right = r
  sun.shadow.camera.top = r
  sun.shadow.camera.bottom = -r
  sun.shadow.bias = -0.0002
  sun.shadow.normalBias = 0.02
  sun.shadow.camera.updateProjectionMatrix()
  scene.add(sun)
  scene.add(sun.target) // target at origin

  // Fill. Without a sky it is the old cool-over-dark pair, complementing the neutral studio PMREM. With one it
  // has a different job — neutralising a coloured environment — so it is white over mid grey: white to put the
  // red channel back, grey below to stand in for the ground bounce a dark-bottomed sky does not provide.
  const fill = withSky
    ? new THREE.HemisphereLight(0xffffff, 0x808080, opts.fillIntensity ?? 0)
    : new THREE.HemisphereLight(0xbcd4ff, 0x2b2b2b, opts.fillIntensity ?? 0.35)
  scene.add(fill)

  const refresh = (): void => {
    sun.position.copy(sunDirection(sunAngles)).multiplyScalar(distance)
    if (sky === null) return
    sky.bake(sunAngles, skyParams)
    scene.background = sky.background
    scene.environment = sky.environment()
  }
  refresh()

  /** The renderer's own values, and what any part a level leaves out falls back to. */
  const defaults: EnvironmentConfig = {
    sun: {
      elevation: sunAngles.elevationDeg,
      azimuth: sunAngles.azimuthDeg,
      intensity: sun.intensity,
      color: '#ffffff',
      shadows: true,
    },
    ambient: { intensity: scene.environmentIntensity },
    sky: { ...skyParams },
  }

  return {
    sun,
    fill,
    sky,
    sunAngles,
    skyParams,
    refresh,
    applyEnvironment: (from) => {
      const s = from?.sun ?? defaults.sun
      sunAngles.elevationDeg = s.elevation
      sunAngles.azimuthDeg = s.azimuth
      sun.intensity = s.intensity
      sun.color.setStyle(s.color, THREE.SRGBColorSpace)
      sun.castShadow = s.shadows

      scene.environmentIntensity = (from?.ambient ?? defaults.ambient).intensity

      // Assigned key by key rather than replaced, because `skyParams` is the object a debug pane is bound to:
      // swapping it would leave the pane editing a value nothing reads.
      Object.assign(skyParams, from?.sky ?? defaults.sky)

      refresh()
    },
    dispose: () => {
      scene.remove(sun, sun.target, fill)
      if (sky !== null) {
        if (scene.background === sky.background) scene.background = null
        sky.dispose()
      }
      if (roomEnv !== null) {
        if (scene.environment === roomEnv) scene.environment = null
        roomEnv.dispose()
      } else scene.environment = null
      scene.fog = null
    },
  }
}
