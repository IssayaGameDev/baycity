import * as THREE from 'three'

/**
 * Minimal Three.js plumbing on WebGL2 (SEED §2): renderer + scene + camera +
 * a render loop, with resize handling. Deliberately unopinionated — scene
 * content (lights, meshes) is the game's concern (SEED §6, law 3). Browser only.
 */
export interface ThreeStage {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  /** Begin the rAF loop; `onFrame(dtSeconds)` runs before each render. */
  start: (onFrame: (dtSeconds: number) => void) => void
  stop: () => void
  dispose: () => void
}

export interface ThreeStageOptions {
  canvas: HTMLCanvasElement
  cameraPosition?: readonly [number, number, number]
  lookAt?: readonly [number, number, number]
  background?: number
}

export const createThreeStage = (opts: ThreeStageOptions): ThreeStage => {
  const renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(opts.background ?? 0x0b1020)

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  const [cx, cy, cz] = opts.cameraPosition ?? [0, 12, 20]
  camera.position.set(cx, cy, cz)
  const [lx, ly, lz] = opts.lookAt ?? [0, 1, 0]
  camera.lookAt(lx, ly, lz)

  const resize = (): void => {
    const w = opts.canvas.clientWidth || opts.canvas.width
    const h = opts.canvas.clientHeight || opts.canvas.height
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  let onFrame: ((dtSeconds: number) => void) | null = null
  let raf = 0
  let last = 0
  let running = false

  const loop = (): void => {
    if (!running) return
    const now = performance.now()
    const dt = last === 0 ? 0 : (now - last) / 1000
    last = now
    onFrame?.(dt)
    renderer.render(scene, camera)
    raf = requestAnimationFrame(loop)
  }

  return {
    scene,
    camera,
    renderer,
    start: (frame) => {
      onFrame = frame
      if (running) return
      running = true
      last = 0
      raf = requestAnimationFrame(loop)
    },
    stop: () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
    },
    dispose: () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      renderer.dispose()
    },
  }
}
