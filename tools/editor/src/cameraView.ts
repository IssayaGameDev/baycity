import type { EnvironmentConfig } from '@mp/content'
import { QUANT_BOUND } from '@mp/net'
import { createThreeStage, OrbitControls, THREE } from '@mp/render-three'

import type { Doc } from './editorDoc'
import type { CameraPose } from './follow'
import { createViewGizmo } from './viewGizmo'
import type { Notify } from './notices'

/**
 * How the level is looked at: the projection, the navigation gizmo, the background the projection needs, and
 * the network-bounds box (ADR 0093, ADR 0094, ADR 0121).
 *
 * One module because they are one decision followed by its consequences. Dropping perspective changes which
 * camera the controls, the post-FX and the transform gizmo point at, and it changes the background — a
 * cubemap sky is a projection of the view ray, so an orthographic camera shows it flat and wrong, and a flat
 * colour stands in. Every path that installs a sky has to re-apply that, and a path that forgets is a black
 * viewport nobody sees until they press the isometric button.
 *
 * It owns the orthographic camera, `isometric`, the view gizmo with its drag flag, hover and the projection's
 * button under it, the stand-in background and what it replaced, and the bounds box with its toggle.
 */

/** A far plane changes in steps this long, so a moving camera re-cuts its projection seldom. */
const FAR_STEP = 100
/** How often the level is measured for the far plane, in ms: a bounding box over every object, not every frame. */
const MEASURE_MS = 500

/**
 * The far plane that takes in all of `reach` from `eye` (ADR 0201): to the level's far side and a little more,
 * never nearer than `floor`, in whole `FAR_STEP`s.
 */
export const farToSee = (eye: THREE.Vector3, reach: THREE.Sphere, floor: number): number => {
  if (reach.isEmpty()) return floor
  const need = (eye.distanceTo(reach.center) + reach.radius) * 1.05
  return Math.max(floor, Math.ceil(need / FAR_STEP) * FAR_STEP)
}

/** What looking at the level needs from the editor around it. */
export interface CameraViewHost {
  stage: ReturnType<typeof createThreeStage>
  canvas: HTMLCanvasElement
  /** The layer over the viewport (ADR 0149), where the projection's button goes, under the gizmo. */
  overlays: HTMLElement
  controls: OrbitControls
  /** The authored item groups, measured to say how far the level reaches. */
  instanceRoot: THREE.Group
  groups: () => readonly THREE.Group[]
  doc: () => Doc | null
  /** A prefab has no bounds of its own, so the box is not drawn over one. */
  inPrefab: () => boolean
  playing: () => boolean
  /**
   * Point everything that holds a camera at this one.
   *
   * Re-pointed rather than rebuilt: the post-FX passes took theirs at construction, and rebuilding the
   * composer would throw away the AO and bloom the level asked for.
   */
  useCamera: (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) => void
  /** Apply a level's environment and post-FX. The background then follows the projection. */
  applyEnvironment: (from: Partial<EnvironmentConfig> | undefined) => void
  skyParams: () => { topColor: number | string; bottomColor: number | string }
  renderPostFX: () => void
  notify: Notify
  uiChanged: () => void
  /** You moved the camera yourself with the gizmo or the projection button: a follow ends (ADR 0155). */
  userMoved: () => void
}

