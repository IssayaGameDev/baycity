import type { SkyConfig } from '@mp/content'
import * as THREE from 'three'

/**
 * The sky (ADR 0046): a **designed vertical gradient** with a sun glow, baked once to a cubemap that serves as
 * both the background and the source of the scene's image-based lighting.
 *
 * Not atmospheric scattering. Preetham (three's `Sky.js`) was tried first and is the wrong tool: its defining
 * behaviour is that the horizon is brighter than the zenith, because that is what looking through more air
 * does. Measured, that put a band of luminance 0.64 between a 0.22 zenith and the ground — a bright strip
 * across the middle of the sky, which no parameter of the model removes because it *is* the model. Kodjo wants
 * light at the top falling monotonically to dark at the bottom, which is the opposite shape.
 *
 * So the ramp is authored, and **monotonic by construction**: `t` rises with height and `pow` preserves that,
 * so no combination of the knobs can put a bright band in the middle. The bug is unrepresentable rather than
 * tuned away.
 *
 * **Baked, not drawn per frame.** A fixed sun makes a fixed sky. Baking also sidesteps three problems a sky
 * mesh in the scene has: it has to be scaled inside the camera's far plane (a box big enough to enclose a level
 * has corners past 1000), it has to follow the camera or the horizon parallaxes, and GTAO renders its own depth
 * pass with an override material, so a sky shell can land in that buffer and halo every silhouette.
 */

/** Where the sun is. Elevation above the horizon, azimuth measured about +Y from +X toward +Z. */
export interface SunAngles {
  elevationDeg: number
  azimuthDeg: number
}

/**
 * A unit vector toward the sun.
 *
 * Same convention as three's `equirectUv`, so an angle measured off an equirectangular image lands where the
 * image shows it: `azimuth = atan2(z, x)`, `elevation = asin(y)`.
 */
export const sunDirection = ({ elevationDeg, azimuthDeg }: SunAngles): THREE.Vector3 => {
  const el = THREE.MathUtils.degToRad(elevationDeg)
  const az = THREE.MathUtils.degToRad(azimuthDeg)
  const r = Math.cos(el)
  return new THREE.Vector3(r * Math.cos(az), Math.sin(el), r * Math.sin(az))
}

/**
 * Everything that decides how the sky looks. All of it live-tunable, and all of it **level data** now
 * (ADR 0048) — the shape lives in `@mp/content` because a level file holds it; this package owns the defaults,
 * which are a renderer opinion rather than a schema.
 */
export type SkyParams = SkyConfig

/**
 * Starting values, chosen by evaluating the ramp through three's ACES and the sRGB encode rather than by taste,
 * because ACES desaturates highlights hard and a light blue authored naively arrives as grey.
 *
 * The profile they give, luminance top to bottom: **zenith 0.58, 30 up 0.47, horizon 0.32, 20 down 0.20,
 * 50 down 0.05, nadir 0.01**, holding a blue hue the whole way (`#91d0ed` down to `#04122b`). Monotonic, no
 * band, dark at the bottom.
 *
 * `gain` is 2.6 and that is not a mistake: a saturated input has to be driven well past 1 for its chroma to
 * survive tone mapping. Authoring `#a8d2f0` at gain 1 measures out as `#c8d9e3`, a grey.
 */
export const DEFAULT_SKY_PARAMS: SkyParams = {
  topColor: '#2f86cc',
  bottomColor: '#0a1424',
  gradientBias: 1.15,
  gain: 2.6,
  glowColor: '#ffe6c0',
  glowSharpness: 200,
  glowStrength: 0.25,
  sunDiskIntensity: 400,
}

const VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // Object space, so the direction is independent of how far out the box is scaled.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

const FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 sunDir;
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  uniform vec3 glowColor;
  uniform float gradientBias;
  uniform float gain;
  uniform float glowSharpness;
  uniform float glowStrength;
  uniform float sunDiskIntensity;
  uniform float sunDiskOn;

  void main() {
    vec3 dir = normalize( vDir );

    // Monotonic in height, and pow keeps it that way: there is no setting that produces a bright band
    // between the two ends.
    float t = pow( clamp( dir.y * 0.5 + 0.5, 0.0, 1.0 ), gradientBias );
    vec3 color = mix( bottomColor, topColor, t );

    float toSun = max( 0.0, dot( dir, sunDir ) );
    color += glowColor * glowStrength * pow( toSun, glowSharpness );

    // The disc, about half a degree across. Switched off for the environment bake, because the
    // DirectionalLight already is the sun and counting it twice makes the duplicate the brightest term.
    color += glowColor * sunDiskIntensity * sunDiskOn * smoothstep( 0.99995, 0.99998, toSun );

    // Linear radiance out. No tonemapping or colour-space include, so ACES runs exactly once, at output.
    gl_FragColor = vec4( color * gain, 1.0 );
  }
