import { THREE } from '@mp/render-three'

/**
 * The navigation gizmo in the viewport's top-right corner (ADR 0094, reshaped by ADR 0149).
 *
 * Unity's: six cones pointing in at a cube, the positive three in their axis colours and lettered, the
 * negative three grey. Click a cone to look along it, drag anywhere on the gizmo to orbit, click the cube to
 * swap perspective for isometric. Whatever is under the pointer lights up, and each part answers over more
 * than its drawn shape — a sphere per cone, one round the cube — because the shapes are small and the corner
 * is where the pointer arrives fastest.
 *
 * The projection's name is **not** drawn here: it is a button under the gizmo (`cameraView.ts`), so it can be
 * clicked whichever way the gizmo is turned, even when a cone pointing straight out of the screen covers the
 * cube.
 *
 * Deliberately not `three/examples/jsm/helpers/ViewHelper`, which is the same idea: it draws bottom-right from
 * a hard-coded viewport, it has no drag-to-orbit, and it has no centre. This borrows its proven parts — the
 * inverted-camera quaternion, the scratch ortho camera — and owns the rest.
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
  /** A `pointerup`. Returns `'centre'` when the press was a click on the cube, so the caller can toggle. */
  pointerUp: (event: PointerEvent) => 'centre' | 'axis' | null
  /**
   * The pointer moved over the canvas without a press, or left it (`null`). Lights up the part under it and
   * says whether there is one, so the caller can show a pointer cursor.
   */
  hover: (event: PointerEvent | null) => boolean
  /** Side of the square the gizmo occupies, in CSS pixels — what the overlays beside and under it keep clear of. */
  readonly size: number
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
type Part = AxisName | 'centre'

/** The colours the transform gizmo uses for the same axes, so the two corners of the screen agree. */
const X = 0xff4466
const Y = 0x88ff44
const Z = 0x4488ff
/** The negative cones: Unity draws them grey, so the lettered three are the ones the eye finds. */
const NEGATIVE = 0x8a93a0
const CUBE = 0xc9d1dc
/** The cube's faces in `BoxGeometry`'s order (+X, −X, +Y, −Y, +Z, −Z): the top brightest, the bottom darkest. */
const FACE_SHADES = [0.82, 0.82, 1, 0.62, 0.92, 0.92] as const
/** The part under the pointer. */
const HOVER = 0xffd54a

const AXES: readonly { name: AxisName; dir: THREE.Vector3; colour: number; letter: string | null }[] = [
  { name: 'posX', dir: new THREE.Vector3(1, 0, 0), colour: X, letter: 'X' },
  { name: 'posY', dir: new THREE.Vector3(0, 1, 0), colour: Y, letter: 'Y' },
  { name: 'posZ', dir: new THREE.Vector3(0, 0, 1), colour: Z, letter: 'Z' },
  { name: 'negX', dir: new THREE.Vector3(-1, 0, 0), colour: NEGATIVE, letter: null },
  { name: 'negY', dir: new THREE.Vector3(0, -1, 0), colour: NEGATIVE, letter: null },
  { name: 'negZ', dir: new THREE.Vector3(0, 0, -1), colour: NEGATIVE, letter: null },
]

/** Half the width the gizmo's camera shows, in gizmo units. The cones reach 0.93 and the letters 1.37. */
const FRAME = 1.45
/** A cone: its tip toward the cube, its base out. */
const CONE_RADIUS = 0.19
const CONE_LENGTH = 0.6
const CONE_CENTRE = 0.63
const CUBE_SIDE = 0.36
const LETTER_AT = 1.2
/** How far each part answers the pointer: past its drawn shape, so a quick move lands on it. */
const CONE_REACH = 0.3
const CUBE_REACH = 0.26

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

/** A letter beside a positive cone, in the cone's colour. */
const letterTexture = (letter: string, colour: number): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    ctx.font = 'bold 44px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
    ctx.fillText(letter, 32, 35)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const UP = new THREE.Vector3(0, 1, 0)

