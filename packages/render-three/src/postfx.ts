import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

/**
 * A pass that renders nothing and only flips visibility, so the AO pass between the two of them sees a
 * different scene from the one that was drawn. Two of these bracket it: the composer runs passes in order,
 * and the AO pass takes its own prepass of the scene when its turn comes.
 *
 * `needsSwap = false` — it does not touch the buffers, so the read and write targets stay as they were.
 */
class Toggle extends Pass {
  constructor(private readonly act: () => void) {
    super()
    this.needsSwap = false
  }

  override render(): void {
    this.act()
  }
}

/**
 * The pair, sharing the list of what was hidden — only what *this* bracket hid gets shown again, so an
 * object already invisible for its own reasons stays that way.
 */
const bracket = (which: () => Iterable<THREE.Object3D>): { hide: Pass; show: Pass } => {
  let hidden: THREE.Object3D[] = []
  return {
    hide: new Toggle(() => {
      hidden = [...which()].filter((o) => o.visible)
      for (const o of hidden) o.visible = false
    }),
    show: new Toggle(() => {
      for (const o of hidden) o.visible = true
      hidden = []
    }),
  }
}

/**
 * Post-processing pipeline (content pipeline C3): ground-truth ambient occlusion (GTAO)
 * to give greybox forms depth, ACES output (via `OutputPass`, reading the renderer's tone
 * mapping), edge antialiasing (SMAA), and optional bloom for the emissive accent styles.
 * All from `three/examples/jsm` — no new dependency. Drive `render()` from the stage's
 * render step. Owns its own resize handling.
 */
export interface PostFXOptions {
  /** Ambient occlusion (GTAO). Default on — it's most of the "polish" on flat greybox. */
  ao?: boolean
  /**
   * Objects the AO pass must not see, asked for afresh each frame.
   *
   * AO is screen-space: it reads depth and normals from a prepass of its own and multiplies the result onto
   * the colour image. That only holds while the two agree about what is at each pixel. A surface that
   * discards its own fragments (the see-through hole, ADR 0055) breaks the agreement — the colour image has
   * the character there, the prepass still has the surface — and the character comes out wearing occlusion
   * cast by something the player cannot see.
   *
   * Hiding those objects for the prepass makes the two agree again: the prepass sees the character too, and
   * shades it as itself. The surface's own AO is lost while it is listed, which on a flat slab is next to
   * nothing, and it is the same surface that is mostly not being drawn.
   */
  aoIgnores?: () => Iterable<THREE.Object3D>
  /** Bloom on emissive accents (moving/goal/checkpoint…). Default off. */
  bloom?: boolean
  bloomStrength?: number
  bloomRadius?: number
  bloomThreshold?: number
}

export interface PostFX {
  composer: EffectComposer
  /** The bloom pass (always present so it can be toggled live via `.enabled`). */
  bloom: UnrealBloomPass
  /**
   * The ambient-occlusion pass, or `null` when it was never created (`ao: false`). Exposed for the same
   * reason bloom is — `.enabled` is the only way to tell whether a shading artifact is AO's doing.
   */
  ao: GTAOPass | null
  render: () => void
  setSize: (width: number, height: number) => void
  dispose: () => void
}

export const createPostFX = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostFXOptions = {},
): PostFX => {
  const size = renderer.getSize(new THREE.Vector2())
  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(renderer.getPixelRatio())
  composer.setSize(size.x, size.y)

  composer.addPass(new RenderPass(scene, camera))

  let gtao: GTAOPass | null = null
  if (opts.ao !== false) {
    gtao = new GTAOPass(scene, camera, size.x, size.y)
    gtao.output = GTAOPass.OUTPUT.Default
    // Bracketed, so whatever `aoIgnores` names is absent from the AO prepass and present everywhere else.
    const skip = opts.aoIgnores === undefined ? null : bracket(opts.aoIgnores)
    if (skip !== null) composer.addPass(skip.hide)
    composer.addPass(gtao)
    if (skip !== null) composer.addPass(skip.show)
  }

  // Always present so the consumer can toggle it live; disabled passes are skipped.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    opts.bloomStrength ?? 0.35,
    opts.bloomRadius ?? 0.4,
    opts.bloomThreshold ?? 0.85,
  )
  bloom.enabled = opts.bloom === true
  composer.addPass(bloom)

  composer.addPass(new OutputPass())
  composer.addPass(new SMAAPass(size.x, size.y))

  const onResize = (): void => {
    const s = renderer.getSize(new THREE.Vector2())
    composer.setSize(s.x, s.y)
    gtao?.setSize(s.x, s.y)
  }
  window.addEventListener('resize', onResize)

  return {
    composer,
    bloom,
    ao: gtao,
    render: () => composer.render(),
    setSize: (w, h) => {
      composer.setSize(w, h)
      gtao?.setSize(w, h)
    },
    dispose: () => {
      window.removeEventListener('resize', onResize)
      composer.dispose()
    },
  }
}
