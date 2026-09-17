import type { Vec3 } from '@mp/core'
import { vec3 } from '@mp/core'
import { unknownComponentTypes } from './editorDoc'
import { THREE } from '@mp/render-three'
import { OrbitControls } from '@mp/render-three'

import type { AssetLibrary } from './assetsApi'
import type { Doc } from './editorDoc'
import { distanceAlongAxis, faceFromNormal, pulled, snappedPull, type Face } from './facePull'
import { modeFor } from './selection'
import { snapToGrid } from './snap'
import type { GizmoMode } from './toolbar'

/**
 * The pointer in the viewport: what is under it, what it places, and pulling a box by its face
 * (ADR 0025, ADR 0119, ADR 0121).
 *
 * One module because a click has to be told apart from a drag before anything can act on it, and three
 * gestures share the same button. A left press may begin a face pull, continue an orbit, or end as a
 * selection click; the press records where it started, `dragged` marks a gizmo drag, and the release acts
 * only if the pointer barely moved. Splitting that leaves a stray orbit changing the selection.
 *
 * It owns the raycaster, the ground plane, where the press landed, the face highlight and the pull in
 * progress.
 */

/** Rounded the way the document stores numbers. */
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4

/** What the pointer needs from the editor around it. */
export interface PickHost {
  canvas: HTMLCanvasElement
  controls: OrbitControls
  scene: THREE.Scene
  /** The authored item groups — what a click raycasts against. */
  instanceRoot: THREE.Group
  doc: () => Doc | null
  assets: () => AssetLibrary | null
  selected: () => number | null
  select: (index: number) => void
  selectWith: (index: number, mode: 'replace' | 'toggle' | 'range', order: readonly number[]) => void
  deselect: () => void
  groupAt: (i: number) => THREE.Group | undefined
  holderOf: (g: THREE.Group) => THREE.Group
  activeCamera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera
  playing: () => boolean
  /** Which transform tool is active; `'face'` is this module's (ADR 0119). */
  tool: () => GizmoMode
  snapping: () => boolean
  /** The translate tool's increment, which a placement lands on. */
  snapStep: () => number
  /** The face tool's own increment (ADR 0114). */
  faceStep: () => number
  /** A gizmo drag happened, so the release that follows is not a click. */
  dragged: () => boolean
  setDragged: (value: boolean) => void
  /** The asset armed for the next click, or `null`. */
  placing: () => { kind: 'prefabAsset' | 'model'; assetId: string } | null
  disarm: () => void
  edits: () => {
    recordEdit: (label: string) => void
    beginDrag: () => void
    endDrag: (label: string) => void
    abortDrag: () => void
  }
  writeBackItem: (index: number) => void
  rebuildMeshes: () => void
  rebuildSubtree: (i: number) => void
  rebuildLoaded: () => void
  loadNewReferencesThen: (redraw: () => void) => void
  applyPreviewPoses: () => void
  inspectorSync: () => void
  setStatus: (message: string) => void
}

