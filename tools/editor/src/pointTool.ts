import { SELF, SEQUENCE, sequenceOf, type SequenceAxes, type Stage } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'
import { THREE, TransformControls } from '@mp/render-three'

import type { Doc, SequenceRoute } from './editorDoc'
import { cornerSnapOf } from './gizmoTool'
import type { OpenPoint } from './inspector'
import { findStep, replaceStep } from './sequenceEdit'
import { pointToWorld, worldToPoint, type MoveStep, type PointFrame } from './sequencePoints'
import type { GizmoSpace } from './toolbar'

/**
 * A sequence's move points in the viewport (ADR 0144): the see-through copy of a move step's target at its
 * point, with move handles of its own, and the selected object's route.
 *
 * **The copy.** While a move step is open in the Inspector, its target is drawn again, see-through, where the
 * step puts it, and the handles are on the copy rather than on the object — the object's gizmo gives way, as
 * it does for Face (ADR 0119). Dragging the copy writes the step's `to`, one history entry per drag, snapped
 * like any move: the copy's minimum corner goes on the grid (ADR 0117).
 *
 * **The route.** For one selected object, a thin line from where it was placed through its move points in the
 * order they play, with a numbered dot at each. One line per sequence that moves it.
 *
 * Both sit in their own group outside the item groups, which is what makes them unpickable: every click
 * raycasts the item groups and nothing else. Positions come from the groups as they are posed now, so both
 * follow a parent the Motion preview is moving; the object's own place is its authored transform, since a
 * point is from where it was placed.
 */

/** What point editing needs from the editor around it. */
export interface PointToolHost {
  /** The camera the handles start on; `control.camera` follows a projection change. */
  camera: THREE.Camera
  canvas: HTMLCanvasElement
  /** The orbit controls, switched off while the copy is dragged. */
  controls: { enabled: boolean }
  scene: THREE.Scene
  doc: () => Doc | null
  selection: () => readonly number[]
  groupAt: (i: number) => THREE.Group | undefined
  holderOf: (g: THREE.Group) => THREE.Group
  /** The move step open in the Inspector, if any. */
  openPoint: () => OpenPoint | null
  activeCamera: () => THREE.Camera
  /** Play mode: nothing of this is drawn. */
  playing: () => boolean
  /** The Motion preview is running, so a group is not at its authored transform. */
  motionPlaying: () => boolean
  space: () => GizmoSpace
  snapping: () => boolean
  snapStep: () => number
  edits: () => { beginDrag: () => void; endDrag: (label: string) => void }
  /** A drag happened, so the release that follows is not a click. */
  setDragged: (value: boolean) => void
  /** Whether a point is open changed: the object's own gizmo gives way, or comes back. */
  reattachGizmo: () => void
  /** A point's numbers changed, and the Inspector shows them. */
  inspectorRebuild: () => void
  /** A drag ended: what a gizmo drag's end does after its history entry. */
  afterDrag: () => void
}

export interface PointTool {
  /** The copy's handles, for a caller that has to re-point its camera. */
  control: TransformControls
  /** Re-read what is open and what the selected object's routes are, and redraw both. */
  refresh: () => void
  /** Once per frame: follow the groups as they are posed now. */
  frame: () => void
  /** A move point is open, so the object's own gizmo gives way. */
  editing: () => boolean
  /** The copy is being dragged, so a remote repaint waits. */
  dragging: () => boolean
}

/** The one colour for everything a sequence draws in the viewport: warm, against the surface cells' blue. */
const OVERLAY = 0xffb347
/** How tall a route's dot is, as a fraction of the viewport's height, at any distance. */
const DOT = 0.028

/** Rounded the way the document stores numbers; `+ 0` turns the `-0` a rotation leaves behind into 0. */
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4 + 0
const sameVec = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z

const COPY_MATERIAL = new THREE.MeshBasicMaterial({ color: OVERLAY, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false })
const LINE_MATERIAL = new THREE.LineBasicMaterial({ color: OVERLAY, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false })

/** A dot's material per number, made once: a filled disc with the number on it. */
const dots = new Map<number, THREE.SpriteMaterial>()
const dotMaterial = (n: number): THREE.SpriteMaterial => {
  const hit = dots.get(n)
  if (hit !== undefined) return hit
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    ctx.beginPath()
    ctx.arc(32, 32, 28, 0, 2 * Math.PI)
    ctx.closePath()
    ctx.fillStyle = `#${OVERLAY.toString(16).padStart(6, '0')}`
    ctx.fill()
    ctx.font = 'bold 34px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#1a1206'
    ctx.fillText(String(n), 32, 34)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // The same size at every distance, and never behind the thing it marks.
  const material = new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false })
  dots.set(n, material)
  return material
}

/**
 * A see-through copy of an item group's own meshes and its children's, sharing their geometry. Lights, lines,
 * sprites and the surface cells are left out: a copy that lit the level or carried a board's cells would be
 * more than a copy.
 *
 * Always shown: only the Motion preview hides a group (a fade at 0, a disabling step), and a copy made at that
 * instant would be a copy of nothing.
 */
