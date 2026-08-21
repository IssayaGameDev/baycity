import type { Vec3 } from '@mp/core'
import * as THREE from 'three'

/**
 * The see-through hole (ADR 0055): whatever sits between the eye and the character dithers away, instead
 * of the camera being pulled in to get around it.
 *
 * **A cone, not a cylinder.** The masked volume runs from the eye to the target, widening to `radius` at
 * the target. A cone subtends a constant angle, so the hole is the same size on screen whether the camera
 * is 3 m or 14 m out — which is what "a hole around the character" has to mean. A constant world radius
 * would be a small hole up close and a huge one far away.
 *
 * **Only the surfaces actually in the way wear it**, which is why the cone needs no second test. Two
 * earlier versions tried to keep the hole off the floor by *position* — stop short of the character, then
 * a depth slab from the probe's own hits — and both broke, because no test on where a fragment is can tell
 * "the platform overhead" from "the floor beside my feet": from a high camera the floor is nearer to the
 * eye than the character and right beside the sight line. The slab also only worked for a surface square-on
 * to the view; an oblique one has its depth varying across its face, so the hole came out as a band across
 * it. The sightline is the only thing that knows, and the sightline is a cast. So the level view swaps in a
 * masked copy of a material for the meshes a cast reports and leaves everything else alone.
 *
 * **Dither, not alpha.** Fragments are `discard`ed against a per-pixel threshold, so the copy stays opaque:
 * no transparency sorting, no render-order list. Discarded fragments write no depth, so what is behind them
 * shows through, and the shadow pass is a different material entirely — the wall keeps casting its shadow,
 * only its pixels go.
 *
 * **One set of uniforms, shared by reference** across every variant, so `set` costs nothing per material
 * and the whole effect is driven from one place.
 *
 * The renderer owns the *shape* of the effect and none of its numbers: the caller supplies the whole
 * state, including how wide the hole is and how fast it appears.
 */
export interface CutoutState {
  /** The eye. Apex of the cone. */
  camera: Vec3
  /**
   * What must stay visible, and the **middle of it** — the base of the cone sits here, so this is what the
   * hole is centred on. The camera's own look target is not it: that is framing, and it sits at the top of
   * the head, which centres the hole there and leaves the feet outside.
   */
  target: Vec3
  /** Hole radius at the target, in metres. Wide enough to clear the character's silhouette. */
  radius: number
  /** Soft edge, as a fraction of `radius`. The dither ramps from solid to gone across it. */
  feather: number
  /**
   * 0 = nothing masked, 1 = the hole as `radius` describes it.
   *
   * An on/off switch in practice: animating it puts the *whole* disc through a stipple on the way in and
   * out, which across a wide surface is a great deal of crawling noise. Growing `radius` instead keeps the
   * interior fully cut from the first frame, so stipple only ever lives in the feather ring and the hole
   * reads as an aperture opening. That is what the parkour camera does.
   */
  strength: number
}

export interface CutoutMask {
  /** Update the mask. The uniforms are shared, so this reaches every variant at once. */
  set: (next: Partial<CutoutState>) => void
  /** The current values. */
  state: () => CutoutState
  /**
   * A copy of `material` that dithers inside the cone, for a mesh that is currently in the way. A **copy**,
   * because a material is shared by every piece using it and only some of them are occluding.
   *
   * A fresh one per call: the caller keeps them, swaps them in and out, and disposes them, which is the
   * same ownership the level view already has for the geometry it builds. Every variant shares one
   * `onBeforeCompile`, so `Material.customProgramCacheKey` — its source text — matches across them and
   * they share a compiled program.
   *
   * A material whose shader has no anchor to inject at comes back as a copy that simply never dithers —
   * see `injectCutout`.
   */
  variant: (material: THREE.Material) => THREE.Material
}

/** Where the world position is captured. Every built-in Three vertex shader has this, after `transformed`. */
const VERTEX_ANCHOR = '#include <project_vertex>'
/** Where the test goes: the top of `main`, so a discarded fragment costs no lighting. */
const FRAGMENT_ANCHOR = 'void main() {'

const VERTEX_HEAD = 'varying vec3 mpCutWorld;\n'

const VERTEX_BODY = `
	mpCutWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`

const FRAGMENT_HEAD = `varying vec3 mpCutWorld;
uniform vec3 mpCutCamera;
uniform vec3 mpCutTarget;
uniform float mpCutRadius;
uniform float mpCutFeather;
uniform float mpCutStrength;
// Interleaved gradient noise: a stable per-pixel threshold from the fragment's screen position, with no
// array indexing — GLSL ES 1.00, which is what Three compiles its built-ins as, forbids indexing a
// constant array by a non-constant expression, so a Bayer matrix is not available here.
float mpCutDither( vec2 p ) {
	return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
}
`

