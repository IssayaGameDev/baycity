import { THREE } from '@mp/render-three'

/**
 * The navigation gizmo in the viewport's top-right corner (ADR 0094).
 *
 * Blender's shape, Unity's centre: three sticks with six balls, positive axes filled and lettered and negative
 * ones hollow; click a ball to look down that axis, drag anywhere on it to orbit, click the middle to swap
 * perspective for isometric. The label under it says which projection is on, because a projection you cannot
 * name is a projection you forget you are in.
 *
 * Deliberately not `three/examples/jsm/helpers/ViewHelper`, which is the same idea: it draws bottom-right from
 * a hard-coded viewport, it has no drag-to-orbit, and it has no centre. Two of its three methods would have
 * been replaced, so this borrows its proven parts — the inverted-camera quaternion, the sprite balls, the
 * scratch ortho camera — and owns the rest.
 *
 * Snapping does **not** change the projection (Kodjo's call): looking from the side and drawing without
 * perspective are two decisions, and Blender's "Auto Perspective", which fuses them, is the setting people
 * turn off first.
 */
export interface ViewGizmo {
  /**
   * Draw it. Call **after** post-processing has put its image on the canvas: this clears depth and draws over
   * the corner, so anything composited afterwards would cover it.
   */
  render: (renderer: THREE.WebGLRenderer) => void
  /** Advance the snap animation. `true` while it is still moving — the caller should keep rendering. */
  update: (dtSeconds: number) => boolean
  /** True while a snap is animating: the viewport should not also act on the pointer. */
  readonly animating: boolean
  /**
   * A `pointerdown` over the canvas. `true` means the gizmo took it, and the viewport must not treat it as a
   * selection click or an orbit — the gizmo is now tracking the pointer until `pointerUp`.
   */
  pointerDown: (event: PointerEvent) => boolean
  /** A `pointermove` while the gizmo holds the pointer. */
  pointerMove: (event: PointerEvent) => void
  /** A `pointerup`. Returns `'centre'` when the press was a click on the middle, so the caller can toggle. */
  pointerUp: (event: PointerEvent) => 'centre' | 'axis' | null
  /** Re-letter the projection label. */
  setLabel: (text: string) => void
  dispose: () => void
}

export interface ViewGizmoOptions {
  /** The camera being navigated. A getter, because the editor swaps perspective for orthographic. */
  camera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera
  /** What the camera orbits — `OrbitControls.target`, read live. */
  target: () => THREE.Vector3
  /** The viewport canvas, for hit-testing in its own coordinates. */
  dom: HTMLCanvasElement
  /** Side of the square the gizmo occupies, in CSS pixels. */
  size?: number
  /** Seconds a snap takes. */
  snapSeconds?: number
}

type AxisName = 'posX' | 'posY' | 'posZ' | 'negX' | 'negY' | 'negZ'

const AXES: readonly { name: AxisName; dir: THREE.Vector3; colour: number; letter: string | null }[] = [
  { name: 'posX', dir: new THREE.Vector3(1, 0, 0), colour: 0xff4466, letter: 'X' },
  { name: 'posY', dir: new THREE.Vector3(0, 1, 0), colour: 0x88ff44, letter: 'Y' },
  { name: 'posZ', dir: new THREE.Vector3(0, 0, 1), colour: 0x4488ff, letter: 'Z' },
  { name: 'negX', dir: new THREE.Vector3(-1, 0, 0), colour: 0xff4466, letter: null },
  { name: 'negY', dir: new THREE.Vector3(0, -1, 0), colour: 0x88ff44, letter: null },
  { name: 'negZ', dir: new THREE.Vector3(0, 0, -1), colour: 0x4488ff, letter: null },
]

/** Past this many pixels a press stops being a click and becomes an orbit drag. */
const DRAG_SLOP = 4
/** Radians of orbit per pixel dragged. Matches OrbitControls' own feel closely enough not to jar. */
const ORBIT_PER_PIXEL = 0.01
/** How close to straight up the camera may get. Exactly up makes the orbit's azimuth undefined. */
const POLAR_LIMIT = 0.001

/**
 * Where a click landed inside the gizmo square, as -1..1 on each axis, or `null` when it missed.
 *
 * The square is the canvas's **top-right** corner, so its left edge is `width - dim` and its top edge is 0.
 * Pure and exported for the test: this is the arithmetic that decides whether the gizmo swallows a click, and
 * getting it wrong means either a dead corner or a gizmo that eats clicks meant for the scene.
 */
export const gizmoPointer = (
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
  canvasWidth: number,
  dim: number,
): { x: number; y: number } | null => {
  const x = clientX - rect.left - (canvasWidth - dim)
  const y = clientY - rect.top
  if (x < 0 || y < 0 || x > dim || y > dim) return null
  return { x: (x / dim) * 2 - 1, y: -(y / dim) * 2 + 1 }
}