export const createCameraView = (host: CameraViewHost) => {
  const { stage, canvas } = host
  /**
   * The network bounds, drawn (ADR 0093): the cube a peer's position is quantized over, centred on the origin.
   *
   * Off unless asked for. A level is almost always well inside it, so left on it would be a red box around
   * everything forever; the reason to draw it at all is the half-hour when someone is deciding how big it
   * should be, or checking that a level which grew still fits.
   */
  const boundsBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0xef4444))
  boundsBox.visible = false
  let showBoundsBox = false

  /**
   * The isometric camera (ADR 0094). `stage.camera` stays the perspective one and stays the game's — play mode
   * hands it to `createOrbitCamera`, which tunes its `fov` — so this is a second camera the editor swaps in,
   * not a change to the stage.
   *
   * "Isometric" is Unity's word for it and the one on the label; it is an orthographic projection, not the
   * 30-degree angle the word means in drawing.
   */
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000)
  let isometric = false

  /** The camera actually being looked through. Everything that casts a ray or draws must ask for it. */
  const activeCamera = (): THREE.PerspectiveCamera | THREE.OrthographicCamera => (isometric ? orthoCamera : stage.camera)

  /** Half the world height the orthographic camera shows, chosen to match what perspective shows at the target. */
  const orthoHalfHeight = (): number => {
    const distance = Math.max(0.001, stage.camera.position.distanceTo(host.controls.target))
    return distance * Math.tan((stage.camera.fov * Math.PI) / 360)
  }

  /** Re-cut the orthographic frustum for the canvas's aspect, keeping the height it is already showing. */
  const syncOrthoFrustum = (halfHeight: number): void => {
    const aspect = Math.max(0.001, canvas.clientWidth / Math.max(1, canvas.clientHeight))
    orthoCamera.top = halfHeight
    orthoCamera.bottom = -halfHeight
    orthoCamera.left = -halfHeight * aspect
    orthoCamera.right = halfHeight * aspect
    orthoCamera.updateProjectionMatrix()
  }

  /**
   * Swap projection, keeping the view.
   *
   * The outgoing camera's placement carries over, and the frustum is cut so the two show the same thing at the
   * orbit target — so the toggle reads as the perspective draining out of the picture rather than as a jump.
   * Going back, the distance is recovered from the frustum, since orthographic has no distance of its own.
   *
   * Everything holding a camera is re-pointed rather than rebuilt: the post-FX passes took theirs at
   * construction, and rebuilding the composer would throw away the AO and bloom the level asked for.
   */
  const setProjection = (ortho: boolean, quiet = false): void => {
    if (ortho === isometric) return
    if (ortho) {
      const half = orthoHalfHeight()
      orthoCamera.position.copy(stage.camera.position)
      orthoCamera.quaternion.copy(stage.camera.quaternion)
      orthoCamera.zoom = 1
      syncOrthoFrustum(half)
    } else {
      // Orthographic distance is meaningless, so put the perspective camera where it shows the same height.
      const half = (orthoCamera.top - orthoCamera.bottom) / 2 / orthoCamera.zoom
      const distance = half / Math.tan((stage.camera.fov * Math.PI) / 360)
      const back = orthoCamera.position.clone().sub(host.controls.target)
      if (back.lengthSq() < 1e-6) back.set(0, 1, 1)
      stage.camera.quaternion.copy(orthoCamera.quaternion)
      stage.camera.position.copy(host.controls.target).add(back.normalize().multiplyScalar(distance))
    }
    isometric = ortho
    applyProjectionBackground()
    const camera = activeCamera()
    host.useCamera(camera)
    host.controls.update()
    labelProjection()
    if (!quiet) host.notify.ok(ortho ? 'isometric' : 'perspective')
    host.uiChanged()
  }

  /** The view as the room sends it (ADR 0155), rounded by the sender. */
  const pose = (): CameraPose => {
    const p = activeCamera().position
    const t = host.controls.target
    return {
      position: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      ortho: isometric ? (orthoCamera.top - orthoCamera.bottom) / 2 / orthoCamera.zoom : null,
    }
  }

  /**
   * Take a followed view: its projection (quietly — it is theirs, not a choice made here), its target and its
   * position. Not aimed: the frame's `controls.update()` does that, and calling it here as well would run the
   * damping twice a frame.
   */
  const setPose = (to: CameraPose): void => {
    setProjection(to.ortho !== null, true)
    host.controls.target.set(to.target.x, to.target.y, to.target.z)
    activeCamera().position.set(to.position.x, to.position.y, to.position.z)
    if (to.ortho !== null) {
      orthoCamera.zoom = 1
      syncOrthoFrustum(to.ortho)
    }
  }

  /**
   * The navigation gizmo, top right (ADR 0094, ADR 0149): Unity's cones and cube, click the cube to toggle
   * isometric, and no auto-switch — looking down an axis and dropping perspective are two decisions.
   */
  const viewGizmo = createViewGizmo({
    camera: activeCamera,
    target: () => host.controls.target,
    dom: canvas,
  })

  /**
   * The projection's name under the gizmo, and a button: Unity's label, which toggles like the cube does. HTML
   * rather than drawn in the gizmo, so it can be pressed whichever way the gizmo is turned — looking straight
   * down an axis puts a cone over the cube.
   */
  const projection = document.createElement('button')
  projection.type = 'button'
  projection.className = 'ov-proj'
  // Centred under the gizmo's square; the toggles to its left keep clear of the square by the same number.
  host.overlays.style.setProperty('--gizmo', `${viewGizmo.size}px`)
  projection.addEventListener('click', () => {
    host.userMoved()
    setProjection(!isometric)
  })
  host.overlays.append(projection)
  const labelProjection = (): void => {
    projection.textContent = isometric ? 'Iso' : 'Persp'
    projection.title = isometric ? 'Isometric: click for Perspective' : 'Perspective: click for Isometric'
  }
  labelProjection()

  /**
   * Drawn after post-processing, because it clears depth and paints over the finished image — composite
   * anything afterwards and it would be covered. Hidden during play, where the viewport is the game's.
   */
  stage.setRenderStep(() => {
    host.renderPostFX()
    if (!host.playing()) viewGizmo.render(stage.renderer)
  })

  /**
   * Draw the frame now and hand the canvas to `read` before the navigation gizmo goes on — the view as a picture
   * (ADR 0194) — then finish the frame as the loop does, so the screen shows what it always does. Synchronous: the
   * drawing buffer is readable only in the task that drew it, and a hidden tab draws no frames to wait for.
   */
  const captureFrame = <T,>(read: (canvas: HTMLCanvasElement) => T): T => {
    host.renderPostFX()
    try {
      return read(stage.renderer.domElement)
    } finally {
      if (!host.playing()) viewGizmo.render(stage.renderer)
    }
  }

  /**
   * The gizmo gets the pointer before anything else does.
   *
   * On the document in the **capture** phase rather than on the canvas: `OrbitControls` and the rest listen on
   * the canvas itself, and listeners on one element fire in the order they were added, so there is no way to
   * get in front of them from there. Capturing on an ancestor is, and `stopPropagation` then means the event
   * never reaches the canvas at all — no orbit, no selection click, no context menu.
   */
  let viewGizmoHolding = false
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target !== canvas || host.playing() || e.button !== 0) return
      if (!viewGizmo.pointerDown(e)) return
      host.userMoved()
      viewGizmoHolding = true
      e.stopPropagation()
      e.preventDefault()
    },
    true,
  )
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!viewGizmoHolding) return
      viewGizmo.pointerMove(e)
      e.stopPropagation()
    },
    true,
  )
  document.addEventListener(
    'pointerup',
    (e) => {
      if (!viewGizmoHolding) return
      viewGizmoHolding = false
      if (viewGizmo.pointerUp(e) === 'centre') setProjection(!isometric)
      e.stopPropagation()
    },
    true,
  )

  /**
   * What the pointer is over, lit, with a pointer cursor while it is over a part — the gizmo's parts are the
   * only clickable things on the canvas that are not the level. Not while a press is held: a drag orbits and
   * the part it started on is not what it is doing.
   */
  let pointing = false
  document.addEventListener('pointermove', (e) => {
    if (viewGizmoHolding) return
    // A held button is somebody orbiting or dragging the level, passing over the corner on the way.
    const over = viewGizmo.hover(e.target === canvas && e.buttons === 0 && !host.playing() ? e : null)
    if (over === pointing) return
    pointing = over
    canvas.style.cursor = over ? 'pointer' : ''
  })

  /**
   * A flat stand-in for the sky while the camera is orthographic.
   *
   * Three draws a cubemap background as a **1 x 1 x 1 box parked at the camera**, inside-out, depth test off
   * (`WebGLBackground`). A perspective divide is what makes that fill the screen: a corner half a metre away at
   * 45 degrees lands at the edge. Orthographic has no divide, so half a metre stays half a metre and the box
   * projects to a few percent of a viewport metres across — a small patch of sky in the middle of the clear
   * colour, which is what "the skybox goes black in isometric" actually is.
   *
   * So isometric gets a flat colour instead, mixed from the level's own sky so it is not jarring. Not tone
   * mapped, because a `Color` background is a clear colour rather than a drawn surface, so the sky's `gain` is
   * deliberately left out of it.
   *
   * The alternative is drawing the sky ourselves — a mesh, or a full-screen quad reconstructing the view ray —
   * which is correct in both projections and costs a draw every frame in the game as well. Deferred to the
   * render pass (`budgets.md`) rather than taken now.
   */
  const isoBackground = new THREE.Color()
  /** Whatever the sky put there, so leaving isometric restores exactly that. `undefined` = nothing captured. */
  let backgroundBeforeIso: THREE.Scene['background'] | undefined

  /**
   * Install a level's environment, and then make the background match the projection.
   *
   * One function rather than the four pairs of calls this replaces, for the reason `meshes.buildAll` keeps its own
   * invariants: every path that installs a sky has to re-apply this, and a path that forgets is a black
   * viewport that only shows up in isometric.
   */
  const installEnvironment = (from: Partial<EnvironmentConfig> | undefined): void => {
    host.applyEnvironment(from)
    applyProjectionBackground()
  }

  /** Swap the cubemap background for a flat colour while isometric, and put it back afterwards. */
  const applyProjectionBackground = (): void => {
    if (isometric) {
      // Anything but our own colour is the sky the environment just installed: remember it before replacing it.
      if (stage.scene.background !== isoBackground) backgroundBeforeIso = stage.scene.background
      const sky = host.skyParams()
      isoBackground.set(sky.bottomColor).lerp(new THREE.Color(sky.topColor), 0.5)
      stage.scene.background = isoBackground
      return
    }
    if (backgroundBeforeIso !== undefined) {
      stage.scene.background = backgroundBeforeIso
      backgroundBeforeIso = undefined
    }
  }

  /**
   * How far the view reaches (ADR 0201, Kodjo's call: the editor's, not the game's). The stage's camera stops at
   * its own far plane, 1000 m, the game's — which cut a big level off a few hundred metres past what you looked at.
   * So outside play the far plane follows the level: far enough to see all of it from where the camera is, never
   * nearer than the camera's own. Play gets the game's back. The near plane stays: it is what decides depth
   * precision, so a far plane further out costs next to nothing.
   */
  const gameFar = stage.camera.far
  const isoFar = orthoCamera.far
  const reach = new THREE.Sphere()
  let measuredAt = -Infinity
  const setFar = (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, far: number): void => {
    if (camera.far === far) return
    camera.far = far
    camera.updateProjectionMatrix()
  }
  const fitFar = (): void => {
    if (host.playing()) return setFar(stage.camera, gameFar)
    const now = performance.now()
    if (now - measuredAt >= MEASURE_MS) {
      measuredAt = now
      new THREE.Box3().setFromObject(host.instanceRoot).getBoundingSphere(reach)
    }
    const camera = activeCamera()
    setFar(camera, farToSee(camera.position, reach, isometric ? isoFar : gameFar))
  }

  /** The bound in force for the open document: the level's own, or the platform default. */
  const effectiveBounds = (): number => host.doc()?.netBounds() ?? QUANT_BOUND

  /**
   * Re-size the box and decide whether it is drawn.
   *
   * Hidden inside a prefab as well as when switched off: a prefab has no bounds of its own (it is placed into
   * a level, and the level's box is the one that matters), so drawing the default around it would be a lie.
   */
  const refreshBoundsBox = (): void => {
    const b = effectiveBounds()
    boundsBox.box.set(new THREE.Vector3(-b, -b, -b), new THREE.Vector3(b, b, b))
    boundsBox.visible = showBoundsBox && !host.inPrefab() && host.doc() !== null
  }

  /**
   * How far the level actually reaches, and how much of it is outside the bound.
   *
   * Measured off the drawn objects rather than the authored positions, so a wide platform counts by its edge
   * and not by its origin — the edge is where a player can stand, and standing there is what the bound has to
   * carry. Top-level objects only, or a nested child would be counted twice with its parent.
   */
  const boundsReach = (): { outside: number; reach: number } | null => {
    if (host.doc() === null) return null
    const b = effectiveBounds()
    const far = (box: THREE.Box3): number =>
      box.isEmpty() ? 0 : Math.max(Math.abs(box.min.x), Math.abs(box.min.y), Math.abs(box.min.z), box.max.x, box.max.y, box.max.z)
    let outside = 0
    for (const g of host.groups()) {
      if (g === undefined || g.parent !== host.instanceRoot) continue
      if (far(new THREE.Box3().setFromObject(g)) > b) outside += 1
    }
    return { outside, reach: far(new THREE.Box3().setFromObject(host.instanceRoot)) }
  }
  return {
    /** The camera actually being looked through. Everything that casts a ray or draws must ask for this. */
    activeCamera,
    /** The orthographic camera itself, for a caller framing the view in it. */
    orthoCamera,
    isometric: () => isometric,
    /** Swap projection, keeping the view. */
    setProjection,
    /** The view as the room sends it, for someone following this tab. */
    pose,
    /** Take a followed view. */
    setPose,
    /** Re-cut the orthographic frustum for the canvas's aspect, keeping the height it is already showing. */
    syncOrthoFrustum,
    /** Half the world height the orthographic camera currently shows. */
    orthoHalfHeight: () => (orthoCamera.top - orthoCamera.bottom) / 2,
    /** Install a level's environment, then make the background match the projection. */
    installEnvironment,
    /** Once per frame, so the navigation gizmo keeps up and the far plane takes in the level. */
    update: (dt: number) => {
      viewGizmo.update(dt)
      fitFar()
    },
    captureFrame,
    boundsBox,
    showBounds: () => showBoundsBox,
    setShowBounds: (on: boolean) => {
      showBoundsBox = on
      refreshBoundsBox()
    },
    /** Re-size the box and decide whether it is drawn. */
    refreshBoundsBox,
    /** How far the level reaches, and how many top-level objects are outside the bound. */
    boundsReach,
    /** The bound in force for the open document: the level's own, or the platform default. */
    effectiveBounds,
  }
}