const FRAGMENT_BODY = `
	// The see-through hole (ADR 0055). Transcribed from \`cutoutCoverage\` in cutout.ts, which is the
	// tested copy: change one and change the other.
	if ( mpCutStrength > 0.0 ) {
		vec3 mpCutAxis = mpCutTarget - mpCutCamera;
		float mpCutSpan = length( mpCutAxis );
		if ( mpCutSpan > 0.001 ) {
			vec3 mpCutDir = mpCutAxis / mpCutSpan;
			float mpCutAlong = dot( mpCutWorld - mpCutCamera, mpCutDir );
			// In front of the eye, and that is the only bound. Cutting it off *at* the character is a plane
			// perpendicular to the view again, and it shows as a hard straight edge across the hole where
			// the occluder carries on past them. Past the character the cone simply stops widening.
			if ( mpCutAlong > 0.0 ) {
				float mpCutPerp = length( mpCutWorld - mpCutCamera - mpCutDir * mpCutAlong );
				float mpCutInner = mpCutRadius * min( mpCutAlong / mpCutSpan, 1.0 );
				float mpCutOuter = mpCutInner * ( 1.0 + mpCutFeather ) + 0.0001;
				float mpCutCover = 1.0 - smoothstep( mpCutInner, mpCutOuter, mpCutPerp );
				if ( mpCutDither( gl_FragCoord.xy ) < mpCutCover * mpCutStrength ) discard;
			}
		}
	}
`

/**
 * The shader edit, as a pure function so it can be checked without a GL context.
 *
 * `injected` is false when the source has no anchor to hook — a hand-written `ShaderMaterial` with its own
 * `main`, say. That material simply does not participate: a surface that fails to dither is a lesser
 * failure than a level that fails to compile, and the flag is here so a caller can notice.
 */
export const injectCutout = (
  source: { vertexShader: string; fragmentShader: string },
): { vertexShader: string; fragmentShader: string; injected: boolean } => {
  if (!source.vertexShader.includes(VERTEX_ANCHOR) || !source.fragmentShader.includes(FRAGMENT_ANCHOR)) {
    return { vertexShader: source.vertexShader, fragmentShader: source.fragmentShader, injected: false }
  }
  return {
    vertexShader: VERTEX_HEAD + source.vertexShader.replace(VERTEX_ANCHOR, VERTEX_ANCHOR + VERTEX_BODY),
    fragmentShader: FRAGMENT_HEAD + source.fragmentShader.replace(FRAGMENT_ANCHOR, FRAGMENT_ANCHOR + FRAGMENT_BODY),
    injected: true,
  }
}

/**
 * How much of a world point the mask covers, 0 to 1 — the fraction of pixels the dither drops there.
 *
 * This is the specification `FRAGMENT_BODY` transcribes, and the only copy under test. Kept in TS because
 * the GLSL cannot be run here, and the geometry is the part that can be wrong in a way that looks almost
 * right (a cylinder instead of a cone, or a hole in things *behind* the character).
 */
export const cutoutCoverage = (s: CutoutState, point: Vec3): number => {
  if (s.strength <= 0) return 0
  const ax = s.target.x - s.camera.x
  const ay = s.target.y - s.camera.y
  const az = s.target.z - s.camera.z
  const span = Math.hypot(ax, ay, az)
  if (span <= 0.001) return 0
  const dx = ax / span
  const dy = ay / span
  const dz = az / span
  const px = point.x - s.camera.x
  const py = point.y - s.camera.y
  const pz = point.z - s.camera.z
  const along = px * dx + py * dy + pz * dz
  if (along <= 0) return 0
  const perp = Math.hypot(px - dx * along, py - dy * along, pz - dz * along)
  const inner = s.radius * Math.min(along / span, 1)
  const outer = inner * (1 + s.feather) + 0.0001
  const t = Math.min(1, Math.max(0, (perp - inner) / (outer - inner)))
  return (1 - t * t * (3 - 2 * t)) * s.strength
}

export const createCutoutMask = (init: CutoutState): CutoutMask => {
  const current: CutoutState = { ...init }
  const uniforms = {
    mpCutCamera: { value: new THREE.Vector3(init.camera.x, init.camera.y, init.camera.z) },
    mpCutTarget: { value: new THREE.Vector3(init.target.x, init.target.y, init.target.z) },
    mpCutRadius: { value: init.radius },
    mpCutFeather: { value: init.feather },
    mpCutStrength: { value: init.strength },
  }
  // One closure for every material, so `Material.customProgramCacheKey` — which defaults to
  // `onBeforeCompile.toString()` — is identical across them and they share a compiled program.
  const patch = (shader: Parameters<THREE.Material['onBeforeCompile']>[0]): void => {
    Object.assign(shader.uniforms, uniforms)
    const out = injectCutout(shader)
    shader.vertexShader = out.vertexShader
    shader.fragmentShader = out.fragmentShader
  }
  return {
    set: (next) => {
      if (next.camera !== undefined) uniforms.mpCutCamera.value.set(next.camera.x, next.camera.y, next.camera.z)
      if (next.target !== undefined) uniforms.mpCutTarget.value.set(next.target.x, next.target.y, next.target.z)
      if (next.radius !== undefined) uniforms.mpCutRadius.value = next.radius
      if (next.feather !== undefined) uniforms.mpCutFeather.value = next.feather
      if (next.strength !== undefined) uniforms.mpCutStrength.value = next.strength
      // Vectors are copied, not aliased: the caller's `target` is usually a per-frame scratch object.
      Object.assign(current, next, {
        camera: { ...(next.camera ?? current.camera) },
        target: { ...(next.target ?? current.target) },
      })
    },
    state: () => ({ ...current }),
    // A clone is a new object, and Three keys its compiled-program bookkeeping by the material itself, so
    // the copy is compiled fresh with the patch in place. Nothing needs invalidating.
    variant: (material) => {
      const copy = material.clone()
      copy.onBeforeCompile = patch
      return copy
    },
  }
}