export const createPickTool = (host: PickHost) => {
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  let downX = 0
  let downY = 0
  host.canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX
    downY = e.clientY
    host.setDragged(false)
    // Face mode claims a left press on a face of the selected box (ADR 0119). Orbit is suppressed for the drag
    // and `host.dragged()` marks it, so the pointerup that follows is not read as a click that changes selection.
    if (e.button === 0 && !host.playing() && host.tool() === 'face' && beginFacePull(e.clientX, e.clientY)) {
      host.setDragged(true)
      host.controls.enabled = false
      host.canvas.setPointerCapture(e.pointerId)
    }
  })

  host.canvas.addEventListener('pointermove', (e) => {
    if (host.playing() || host.tool() !== 'face') return
    if (facePull !== null) {
      moveFacePull(e.clientX, e.clientY)
      return
    }
    const found = faceUnder(e.clientX, e.clientY)
    if (found === null) faceHover.visible = false
    else showFaceHover(found.index, found.face)
  })

  host.canvas.addEventListener('pointerup', (e) => {
    if (facePull === null) return
    endFacePull()
    host.controls.enabled = true
    if (host.canvas.hasPointerCapture(e.pointerId)) host.canvas.releasePointerCapture(e.pointerId)
  })

  /* ============================ pulling a face (ADR 0119) ============================ */

  /**
   * The translucent square drawn over the face under the pointer.
   *
   * The face **is** the handle, so there is nothing to aim at but the box itself — SketchUp's model rather than
   * ProBuilder's select-then-drag. `depthTest: false` so it reads on a face pointing away from the light, and
   * `renderOrder` above the meshes so it is not z-fought by the surface it sits on.
   */
  const faceHover = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x4a8cf7, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide }),
  )
  faceHover.renderOrder = 10
  faceHover.visible = false
  // Beside the gizmo: scene furniture, not part of the level.
  host.scene.add(faceHover)

  /** What a pull needs to remember from the moment the pointer went down. */
  let facePull: {
    index: number
    face: Face
    /** The line the face travels along, in world space; `dir` is the outward normal, unit length. */
    origin: THREE.Vector3
    dir: THREE.Vector3
    /** `distanceAlongAxis` at the press, so a move is measured as a change rather than an absolute. */
    t0: number
    /** Where the face's plane sits along its own normal, for snapping where it *lands* (ADR 0113/0117). */
    faceAt: number
    startScale: THREE.Vector3
    startPos: THREE.Vector3
    /** Local units per world metre along this axis, so a world drag becomes a local scale. */
    perMetre: number
    /** The last good distance, held when the camera looks straight down the axis. */
    last: number
  } | null = null

  /**
   * The face of the **selected** box under a client position, or `null`.
   *
   * Only the selected object, so a stray drag cannot reshape something else, and so the highlight only ever
   * appears on one thing. Only a built-in box or rounded box: scale is the whole size for those (ADR 0090), so
   * a pull is a transform edit and nothing else. A sphere has no faces.
   */
  const faceUnder = (clientX: number, clientY: number): { index: number; face: Face; hit: THREE.Intersection } | null => {
    const at = host.selected()
    const open = host.doc()
    if (at === null || open === null) return null
    const builtin = open.builtinOf(at)
    if (builtin !== 'builtin:box' && builtin !== 'builtin:rounded-box') return null
    const g = host.groupAt(at)
    if (g === undefined) return null
    castFrom(clientX, clientY)
    const hit = raycaster.intersectObject(host.holderOf(g), true)[0]
    if (hit === undefined || hit.face === null || hit.face === undefined) return null
    // The normal arrives in the hit mesh's own space; the face belongs to the node's.
    const world = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    g.updateWorldMatrix(true, false)
    const local = world.clone().transformDirection(new THREE.Matrix4().copy(g.matrixWorld).invert())
    const face = faceFromNormal(local)
    return face === null ? null : { index: at, face, hit }
  }

  /** Draw the highlight over a face, sized to it. */
  const showFaceHover = (index: number, face: Face): void => {
    const g = host.groupAt(index)
    if (g === undefined) return
    g.updateWorldMatrix(true, false)
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    g.matrixWorld.decompose(pos, quat, scale)
    const half = { x: Math.abs(scale.x) / 2, y: Math.abs(scale.y) / 2, z: Math.abs(scale.z) / 2 }
    // A plane's own normal is +z, so point it along the face and slide it out to the surface.
    const localNormal = new THREE.Vector3(face.axis === 'x' ? face.sign : 0, face.axis === 'y' ? face.sign : 0, face.axis === 'z' ? face.sign : 0)
    const centre = localNormal.clone().multiply(new THREE.Vector3(half.x, half.y, half.z)).applyQuaternion(quat).add(pos)
    const spread = face.axis === 'x' ? [half.z, half.y] : face.axis === 'y' ? [half.x, half.z] : [half.x, half.y]
    faceHover.position.copy(centre)
    faceHover.quaternion.copy(quat).multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal))
    faceHover.scale.set((spread[0] ?? 0.5) * 2, (spread[1] ?? 0.5) * 2, 1)
    faceHover.visible = true
  }

  /** Begin a pull. `false` when there is no face under the pointer, so the caller falls through to selection. */
  const beginFacePull = (clientX: number, clientY: number): boolean => {
    const found = faceUnder(clientX, clientY)
    if (found === null || host.doc() === null) return false
    const g = host.groupAt(found.index)
    if (g === undefined) return false
    g.updateWorldMatrix(true, false)
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const worldScale = new THREE.Vector3()
    g.matrixWorld.decompose(pos, quat, worldScale)

    const { face } = found
    const localNormal = new THREE.Vector3(face.axis === 'x' ? face.sign : 0, face.axis === 'y' ? face.sign : 0, face.axis === 'z' ? face.sign : 0)
    const dir = localNormal.clone().applyQuaternion(quat).normalize()
    const halfWorld = Math.abs(worldScale[face.axis]) / 2
    const faceCentre = dir.clone().multiplyScalar(halfWorld).add(pos)
    const t0 = distanceAlongAxis(raycaster.ray.origin, raycaster.ray.direction, pos, dir)
    if (t0 === null) return false
    // Local units per world metre: the node's own scale is local, and the world size is that times the parent's.
    const localSize = Math.abs(g.scale[face.axis])
    const perMetre = localSize > 1e-9 && halfWorld > 1e-9 ? localSize / (halfWorld * 2) : 1

    facePull = {
      index: found.index,
      face,
      origin: pos.clone(),
      dir,
      t0,
      // Where the face's plane sits along its own normal. For an axis-aligned box this is just its world x, y
      // or z; rotated, it is the plane's offset, which is what a grid of parallel planes snaps to.
      faceAt: faceCentre.dot(dir),
      startScale: g.scale.clone(),
      startPos: g.position.clone(),
      perMetre,
      last: 0,
    }
    host.edits().beginDrag()
    return true
  }

  /** Apply the pointer's position to the pull in progress. */
  const moveFacePull = (clientX: number, clientY: number): void => {
    const pull = facePull
    if (pull === null || host.doc() === null) return
    const g = host.groupAt(pull.index)
    if (g === undefined) return
    castFrom(clientX, clientY)
    const t = distanceAlongAxis(raycaster.ray.origin, raycaster.ray.direction, pull.origin, pull.dir)
    // Looking straight down the axis there is no answer; hold the last one rather than jumping.
    const raw = t === null ? pull.last : t - pull.t0
    pull.last = raw
    const metres = snappedPull(pull.faceAt, raw, host.snapping() ? host.faceStep() : 0)
    const step = host.snapping() ? host.faceStep() : 0.05
    const next = pulled(
      { x: pull.startScale.x, y: pull.startScale.y, z: pull.startScale.z },
      { x: pull.startPos.x, y: pull.startPos.y, z: pull.startPos.z },
      pull.face,
      metres * pull.perMetre,
      Math.max(step, 0.05) * pull.perMetre,
    )
    g.scale.set(next.scale.x, next.scale.y, next.scale.z)
    g.position.set(next.position.x, next.position.y, next.position.z)
    host.writeBackItem(pull.index)
    host.rebuildSubtree(pull.index)
    showFaceHover(pull.index, pull.face)
    host.inspectorSync()
    const size = next.scale
    host.setStatus(`${r4(size.x)} \u00d7 ${r4(size.y)} \u00d7 ${r4(size.z)}`)
  }

  /** Finish a pull: one history entry and one message to the room, like a gizmo drag. */
  const endFacePull = (): void => {
    const pull = facePull
    facePull = null
    if (pull === null) {
      host.edits().abortDrag()
      return
    }
    host.edits().endDrag('face')
    host.rebuildLoaded()
    host.applyPreviewPoses()
  }

  /** Point the raycaster at a client position. Shared by picking, placement and the right-click menu. */
  const castFrom = (clientX: number, clientY: number): void => {
    const rect = host.canvas.getBoundingClientRect()
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, host.activeCamera())
  }

  /** The document index under a client position, or `null`. */
  const indexUnder = (clientX: number, clientY: number): number | null => {
    castFrom(clientX, clientY)
    const hit = raycaster.intersectObjects(host.instanceRoot.children, true)[0]?.object
    let o: THREE.Object3D | null = hit ?? null
    while (o !== null && o.userData.index === undefined) o = o.parent
    return o !== null && typeof o.userData.index === 'number' ? o.userData.index : null
  }

  /**
   * The world point under a client position: the surface hit, or the ground plane behind it, snapped like a
   * placement. `null` when the ray leaves the world entirely — pointing at the sky above the horizon.
   */
  const surfaceUnder = (clientX: number, clientY: number): Vec3 | null => {
    castFrom(clientX, clientY)
    const surf = raycaster.intersectObjects(host.instanceRoot.children, true)[0]
    const point = new THREE.Vector3()
    if (surf !== undefined) point.copy(surf.point)
    else if (raycaster.ray.intersectPlane(groundPlane, point) === null) return null
    const snap = host.snapping() ? host.snapStep() : 0
    const sx = snap !== 0 ? snapToGrid(point.x, snap) : r4(point.x)
    const sz = snap !== 0 ? snapToGrid(point.z, snap) : r4(point.z)
    return vec3(sx, r4(point.y), sz)
  }

  host.canvas.addEventListener('pointerup', (e) => {
    // Left button only. Without this a right-click placed the armed prefab and moved the selection on its way
    // to opening a menu, which is the sort of thing that gets blamed on the menu.
    if (e.button !== 0) return
    if (host.playing()) return // editing suspended during play (pointer = camera only)
    if (host.dragged()) return // was dragging the gizmo, not a click
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return // was an orbit drag
    castFrom(e.clientX, e.clientY)

    // Placement mode: drop the chosen palette entry on the surface (or ground plane).
    const armed = host.placing()
    const open = host.doc()
    if (armed !== null && open !== null) {
      const surf = raycaster.intersectObjects(host.instanceRoot.children, true)[0]
      const point = new THREE.Vector3()
      if (surf !== undefined) point.copy(surf.point)
      else if (raycaster.ray.intersectPlane(groundPlane, point) === null) {
        host.disarm()
        return
      }
      const snap = host.snapping() ? host.snapStep() : 0
      const sx = snap !== 0 ? snapToGrid(point.x, snap) : r4(point.x)
      const sz = snap !== 0 ? snapToGrid(point.z, snap) : r4(point.z)
      const at = vec3(sx, r4(point.y), sz)
      const prefabAsset = armed.kind === 'prefabAsset' ? host.assets()?.prefabOf(armed.assetId) : undefined
      const idx =
        armed.kind === 'model'
          ? open.placeModel(armed.assetId, at)
          : prefabAsset !== undefined
            ? open.placePrefab(armed.assetId, prefabAsset, at)
            : -1
      if (idx < 0) {
        const unknown = prefabAsset === undefined ? [] : unknownComponentTypes(prefabAsset, open.registry)
        host.setStatus(unknown.length > 0 ? `uses ${unknown.join(', ')}, which this game does not have` : 'that prefab did not load')
        host.disarm()
        return
      }
      host.disarm()
      host.edits().recordEdit('place')
      host.rebuildMeshes()
      host.rebuildLoaded()
      host.select(idx)
      // A placed prefab file can reference a material this document had never named before.
      host.loadNewReferencesThen(() => {
        host.rebuildMeshes() // resets the item groups, so the gizmo has to be re-attached
        host.select(idx)
      })
      return
    }

    const hit = raycaster.intersectObjects(host.instanceRoot.children, true)[0]?.object
    if (hit === undefined) {
      // Ctrl-clicking empty space is a miss, not "clear everything": losing a five-item selection to a stray
      // click is the kind of thing that makes people stop using multi-select.
      if (!e.ctrlKey && !e.metaKey) host.deselect()
      return
    }
    let o: THREE.Object3D | null = hit
    while (o !== null && o.userData.index === undefined) o = o.parent
    if (o !== null && typeof o.userData.index === 'number') {
      // Ctrl toggles in the viewport, as it does in the Hierarchy. Shift is *not* offered here: a range needs an
      // order, and the viewport has none — what looks adjacent on screen is an accident of the camera.
      const mode = modeFor(e)
      host.selectWith(o.userData.index, mode === 'range' ? 'toggle' : mode, [])
    }
  })
  return {
    /** Point the raycaster at a client position. Shared by picking, placement and the right-click menu. */
    castFrom,
    /** The document index of the item under a client position, or `null`. */
    indexUnder,
    /** The world point on the surface under a client position, or on the ground plane. */
    surfaceUnder,
    /** Clear the face highlight — leaving the face tool, or entering play. */
    clearFaceHover: () => void (faceHover.visible = false),
  }
}
