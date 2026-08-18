import * as THREE from 'three'

/**
 * Asset thumbnails: render a subject once into a small offscreen canvas and hand back a data URL.
 *
 * Cost is the whole design. One renderer with its own GL context is created lazily and reused for every
 * thumbnail; a subject is rendered **once** and the caller caches the image, so a panel that redraws on
 * every selection change is showing `<img>` tags and touching no GL at all. At 96 px a preview is a few
 * thousand pixels of a few dozen triangles, which is why this can be synchronous and still not be felt.
 *
 * `preserveDrawingBuffer` is on because `toDataURL` has to read the buffer after the draw; without it the
 * result is empty on some drivers. It costs nothing here and would be wrong on a full-size canvas.
 */
export interface Thumbnailer {
  /** Frame `subject` and render it. The subject is not added to any scene the caller owns. */
  render: (subject: THREE.Object3D) => string
  /** A material on a sphere, the way Unity previews one. */
  renderMaterial: (material: THREE.Material) => string
  dispose: () => void
}

export interface ThumbnailerOptions {
  /** Pixel size of the square preview. */
  size?: number
  /** How much of the frame the subject fills, 0..1. Below 1 leaves air so nothing touches the edge. */
  fill?: number
}

/**
 * Distance a perspective camera must sit from a bounding sphere of `radius` for it to fit the frame.
 *
 * Pure, and the one piece of this worth testing: `sin` rather than `tan` because what has to fit is the
 * sphere's silhouette, not a plane through its centre — using `tan` crops a sphere at the edges of the view.
 * The wider of the two half-angles wins, so a non-square frame fits vertically *and* horizontally.
 */
export const fitDistance = (radius: number, vFovDeg: number, aspect: number, fill = 0.9): number => {
  if (radius <= 0) return 1
  const vHalf = (vFovDeg * Math.PI) / 360
  const hHalf = Math.atan(Math.tan(vHalf) * aspect)
  const half = Math.min(vHalf, hHalf) // the tighter axis is the one that decides
  return radius / Math.sin(half) / Math.max(0.05, Math.min(1, fill))
}

/** Looking down from front-left, which reads as three-dimensional rather than flat-on. */
const VIEW_DIR = new THREE.Vector3(1, 0.75, 1).normalize()

export const createThumbnailer = (opts: ThumbnailerOptions = {}): Thumbnailer => {
  const size = opts.size ?? 96
  const fill = opts.fill ?? 0.85

  let renderer: THREE.WebGLRenderer | null = null
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000)

  // A fixed three-light rig, not the game's environment: a preview has to read the same whatever the
  // level's lighting happens to be, and an IBL probe per thumbnail would cost more than the thumbnail.
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(3, 4, 5)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.7)
  fillLight.position.set(-4, 1, -2)
  scene.add(key, fillLight, new THREE.AmbientLight(0xffffff, 0.55))

  const holder = new THREE.Group()
  scene.add(holder)

  // One sphere, reused for every material preview.
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32))

  const ensureRenderer = (): THREE.WebGLRenderer => {
    if (renderer !== null) return renderer
    const made = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    made.setPixelRatio(1) // a thumbnail gains nothing from device pixel ratio and pays for it squared
    made.setSize(size, size, false)
    made.setClearColor(0x000000, 0)
    made.toneMapping = THREE.ACESFilmicToneMapping // match the game's grading, or previews read wrong
    made.outputColorSpace = THREE.SRGBColorSpace
    renderer = made
    return made
  }

  const shoot = (subject: THREE.Object3D): string => {
    const gl = ensureRenderer()
    holder.add(subject)

    // Frame whatever it turned out to be, rather than assuming a size: a kit platform is 3 m across and a
    // pad is 0.2 m tall.
    const box = new THREE.Box3().setFromObject(subject)
    const centre = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length() / 2

    camera.position.copy(centre).addScaledVector(VIEW_DIR, fitDistance(radius, camera.fov, 1, fill))
    camera.near = Math.max(0.01, radius * 0.05)
    camera.far = radius * 20 + 10
    camera.updateProjectionMatrix()
    camera.lookAt(centre)

    gl.render(scene, camera)
    const url = gl.domElement.toDataURL('image/png')
    holder.remove(subject)
    return url
  }

  return {
    render: shoot,
    renderMaterial: (material) => {
      sphere.material = material
      return shoot(sphere)
    },
    dispose: () => {
      renderer?.dispose()
      renderer = null
      sphere.geometry.dispose()
    },
  }
}