const copyOf = (o: THREE.Object3D): THREE.Object3D | null => {
  if (o instanceof THREE.Light || o instanceof THREE.Line || o instanceof THREE.Sprite || o instanceof THREE.InstancedMesh) return null
  const out = o instanceof THREE.Mesh ? new THREE.Mesh(o.geometry, COPY_MATERIAL) : new THREE.Object3D()
  out.position.copy(o.position)
  out.quaternion.copy(o.quaternion)
  out.scale.copy(o.scale)
  for (const child of o.children) {
    const c = copyOf(child)
    if (c !== null) out.add(c)
  }
  return out
}

/** The step being edited, and everything about where it sits. */
interface Editing {
  /** The node the sequence is on. */
  readonly holder: number
  readonly componentId: string
  readonly stages: readonly Stage[]
  readonly axes: SequenceAxes
  readonly step: MoveStep
  /** The node the step moves: the holder, or one of its children. */
  readonly target: number
}

/** A target's place, as the groups show it now. */
interface Place {
  readonly frame: PointFrame
  readonly rotation: THREE.Quaternion
  readonly scale: THREE.Vector3
}

export const createPointTool = (host: PointToolHost): PointTool => {
  const overlay = new THREE.Group()
  overlay.name = 'sequence-points'
  host.scene.add(overlay)
  const gizmo = new TransformControls(host.camera, host.canvas)
  gizmo.setMode('translate')
  host.scene.add(gizmo.getHelper())

  let editing: Editing | null = null
  let copy: THREE.Object3D | null = null
  /** What the copy was made from, so a rebuild of the object's meshes rebuilds the copy too. */
  let copiedFrom: { group: THREE.Group; first: THREE.Object3D | undefined } | null = null
  let dragging = false
  let wasPlaying = false
  let routeTarget: number | null = null
  let drawn: { route: SequenceRoute; line: THREE.Line; dots: THREE.Sprite[] }[] = []

  /**
   * Where a target was placed, in the world: its parent's group as posed now, times its authored local
   * transform. Stopped, the group *is* at its authored transform; running, the preview has moved it, so the
   * document says.
   */
  const placeOf = (target: number): Place | null => {
    const g = host.groupAt(target)
    const parent = g?.parent
    if (g === undefined || parent === null || parent === undefined) return null
    let position = g.position
    let rotation = g.quaternion
    let scale = g.scale
    const open = host.doc()
    if (host.motionPlaying() && open !== null) {
      const t = open.transformOf(target)
      const r = t.rotation ?? vec3(0, 0, 0)
      const s = t.scale ?? vec3(1, 1, 1)
      position = new THREE.Vector3(t.position.x, t.position.y, t.position.z)
      rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z, 'XYZ'))
      scale = new THREE.Vector3(s.x, s.y, s.z)
    }
    parent.updateWorldMatrix(true, false)
    const world = parent.matrixWorld.clone().multiply(new THREE.Matrix4().compose(position, rotation, scale))
    const rest = new THREE.Vector3()
    const worldRotation = new THREE.Quaternion()
    const worldScale = new THREE.Vector3()
    world.decompose(rest, worldRotation, worldScale)
    const parentRot = parent.getWorldQuaternion(new THREE.Quaternion())
    const own = new THREE.Euler().setFromQuaternion(rotation, 'XYZ')
    return {
      frame: { rest: vec3(rest.x, rest.y, rest.z), parentRot: { x: parentRot.x, y: parentRot.y, z: parentRot.z, w: parentRot.w }, ownRotation: vec3(own.x, own.y, own.z) },
      rotation: worldRotation,
      scale: worldScale,
    }
  }

  const editingOf = (open: Doc, p: OpenPoint): Editing | null => {
    const view = open.components(p.node).find((c) => c.id === p.componentId && c.type === SEQUENCE)
    if (view === undefined) return null
    const data = sequenceOf({ id: view.id, type: view.type, params: view.params })
    const step = findStep(data.stages, p.stepId)
    if (step?.kind !== 'move') return null
    const target = open.stepTargetOf(p.node, step.target ?? SELF)
    if (target === null) return null
    return { holder: p.node, componentId: view.id, stages: data.stages, axes: data.axes, step, target }
  }

  const dropCopy = (): void => {
    gizmo.detach()
    if (copy !== null) overlay.remove(copy)
    copy = null
    copiedFrom = null
  }

  const buildCopy = (): void => {
    dropCopy()
    const g = editing === null ? undefined : host.groupAt(editing.target)
    if (g === undefined) return
    const root = new THREE.Group()
    for (const child of g.children) {
      const c = copyOf(child)
      if (c !== null) root.add(c)
    }
    copy = root
    copiedFrom = { group: g, first: host.holderOf(g).children[0] }
    overlay.add(root)
    gizmo.attach(root)
  }

  const clearRoutes = (): void => {
    for (const d of drawn) {
      overlay.remove(d.line, ...d.dots)
      d.line.geometry.dispose()
    }
    drawn = []
    routeTarget = null
  }

  const buildRoutes = (open: Doc | null): void => {
    clearRoutes()
    const selection = host.selection()
    if (open === null || host.playing() || selection.length !== 1) return
    const at = selection[0]!
    const routes = open.routesAt(at)
    if (routes.length === 0) return
    routeTarget = at
    for (const route of routes) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((route.steps.length + 1) * 3), 3))
      const line = new THREE.Line(geometry, LINE_MATERIAL)
      // Its points move every frame the preview runs; bounds recomputed that often would cost more than drawing it.
      line.frustumCulled = false
      line.renderOrder = 998
      const marks = route.steps.map((_, n) => {
        const s = new THREE.Sprite(dotMaterial(n + 1))
        s.renderOrder = 999
        return s
      })
      overlay.add(line, ...marks)
      drawn.push({ route, line, dots: marks })
    }
  }

  /** A dot's scale that makes it `DOT` of the viewport's height, for either projection. */
  const dotScale = (): number => {
    const camera = host.activeCamera()
    if (camera instanceof THREE.PerspectiveCamera) return DOT * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    if (camera instanceof THREE.OrthographicCamera) return (DOT * (camera.top - camera.bottom)) / camera.zoom
    return 0.05
  }

  /** Put the copy and the routes where the groups say, now. */
  const place = (): void => {
    gizmo.space = host.space()
    if (editing !== null && copy !== null) {
      const g = host.groupAt(editing.target)
      // The object's meshes were rebuilt under it — a scale typed in, a material changed: so is the copy.
      if (!dragging && g !== undefined && (g !== copiedFrom?.group || host.holderOf(g).children[0] !== copiedFrom.first)) buildCopy()
      const at = placeOf(editing.target)
      if (at !== null && copy !== null) {
        // Mid-drag the handles own the copy's position; `write` puts it on the rounded point.
        if (!dragging) {
          const w = pointToWorld(editing.step.to, editing.axes, at.frame)
          copy.position.set(w.x, w.y, w.z)
        }
        copy.quaternion.copy(at.rotation)
        copy.scale.copy(at.scale)
      }
    }
    if (routeTarget === null) return
    const at = placeOf(routeTarget)
    if (at === null) return
    const k = dotScale()
    for (const d of drawn) {
      const positions = d.line.geometry.getAttribute('position') as THREE.BufferAttribute
      positions.setXYZ(0, at.frame.rest.x, at.frame.rest.y, at.frame.rest.z)
      d.route.steps.forEach((step, n) => {
        const w = pointToWorld(step.to, d.route.axes, at.frame)
        positions.setXYZ(n + 1, w.x, w.y, w.z)
        d.dots[n]?.position.set(w.x, w.y, w.z)
        d.dots[n]?.scale.set(k, k, 1)
      })
      positions.needsUpdate = true
    }
  }

  const refresh = (): void => {
    const open = host.doc()
    const was = editing !== null
    const p = open === null || host.playing() ? null : host.openPoint()
    const next = open === null || p === null ? null : editingOf(open, p)
    // A drag keeps its step even if a rebuild mid-drag briefly cannot find it.
    editing = next ?? (dragging ? editing : null)
    if (!dragging) {
      if (editing === null) dropCopy()
      else buildCopy()
    }
    buildRoutes(open)
    place()
    if (was !== (editing !== null)) host.reattachGizmo()
  }

  /** The copy's place as a point, rounded the way the document stores numbers, written as one step change. */
  const write = (): void => {
    const open = host.doc()
    if (open === null || editing === null || copy === null) return
    const at = placeOf(editing.target)
    if (at === null) return
    const p = worldToPoint(vec3(copy.position.x, copy.position.y, copy.position.z), editing.axes, at.frame)
    const to = vec3(r4(p.x), r4(p.y), r4(p.z))
    if (sameVec(to, editing.step.to)) return
    const step: MoveStep = { ...editing.step, to }
    const stages = replaceStep(editing.stages, step)
    open.setSequenceStages(editing.holder, editing.componentId, stages)
    editing = { ...editing, step, stages }
    host.inspectorRebuild()
  }

  gizmo.addEventListener('dragging-changed', (event) => {
    const on = event.value as boolean
    dragging = on
    host.controls.enabled = !on
    // At both ends: the release after a drag is not a click on whatever is behind the copy.
    host.setDragged(true)
    if (on) {
      // One history entry per drag, as the gizmo's: the ops each pointer event makes are folded at the end.
      host.edits().beginDrag()
      return
    }
    host.edits().endDrag('move point')
    host.afterDrag()
    refresh()
  })
  gizmo.addEventListener('objectChange', () => {
    if (copy === null) return
    if (host.snapping()) {
      const d = cornerSnapOf(copy, host.snapStep())
      copy.position.add(new THREE.Vector3(d.x, d.y, d.z))
    }
    write()
  })

  return {
    control: gizmo,
    refresh,
    frame: () => {
      const playing = host.playing()
      overlay.visible = !playing
      if (playing !== wasPlaying) {
        wasPlaying = playing
        refresh()
        return
      }
      if (!playing) place()
    },
    editing: () => editing !== null,
    dragging: () => dragging,
  }
}
