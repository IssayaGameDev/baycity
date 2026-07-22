import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

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
    composer.addPass(gtao)
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