export const createViewGizmo = (opts: ViewGizmoOptions): ViewGizmo => {
  const dim = opts.size ?? 128
  const snapSeconds = opts.snapSeconds ?? 0.35

  const scene = new THREE.Scene()
  const root = new THREE.Object3D()
  scene.add(root)
  const view = new THREE.OrthographicCamera(-FRAME, FRAME, FRAME, -FRAME, 0, 4)
  view.position.z = 2
  // It never moves, and picking reads its matrix: set once here, not left to the first render to do.
  view.updateMatrixWorld()

  /** Each part's materials and what colour each is at rest, so lighting one part up leaves the rest alone. */
  const materials = new Map<Part, { material: THREE.MeshBasicMaterial; colour: THREE.Color }[]>()
  /** The shapes the pointer is tested against, each naming its part. Never drawn. */
  const reach: THREE.Mesh[] = []
  const reachMaterial = new THREE.MeshBasicMaterial()

  // --- the six cones, tip toward the cube ---
  const cone = new THREE.ConeGeometry(CONE_RADIUS, CONE_LENGTH, 24)
  const coneReach = new THREE.SphereGeometry(CONE_REACH, 12, 8)
  const letters: THREE.Sprite[] = []
  for (const axis of AXES) {
    const material = new THREE.MeshBasicMaterial({ color: axis.colour, toneMapped: false })
    materials.set(axis.name, [{ material, colour: new THREE.Color(axis.colour) }])
    const mesh = new THREE.Mesh(cone, material)
    // A cone's tip is its +Y end; turned so it points back at the centre.
    mesh.quaternion.setFromUnitVectors(UP, axis.dir.clone().negate())
    mesh.position.copy(axis.dir).multiplyScalar(CONE_CENTRE)
    root.add(mesh)

    const hit = new THREE.Mesh(coneReach, reachMaterial)
    hit.position.copy(mesh.position)
    hit.visible = false // a raycast does not look at `visible`; the renderer does
    hit.userData.part = axis.name
    root.add(hit)
    reach.push(hit)

    if (axis.letter !== null) {
      const letter = new THREE.Sprite(new THREE.SpriteMaterial({ map: letterTexture(axis.letter, axis.colour), toneMapped: false, transparent: true }))
      letter.position.copy(axis.dir).multiplyScalar(LETTER_AT)
      letter.scale.setScalar(0.34)
      root.add(letter)
      letters.push(letter)
    }
  }

  // --- the cube: the projection toggle ---
  // A shade per face — lit from above, as the level is — or unlit it reads as a flat grey blob, not a cube.
  const cubeGeometry = new THREE.BoxGeometry(CUBE_SIDE, CUBE_SIDE, CUBE_SIDE)
  const cubeFaces = FACE_SHADES.map((shade) => {
    const colour = new THREE.Color(CUBE).multiplyScalar(shade)
    return { material: new THREE.MeshBasicMaterial({ color: colour, toneMapped: false }), colour }
  })
  materials.set('centre', cubeFaces)
  root.add(new THREE.Mesh(cubeGeometry, cubeFaces.map((f) => f.material)))
  const cubeReachGeometry = new THREE.SphereGeometry(CUBE_REACH, 12, 8)
  const cubeHit = new THREE.Mesh(cubeReachGeometry, reachMaterial)
  cubeHit.visible = false
  cubeHit.userData.part = 'centre'
  root.add(cubeHit)
  reach.push(cubeHit)

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const viewport = new THREE.Vector4()

  /** Pointer position inside the gizmo square, as -1..1, or null when the event is outside it. */
  const localPointer = (event: PointerEvent): THREE.Vector2 | null => {
    const rect = opts.dom.getBoundingClientRect()
    const at = gizmoPointer(rect, event.clientX, event.clientY, opts.dom.clientWidth, dim)
    return at === null ? null : pointer.set(at.x, at.y)
  }

  const face = (): void => {
    root.quaternion.copy(opts.camera().quaternion).invert()
    root.updateMatrixWorld()
  }

  /**
   * The part under the pointer: the **nearest** one it is over, so what is drawn in front is what is clicked.
   * `undefined` when the pointer is in the square but over none of them — which still orbits on a drag.
   */
  const partAt = (local: THREE.Vector2): Part | undefined => {
    face()
    raycaster.setFromCamera(local, view)
    return raycaster.intersectObjects(reach, false)[0]?.object.userData.part as Part | undefined
  }

  let hovered: Part | null = null
  const hoverColour = new THREE.Color(HOVER)
  const light = (part: Part | null): void => {
    if (part === hovered) return
    hovered = part
    for (const [name, faces] of materials) {
      for (const [i, f] of faces.entries()) {
        // A lit cube keeps its shading, so it still reads as a cube.
        if (name === part) f.material.color.copy(hoverColour).multiplyScalar(faces.length > 1 ? (FACE_SHADES[i] ?? 1) : 1)
        else f.material.color.copy(f.colour)
      }
    }
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
  let pressed: Part | 'empty' | null = null
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
    size: dim,

    render: (renderer) => {
      face()
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
      pressed = partAt(local) ?? 'empty'
      dragged = false
      lastX = event.clientX
      lastY = event.clientY
      return true
    },

    pointerMove: (event) => {
      if (pressed === null) return
      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      if (!dragged && Math.hypot(dx, dy) < DRAG_SLOP) return
      // Past the slop the press is a drag, wherever it started — Blender orbits from the balls too.
      dragged = true
      lastX = event.clientX
      lastY = event.clientY
      orbit(dx, dy)
    },

    pointerUp: () => {
      const was = pressed
      pressed = null
      if (dragged || was === null || was === 'empty') return null
      if (was === 'centre') return 'centre'
      const axis = AXES.find((a) => a.name === was)
      if (axis !== undefined) startSnap(axis.dir)
      return 'axis'
    },

    hover: (event) => {
      const local = event === null ? null : localPointer(event)
      light(local === null ? null : (partAt(local) ?? null))
      return hovered !== null
    },

    dispose: () => {
      cone.dispose()
      coneReach.dispose()
      cubeGeometry.dispose()
      cubeReachGeometry.dispose()
      reachMaterial.dispose()
      for (const faces of materials.values()) for (const f of faces) f.material.dispose()
      for (const s of letters) {
        s.material.map?.dispose()
        s.material.dispose()
      }
    },
  }
}