/**
 * Orbit a camera position about a target by a pointer delta, in the spherical terms the orbit controls use.
 *
 * Clamped off the poles: straight up leaves the azimuth undefined, and a camera that reaches it spins on the
 * spot. Pure and exported for the test.
 */
export const orbitAround = (
  position: THREE.Vector3,
  target: THREE.Vector3,
  dx: number,
  dy: number,
  radiansPerPixel: number = ORBIT_PER_PIXEL,
): THREE.Vector3 => {
  const offset = position.clone().sub(target)
  const spherical = new THREE.Spherical().setFromVector3(offset)
  spherical.theta -= dx * radiansPerPixel
  spherical.phi = Math.max(POLAR_LIMIT, Math.min(Math.PI - POLAR_LIMIT, spherical.phi - dy * radiansPerPixel))
  return offset.setFromSpherical(spherical).add(target)
}

/** A ball: a filled disc in the axis colour, lettered for the positive three, translucent for the negative. */
const ballTexture = (colour: number, letter: string | null): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    ctx.beginPath()
    ctx.arc(32, 32, 16, 0, 2 * Math.PI)
    ctx.closePath()
    ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
    ctx.fill()
    if (letter !== null) {
      ctx.font = 'bold 26px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillStyle = '#0b1020'
      ctx.fillText(letter, 32, 41)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const labelTexture = (text: string): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 48
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    ctx.font = 'bold 26px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#cbd5e1'
    ctx.fillText(text, 64, 26)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export const createViewGizmo = (opts: ViewGizmoOptions): ViewGizmo => {
  const dim = opts.size ?? 128
  const snapSeconds = opts.snapSeconds ?? 0.35

  const scene = new THREE.Scene()
  const root = new THREE.Object3D()
  scene.add(root)
  // Framed so a unit axis sits well inside, leaving room for the balls and the label below.
  const view = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 4)
  view.position.z = 2

  // --- the three sticks, drawn from the centre outward ---
  const stick = new THREE.CylinderGeometry(0.045, 0.045, 0.8, 6).rotateZ(-Math.PI / 2).translate(0.4, 0, 0)
  const stickMaterials: THREE.MeshBasicMaterial[] = []
  for (const [i, colour] of [0xff4466, 0x88ff44, 0x4488ff].entries()) {
    const material = new THREE.MeshBasicMaterial({ color: colour, toneMapped: false })
    stickMaterials.push(material)
    const mesh = new THREE.Mesh(stick, material)
    if (i === 1) mesh.rotation.z = Math.PI / 2
    if (i === 2) mesh.rotation.y = -Math.PI / 2
    root.add(mesh)
  }

  // --- the six balls ---
  const balls: THREE.Sprite[] = []
  const ballTextures: THREE.CanvasTexture[] = []
  for (const axis of AXES) {
    const texture = ballTexture(axis.colour, axis.letter)
    ballTextures.push(texture)
    const material = new THREE.SpriteMaterial({ map: texture, toneMapped: false, transparent: true })
    // Hollow-looking negatives, as Blender draws them: the same ball, faded back.
    if (axis.letter === null) material.opacity = 0.35
    const sprite = new THREE.Sprite(material)
    sprite.position.copy(axis.dir)
    sprite.scale.setScalar(0.5)
    sprite.userData.axis = axis.name
    root.add(sprite)
    balls.push(sprite)
  }

  // --- the centre: Unity's projection toggle ---
  const centreGeometry = new THREE.SphereGeometry(0.19, 16, 12)
  const centreMaterial = new THREE.MeshBasicMaterial({ color: 0x94a3b8, toneMapped: false })
  const centre = new THREE.Mesh(centreGeometry, centreMaterial)
  root.add(centre)

  // --- the projection label, under the gizmo and not rotating with it ---
  let labelMap = labelTexture('Persp')
  const labelMaterial = new THREE.SpriteMaterial({ map: labelMap, toneMapped: false, transparent: true })
  const label = new THREE.Sprite(labelMaterial)
  label.position.set(0, -1.62, 0)
  label.scale.set(1.5, 0.56, 1)
  scene.add(label) // on the scene, not the root: it reads as text, so it must not tumble

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const viewport = new THREE.Vector4()

  /** Pointer position inside the gizmo square, as -1..1, or null when the event is outside it. */
  const localPointer = (event: PointerEvent): THREE.Vector2 | null => {
    const rect = opts.dom.getBoundingClientRect()
    const at = gizmoPointer(rect, event.clientX, event.clientY, opts.dom.clientWidth, dim)
    return at === null ? null : pointer.set(at.x, at.y)
  }

  // --- snap animation ---
  let animating = false
  let elapsed = 0
  let radius = 0
  const fromDir = new THREE.Vector3()
  const turn = new THREE.Quaternion()
  const scratch = new THREE.Vector3()
  const focus = new THREE.Vector3()

  const startSnap = (dir: THREE.Vector3): void => {
    const camera = opts.camera()
    focus.copy(opts.target())
    radius = camera.position.distanceTo(focus)
    // A camera sitting exactly on its target has no direction to turn from; treat it as already there.
    if (radius < 1e-6) return
    fromDir.copy(camera.position).sub(focus).normalize()
    // Antiparallel is the one case `setFromUnitVectors` has to invent an axis for, and it does.
    turn.setFromUnitVectors(fromDir, dir)
    elapsed = 0
    animating = true
  }

  const update = (dt: number): boolean => {
    if (!animating) return false
    elapsed = Math.min(snapSeconds, elapsed + dt)
    const t = snapSeconds <= 0 ? 1 : elapsed / snapSeconds
    // Ease in and out, so the snap reads as a move rather than a cut.
    const eased = t * t * (3 - 2 * t)
    const step = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), turn, eased)
    scratch.copy(fromDir).applyQuaternion(step).multiplyScalar(radius).add(focus)
    const camera = opts.camera()
    camera.position.copy(scratch)
    camera.lookAt(focus)
    if (elapsed >= snapSeconds) animating = false
    return animating
  }

  // --- pointer ---
  let pressed: 'centre' | 'axis' | 'empty' | null = null
  let pressedAxis: THREE.Vector3 | null = null
  let dragged = false
  let lastX = 0
  let lastY = 0

  const orbit = (dx: number, dy: number): void => {
    const camera = opts.camera()
    focus.copy(opts.target())
    camera.position.copy(orbitAround(camera.position, focus, dx, dy))
    camera.lookAt(focus)
  }

  return {
    get animating() {
      return animating
    },

    render: (renderer) => {
      root.quaternion.copy(opts.camera().quaternion).invert()
      root.updateMatrixWorld()

      const previousAutoClear = renderer.autoClear
      renderer.getViewport(viewport)
      // Viewport coordinates count from the bottom, so the top-right corner is (width - dim, height - dim).
      renderer.setViewport(opts.dom.clientWidth - dim, opts.dom.clientHeight - dim, dim, dim)
      // Depth only: the colour already on the canvas is the scene, and the gizmo sits on top of it.
      renderer.autoClear = false
      renderer.clearDepth()
      renderer.render(scene, view)
      renderer.autoClear = previousAutoClear
      renderer.setViewport(viewport.x, viewport.y, viewport.z, viewport.w)
    },

    update,

    pointerDown: (event) => {
      if (animating) return false
      const local = localPointer(event)
      if (local === null) return false

      raycaster.setFromCamera(local, view)
      const onBall = raycaster.intersectObjects(balls, false)[0]
      const onCentre = raycaster.intersectObject(centre, false)[0]

      pressedAxis = null
      if (onBall !== undefined && (onCentre === undefined || onBall.distance <= onCentre.distance)) {
        pressed = 'axis'
        pressedAxis = AXES.find((a) => a.name === onBall.object.userData.axis)?.dir.clone() ?? null
      } else if (onCentre !== undefined) pressed = 'centre'
      else pressed = 'empty'

      dragged = false
      lastX = event.clientX
      lastY = event.clientY
      return true
    },

    pointerMove: (event) => {
      if (pressed === null) return
      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      if (!dragged && Math.hypot(event.clientX - lastX, event.clientY - lastY) < DRAG_SLOP) return
      // Past the slop the press is a drag, wherever it started — Blender orbits from the balls too.
      dragged = true
      lastX = event.clientX
      lastY = event.clientY
      orbit(dx, dy)
    },

    pointerUp: () => {
      const was = pressed
      const axis = pressedAxis
      pressed = null
      pressedAxis = null
      if (dragged || was === null || was === 'empty') return null
      if (was === 'centre') return 'centre'
      if (axis !== null) startSnap(axis)
      return 'axis'
    },

    setLabel: (text) => {
      const next = labelTexture(text)
      labelMaterial.map = next
      labelMaterial.needsUpdate = true
      labelMap.dispose()
      labelMap = next
    },

    dispose: () => {
      stick.dispose()
      for (const m of stickMaterials) m.dispose()
      for (const s of balls) s.material.dispose()
      for (const t of ballTextures) t.dispose()
      centreGeometry.dispose()
      centreMaterial.dispose()
      labelMaterial.dispose()
      labelMap.dispose()
    },
  }
}
