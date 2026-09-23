import type { Vec3 } from '@mp/core'
import { vec3 } from '@mp/core'
import { unknownComponentTypes } from './editorDoc'
import { THREE } from '@mp/render-three'
import { OrbitControls } from '@mp/render-three'

import type { AssetLibrary } from './assetsApi'
import type { Doc } from './editorDoc'
import { distanceAlongAxis, faceFromNormal, faceTowards, pulled, snappedPull, type Face } from './facePull'
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

/**
 * **Which face of each *other* selected box a pull moves** (ADR 0119).
 *
 * `true` — the face pointing most nearly the way the grabbed one points, so everything grows the way you are
 * dragging. `false` — the same lettered axis and sign on every box, so a ring of walls each rotated to face
 * outward would expand outward instead of all sliding one way.
 *
 * The two are identical whenever the selected boxes share a rotation, which is the ordinary case. Kodjo chose
 * world direction and may want the other after playing with it; flipping this constant is the whole change.
 */
const MATCH_FACE_BY_WORLD_DIRECTION = true

/** How far a press may travel and still be a click rather than an orbit. */
const CLICK_SLOP = 4

const sameFace = (a: Face, b: Face): boolean => a.axis === b.axis && a.sign === b.sign

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
  /** The whole selection, primary last (ADR 0031). A face pull applies to all of it. */
  selection: () => readonly number[]
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
  /**
   * **The face that is chosen, and stays chosen** (ADR 0129).
   *
   * Kodjo asked for the face to survive the pointer leaving it: click to choose, drag to pull, click away to
   * let go. That reverses ADR 0119's "the face is the handle" — a pull is two gestures now rather than one —
   * and he took that cost knowingly, because a highlight that vanishes the moment you look elsewhere cannot
   * be checked before you commit to a drag.
   *
   * The whole matched set, not one face: the drag moves one face on every selected box (ADR 0128), so what
   * is chosen has to be the same set, or the plates would promise less than the drag delivers. `faces[0]` is
   * the one that was clicked.
   */
  let chosen: { dir: THREE.Vector3; faces: { index: number; face: Face }[] } | null = null
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  let downX = 0
  let downY = 0
  host.canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX
    downY = e.clientY
    host.setDragged(false)
    if (e.button !== 0 || host.playing() || host.tool() !== 'face') return
    /**
     * **A press only pulls the face that is already chosen** (ADR 0129).
     *
     * Face selection is a click of its own now, so a press somewhere else is not a pull: it is the start of
     * either choosing a different face or losing the one held. Deciding here rather than on release is what
     * lets the drag begin on the same press, so a chosen face still pulls in one motion.
     *
     * Orbit is suppressed for the drag and `host.dragged()` marks it, so the pointerup that follows is not
     * read as a click that changes selection.
     */
    const found = faceUnder(e.clientX, e.clientY)
    if (found !== null && chosen !== null && chosen.faces[0]?.index === found.index && sameFace(chosen.faces[0].face, found.face)) {
      if (beginFacePull(e.clientX, e.clientY, chosen)) {
        host.setDragged(true)
        host.controls.enabled = false
        host.canvas.setPointerCapture(e.pointerId)
      }
    }
  })

  host.canvas.addEventListener('pointermove', (e) => {
    if (host.playing() || host.tool() !== 'face') return
    if (facePull !== null) {
      moveFacePull(e.clientX, e.clientY)
      return
    }
    // A chosen face owns the plates; the hover preview only runs when nothing is chosen, so there is never
    // more than one set of faces lit and no question about which of them a drag would move.
    if (chosen !== null) return
    const found = faceUnder(e.clientX, e.clientY)
    const matched = found === null ? null : facesForSelection(found.index, found.face)
    if (matched === null) hideFacePlates()
    else showFaceHovers(matched.faces)
  })

  host.canvas.addEventListener('pointerup', (e) => {
    if (facePull !== null) {
      endFacePull()
      host.controls.enabled = true
      if (host.canvas.hasPointerCapture(e.pointerId)) host.canvas.releasePointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0 || host.playing() || host.tool() !== 'face') return
    // A click, not the end of an orbit: a press that travelled is the camera being moved, and must not
    // change what is chosen. The same slop the selection click uses.
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP) return
    const found = faceUnder(e.clientX, e.clientY)
    // A face under the pointer is chosen; anywhere else clears, which is the only way back to none.
    chooseFace(found === null ? null : facesForSelection(found.index, found.face))
  })

  /* ============================ pulling a face (ADR 0119) ============================ */

  /**
   * The translucent squares drawn over the faces a drag would move — **one per selected box** (ADR 0128).
   *
   * The face **is** the handle, so there is nothing to aim at but the box itself — SketchUp's model rather than
   * ProBuilder's select-then-drag. `depthTest: false` so it reads on a face pointing away from the light, and
   * `renderOrder` above the meshes so it is not z-fought by the surface it sits on.
   *
   * A pool rather than one, because with several boxes selected exactly one face on each of them moves, and
   * which face that is on a box rotated away from the others is the thing you cannot predict. Grown on
   * demand and never shrunk: a selection size is reached once and the plates are two triangles each.
   */
  const plateGeometry = new THREE.PlaneGeometry(1, 1)
  const plateMaterial = new THREE.MeshBasicMaterial({ color: 0x4a8cf7, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide })
  const facePlates: THREE.Mesh[] = []
  const plateAt = (slot: number): THREE.Mesh => {
    const made = facePlates[slot]
    if (made !== undefined) return made
    const plate = new THREE.Mesh(plateGeometry, plateMaterial)
    plate.renderOrder = 10
    plate.visible = false
    // Beside the gizmo: scene furniture, not part of the level.
    host.scene.add(plate)
    facePlates[slot] = plate
    return plate
  }
  const hideFacePlates = (from = 0): void => {
    for (let i = from; i < facePlates.length; i++) {
      const plate = facePlates[i]
      if (plate !== undefined) plate.visible = false
    }
  }

  /** One box taking part in a pull. The grabbed box is one of these; the rest of the selection are the others. */
  interface PullTarget {
    index: number
    face: Face
    /** Where this box's own face plane sits along its own normal, for snapping where it *lands* (ADR 0113/0117). */
    faceAt: number
    startScale: THREE.Vector3
    startPos: THREE.Vector3
    /** Local units per world metre along this axis, so a world drag becomes a local scale. */
    perMetre: number
    /**
     * The pulled axis as it points in the **parent's** frame — the node's own rotation applied to it.
     *
     * The node's rotation, not its world one, because that is the frame `position` is stored in. Without it
     * the centre moves along the parent's x while the face moves along the node's x, and a rotated box slides
     * away as it grows (ADR 0119).
     */
    axisInParent: THREE.Vector3
  }

  /** What a pull needs to remember from the moment the pointer went down. */
  let facePull: {
    /**
     * Every selected box the drag moves, the grabbed one included (ADR 0119).
     *
     * **The distance is the drag's, the plane is each box's own.** One `raw` comes off the pointer, measured
     * on the grabbed face's line, and every target moves its own face by that much along its own normal —
     * so five platforms all grow by what you dragged. What is *not* shared is the snap: each target snaps
     * where its own face lands, so boxes that started off the grid all arrive on it and end up flush, which
     * is the reason for selecting them together. Snapping off, `snappedPull` returns `raw` untouched and they
     * move identically instead, so both behaviours fall out of the toggle that already exists.
     */
    targets: PullTarget[]
    /** The line the grabbed face travels along, in world space; `dir` is its outward normal, unit length. */
    origin: THREE.Vector3
    dir: THREE.Vector3
    /** `distanceAlongAxis` at the press, so a move is measured as a change rather than an absolute. */
    t0: number
    /** The grabbed box, whose face the highlight follows. */
    primary: number
    primaryFace: Face
    /** The last good distance, held when the camera looks straight down the axis. */
    last: number
  } | null = null

  /**
   * The face of a **selected** box under a client position, or `null`.
   *
   * Any of them, nearest first — not just the primary (ADR 0128). With five platforms selected the drag moves
   * all five, so having to find the last-clicked one to start it is an arbitrary hunt; whichever you point at
   * begins the gesture and names the face.
   *
   * Selected boxes only, so a stray drag cannot reshape something you were not working on (ADR 0119). Only a
   * built-in box or rounded box: scale is the whole size for those (ADR 0090), so a pull is a transform edit
   * and nothing else. A sphere has no faces.
   */
  const faceUnder = (clientX: number, clientY: number): { index: number; face: Face; hit: THREE.Intersection } | null => {
    const open = host.doc()
    if (open === null) return null
    castFrom(clientX, clientY)
    let best: { index: number; hit: THREE.Intersection; world: THREE.Vector3 } | null = null
    for (const i of host.selection()) {
      const builtin = open.builtinOf(i)
      if (builtin !== 'builtin:box' && builtin !== 'builtin:rounded-box') continue
      const g = host.groupAt(i)
      if (g === undefined) continue
      const hit = raycaster.intersectObject(host.holderOf(g), true)[0]
      if (hit === undefined || hit.face === null || hit.face === undefined) continue
      // Nearest wins, so a box in front of another takes the gesture, as picking does. The normal is read
      // here, where it is still known to exist — carrying the hit and re-checking it later needs an assertion.
      if (best === null || hit.distance < best.hit.distance)
        best = { index: i, hit, world: hit.face.normal.clone().transformDirection(hit.object.matrixWorld) }
    }
    if (best === null) return null
    const g = host.groupAt(best.index)
    if (g === undefined) return null
    // The normal arrived in the hit mesh's own space; the face belongs to the node's.
    g.updateWorldMatrix(true, false)
    const local = best.world.transformDirection(new THREE.Matrix4().copy(g.matrixWorld).invert())
    const face = faceFromNormal(local)
    return face === null ? null : { index: best.index, face, hit: best.hit }
  }

  /** Choose a matched set of faces, or `null` to let go of the one held. */
  const chooseFace = (next: { dir: THREE.Vector3; faces: { index: number; face: Face }[] } | null): void => {
    chosen = next
    if (next === null) hideFacePlates()
    else showFaceHovers(next.faces)
  }

  /** Lay one plate over one box's face, sized to it. */
  const placePlate = (plate: THREE.Mesh, index: number, face: Face): boolean => {
    const g = host.groupAt(index)
    if (g === undefined) return false
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
    plate.position.copy(centre)
    plate.quaternion.copy(quat).multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal))
    plate.scale.set((spread[0] ?? 0.5) * 2, (spread[1] ?? 0.5) * 2, 1)
    plate.visible = true
    return true
  }

  /** Light every face a drag would move, and put out the plates left over from a bigger selection. */
  const showFaceHovers = (faces: readonly { index: number; face: Face }[]): void => {
    let slot = 0
    for (const f of faces) if (placePlate(plateAt(slot), f.index, f.face)) slot++
    hideFacePlates(slot)
  }

  /**
   * The face each selected box would move if the grabbed one moved `face`, and the world direction that is.
   *
   * The grabbed box keeps the face under the pointer. The rest are matched by `faceTowards`, so they grow the
   * way the drag is going rather than along their own lettered axis (ADR 0128). Shared by the hover preview
   * and the drag itself, so what lights up is exactly what will move.
   */
  const facesForSelection = (index: number, face: Face): { dir: THREE.Vector3; faces: { index: number; face: Face }[] } | null => {
    const g = host.groupAt(index)
    const open = host.doc()
    if (g === undefined || open === null) return null
    g.updateWorldMatrix(true, false)
    const quat = new THREE.Quaternion()
    g.matrixWorld.decompose(new THREE.Vector3(), quat, new THREE.Vector3())
    const dir = new THREE.Vector3(face.axis === 'x' ? face.sign : 0, face.axis === 'y' ? face.sign : 0, face.axis === 'z' ? face.sign : 0)
      .applyQuaternion(quat)
      .normalize()
    const faces = [{ index, face }]
    for (const i of host.selection()) {
      if (i === index) continue
      const builtin = open.builtinOf(i)
      if (builtin !== 'builtin:box' && builtin !== 'builtin:rounded-box') continue
      const other = host.groupAt(i)
      if (other === undefined) continue
      other.updateWorldMatrix(true, false)
      const q = new THREE.Quaternion()
      other.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3())
      const matched = MATCH_FACE_BY_WORLD_DIRECTION ? faceTowards(dir, q) : face
      if (matched !== null) faces.push({ index: i, face: matched })
    }
    return { dir, faces }
  }

  /**
   * Everything one box contributes to a pull, or `null` if it cannot take part.
   *
   * The face is decided already — `facesForSelection` matched it and the hover drew it — so this only
   * measures: where that face's plane sits, the box's scale and position at the press, and the frame
   * conversions the drag needs.
   */
  const targetFor = (index: number, face: Face): PullTarget | null => {
    const open = host.doc()
    if (open === null) return null
    const builtin = open.builtinOf(index)
    if (builtin !== 'builtin:box' && builtin !== 'builtin:rounded-box') return null
    const g = host.groupAt(index)
    if (g === undefined) return null
    g.updateWorldMatrix(true, false)
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const worldScale = new THREE.Vector3()
    g.matrixWorld.decompose(pos, quat, worldScale)

    const normal = new THREE.Vector3(face.axis === 'x' ? face.sign : 0, face.axis === 'y' ? face.sign : 0, face.axis === 'z' ? face.sign : 0)
      .applyQuaternion(quat)
      .normalize()
    const halfWorld = Math.abs(worldScale[face.axis]) / 2
    // Local units per world metre: the node's own scale is local, and the world size is that times the parent's.
    const localSize = Math.abs(g.scale[face.axis])
    return {
      index,
      face,
      // Where this box's face plane sits along its own normal. Axis-aligned that is just its world x, y or z;
      // rotated, it is the plane's offset, which is what a grid of parallel planes snaps to.
      faceAt: normal.clone().multiplyScalar(halfWorld).add(pos).dot(normal),
      startScale: g.scale.clone(),
      startPos: g.position.clone(),
      perMetre: localSize > 1e-9 && halfWorld > 1e-9 ? localSize / (halfWorld * 2) : 1,
      // `g.quaternion` and not the decomposed world one: `g.position` is in the parent's frame, so the axis
      // has to be carried into that same frame and no further.
      axisInParent: new THREE.Vector3(face.axis === 'x' ? 1 : 0, face.axis === 'y' ? 1 : 0, face.axis === 'z' ? 1 : 0)
        .applyQuaternion(g.quaternion)
        .normalize(),
    }
  }

  /**
   * Begin a pull on the set already chosen and drawn, so what is lit is exactly what moves.
   *
   * `false` when the press cannot become a drag, and the caller falls through to selection.
   */
  const beginFacePull = (clientX: number, clientY: number, matched: { dir: THREE.Vector3; faces: { index: number; face: Face }[] }): boolean => {
    const first = matched.faces[0]
    if (first === undefined || host.doc() === null) return false
    const g = host.groupAt(first.index)
    if (g === undefined) return false
    castFrom(clientX, clientY)
    g.updateWorldMatrix(true, false)
    const pos = new THREE.Vector3()
    g.matrixWorld.decompose(pos, new THREE.Quaternion(), new THREE.Vector3())
    const t0 = distanceAlongAxis(raycaster.ray.origin, raycaster.ray.direction, pos, matched.dir)
    if (t0 === null) return false

    // Exactly what the hover lit up. Anything that is not a built-in box has already dropped out, so a mixed
    // selection pulls the boxes in it rather than refusing the gesture.
    const targets: PullTarget[] = []
    for (const f of matched.faces) {
      const t = targetFor(f.index, f.face)
      if (t !== null) targets.push(t)
    }
    if (targets.length === 0) return false

    facePull = { targets, origin: pos.clone(), dir: matched.dir, t0, primary: first.index, primaryFace: first.face, last: 0 }
    host.edits().beginDrag()
    return true
  }

  /** Apply the pointer's position to the pull in progress. */
  const moveFacePull = (clientX: number, clientY: number): void => {
    const pull = facePull
    if (pull === null || host.doc() === null) return
    castFrom(clientX, clientY)
    const t = distanceAlongAxis(raycaster.ray.origin, raycaster.ray.direction, pull.origin, pull.dir)
    // Looking straight down the axis there is no answer; hold the last one rather than jumping.
    const raw = t === null ? pull.last : t - pull.t0
    pull.last = raw
    const step = host.snapping() ? host.faceStep() : 0
    const floor = Math.max(host.snapping() ? host.faceStep() : 0.05, 0.05)

    // One distance off the pointer, applied to every target on its own plane. Each snaps where *its* face
    // lands, so boxes that began off the grid arrive on it and come out flush; with snapping off `snappedPull`
    // hands back `raw` untouched and they all move by the same amount instead.
    let shown: { x: number; y: number; z: number } | null = null
    for (const target of pull.targets) {
      const g = host.groupAt(target.index)
      if (g === undefined) continue
      const next = pulled(
        { x: target.startScale.x, y: target.startScale.y, z: target.startScale.z },
        { x: target.startPos.x, y: target.startPos.y, z: target.startPos.z },
        target.face,
        snappedPull(target.faceAt, raw, step) * target.perMetre,
        floor * target.perMetre,
        target.axisInParent,
      )
      g.scale.set(next.scale.x, next.scale.y, next.scale.z)
      g.position.set(next.position.x, next.position.y, next.position.z)
      host.writeBackItem(target.index)
      host.rebuildSubtree(target.index)
      if (target.index === pull.primary) shown = next.scale
    }
    showFaceHovers(pull.targets)
    host.inspectorSync()
    // The grabbed box's size, and how many others came along. The rest have their own sizes, which the
    // Inspector shows; one status line cannot carry five.
    const extra = pull.targets.length - 1
    if (shown !== null)
      host.setStatus(`${r4(shown.x)} × ${r4(shown.y)} × ${r4(shown.z)}${extra > 0 ? ` +${extra}` : ''}`)
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
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP) return // was an orbit drag
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
    /** Tool change, or a selection that no longer contains the chosen box: the choice goes with it. */
    clearFaceHover: () => {
      chosen = null
      hideFacePlates()
    },
  }
}