`

/**
 * The uniform values a set of parameters implies. Pure, so the colour conversion and the clamps are testable
 * without a GPU.
 *
 * `setStyle` with an explicit sRGB source is what converts an authored hex into the linear working space;
 * `new Color(hex)` would depend on whether colour management happens to be enabled.
 */
export const skyUniformValues = (
  params: SkyParams,
  sun: SunAngles,
): { topColor: THREE.Color; bottomColor: THREE.Color; glowColor: THREE.Color; sunDir: THREE.Vector3; gradientBias: number; gain: number; glowSharpness: number; glowStrength: number; sunDiskIntensity: number } => ({
  topColor: new THREE.Color().setStyle(params.topColor, THREE.SRGBColorSpace),
  bottomColor: new THREE.Color().setStyle(params.bottomColor, THREE.SRGBColorSpace),
  glowColor: new THREE.Color().setStyle(params.glowColor, THREE.SRGBColorSpace),
  sunDir: sunDirection(sun),
  // A zero or negative bias would invert or flatten the ramp, which is the one shape this must never produce.
  gradientBias: Math.max(0.05, params.gradientBias),
  gain: Math.max(0, params.gain),
  glowSharpness: Math.max(1, params.glowSharpness),
  glowStrength: Math.max(0, params.glowStrength),
  sunDiskIntensity: Math.max(0, params.sunDiskIntensity),
})

export interface ProceduralSky {
  /** Linear-radiance cubemap. What `scene.background` wants. */
  readonly background: THREE.CubeTexture
  /** PMREM off a disc-free bake. What `scene.environment` wants. Replaced on every bake. */
  readonly environment: () => THREE.Texture
  /** Re-render the cubemap and rebuild the PMREM. Cheap enough to call from a slider. */
  bake: (sun: SunAngles, params: SkyParams) => void
  dispose: () => void
}

/**
 * Build the sky rig. Nothing is rendered until `bake` is called.
 *
 * The sky mesh lives in a private scene, so the cube camera sees the sky and nothing else — no level geometry,
 * no lights, no chance of a stray object baking itself into the environment map.
 *
 * Resolution is a non-issue: the sky is a smooth gradient with no detail to resolve, so 512 per face (the same
 * 5.7 texels per degree the 2k photograph had) is already past the point where more helps.
 */
export const createProceduralSky = (renderer: THREE.WebGLRenderer, faceSize = 512): ProceduralSky => {
  const material = new THREE.ShaderMaterial({
    name: 'GradientSky',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      topColor: { value: new THREE.Color() },
      bottomColor: { value: new THREE.Color() },
      glowColor: { value: new THREE.Color() },
      gradientBias: { value: DEFAULT_SKY_PARAMS.gradientBias },
      gain: { value: DEFAULT_SKY_PARAMS.gain },
      glowSharpness: { value: DEFAULT_SKY_PARAMS.glowSharpness },
      glowStrength: { value: DEFAULT_SKY_PARAMS.glowStrength },
      sunDiskIntensity: { value: DEFAULT_SKY_PARAMS.sunDiskIntensity },
      sunDiskOn: { value: 1 },
    },
  })

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
  const scene = new THREE.Scene()
  scene.add(mesh)

  const target = new THREE.WebGLCubeRenderTarget(faceSize, { type: THREE.HalfFloatType })
  const camera = new THREE.CubeCamera(0.01, 10, target)
  const pmrem = new THREE.PMREMGenerator(renderer)
  let env: THREE.WebGLRenderTarget | null = null

  const uniforms = material.uniforms
  const set = (key: string, value: number): void => {
    const uniform = uniforms[key]
    if (uniform === undefined) throw new Error(`sky shader: no uniform '${key}'`)
    uniform.value = value
  }

  return {
    background: target.texture,
    environment: () => {
      if (env === null) throw new Error('sky: bake() before reading the environment')
      return env.texture
    },
    bake: (sun, params) => {
      const v = skyUniformValues(params, sun)
      ;(uniforms.topColor!.value as THREE.Color).copy(v.topColor)
      ;(uniforms.bottomColor!.value as THREE.Color).copy(v.bottomColor)
      ;(uniforms.glowColor!.value as THREE.Color).copy(v.glowColor)
      ;(uniforms.sunDir!.value as THREE.Vector3).copy(v.sunDir)
      set('gradientBias', v.gradientBias)
      set('gain', v.gain)
      set('glowSharpness', v.glowSharpness)
      set('glowStrength', v.glowStrength)
      set('sunDiskIntensity', v.sunDiskIntensity)

      // Two renders into one target, PMREM first. The environment map is baked with the solar disc **off**,
      // because the DirectionalLight already is the sun: at these magnitudes the disc carries more irradiance
      // than the sky does, so counting it twice would make the duplicate the brightest thing lighting the
      // level. Then the background is re-rendered *with* the disc, because you should be able to see the sun.
      set('sunDiskOn', 0)
      camera.update(renderer, scene)
      // `fromCubemap` allocates, so the previous one has to go or every slider drag leaks a render target.
      const previous = env
      env = pmrem.fromCubemap(target.texture)
      previous?.dispose()

      set('sunDiskOn', 1)
      camera.update(renderer, scene)
    },
    dispose: () => {
      env?.dispose()
      pmrem.dispose()
      target.dispose()
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}
