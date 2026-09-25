import { PRIMITIVE_LABELS, type PrimitiveKind } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'
import { createThreeStage, OrbitControls, THREE } from '@mp/render-three'

import type { ClipItem, Doc } from './editorDoc'
import { rootsOf } from './selection'
import type { Notify } from './notices'

/**
 * What you do to the nodes you have: delete, duplicate, create, frame, and paste at a point (ADR 0121).
 *
 * One module because they all follow the same three steps — change the document, record one edit, rebuild the
 * viewport — and because every one of them operates on the **roots** of the selection rather than on all of
 * it. Selecting a parent and its child and deleting means deleting the parent once, not deleting a node and
 * then a node that is already gone; and duplicating downward means every index already recorded shifts by
 * however many nodes the last copy inserted. That arithmetic is the reason these belong together.
 */

/** Rounded the way the document stores numbers, so a created object's position reads plainly. */
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4

/** What acting on nodes needs from the editor around it. */
export interface NodeActionsHost {
  stage: ReturnType<typeof createThreeStage>
  controls: OrbitControls
  doc: () => Doc | null
  selection: () => readonly number[]
  applySelection: (indices: readonly number[]) => void
  select: (index: number) => void
  deselect: () => void
  groupAt: (i: number) => THREE.Group | undefined
  /** The projection, for framing: an orthographic camera frames by frustum, not by distance. */
  view: {
    isometric: () => boolean
    orthoCamera: THREE.OrthographicCamera
    activeCamera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera
    syncOrthoFrustum: (halfHeight: number) => void
  }
  edits: () => { recordEdit: (label: string) => void; clipboardSize: () => number; items: () => readonly ClipItem[] }
  rebuildMeshes: () => void
  rebuildLoaded: () => void
  scheduleRebuild: () => void
  loadNewReferencesThen: (redraw: () => void) => void
  inspectorSync: () => void
  notify: Notify
  refreshUi: () => void
  uiChanged: () => void
  /** Framing moves the camera: a follow ends (ADR 0155). */
  cameraMoved: () => void
}

export const createNodeActions = (host: NodeActionsHost) => {
  /**
   * The host.selection() reduced to what a structural operation should act on: **roots only**, highest index first.
   *
   * Roots, because deleting a parent takes its children with it and duplicating both would produce the child
   * twice. Descending, because removing or inserting only shifts the indices *after* the node touched — so
   * working from the bottom up leaves every index still to be processed valid, with no bookkeeping.
   */
  const selectionRoots = (): number[] => {
    const open = host.doc()
    return open === null ? [] : rootsOf(host.selection(), (i) => open.depthOf(i)).sort((a, b) => b - a)
  }

  const deleteSelected = (): void => {
    const open = host.doc()
    if (open === null || host.selection().length === 0) return
    const roots = selectionRoots()
    for (const i of roots) open.remove(i)
    host.edits().recordEdit(roots.length > 1 ? `delete ${roots.length}` : 'delete')
    host.deselect()
    host.rebuildMeshes()
    host.rebuildLoaded()
  }

  const duplicateSelected = (): void => {
    const open = host.doc()
    if (open === null || host.selection().length === 0) return
    const made: number[] = []
    for (const i of selectionRoots()) {
      const before = open.count()
      const at = open.duplicate(i)
      // A copy is a whole subtree, so it inserts more than one node. Everything already recorded sits after this
      // insertion point (we are working downward), so it shifts by however many nodes went in.
      const inserted = open.count() - before
      for (let n = 0; n < made.length; n++) made[n]! += inserted
      made.push(at)
    }
    host.edits().recordEdit(made.length > 1 ? `duplicate ${made.length}` : 'duplicate')
    host.rebuildMeshes()
    host.rebuildLoaded()
    // Reversed, so the primary ends up on the copy of what was the primary rather than on the lowest one.
    host.applySelection(made.reverse())
  }

  /**
   * Create an empty node and select it.
   *
   * Placed at `at` when given (the point that was right-clicked), otherwise on the parent it groups, otherwise
   * at the camera's focus — which is where a new object is expected to appear rather than at the world origin.
   */
  const createEmpty = (parent: number | null, at?: Vec3): void => {
    const open = host.doc()
    if (open === null) return
    const where = at ?? (parent === null ? vec3(r4(host.controls.target.x), r4(host.controls.target.y), r4(host.controls.target.z)) : vec3(0, 0, 0))
    const landed = open.placeEmpty(where, parent)
    if (landed < 0) {
      host.notify.warn('nowhere to put that')
      return
    }
    host.edits().recordEdit('create empty')
    host.rebuildMeshes()
    host.scheduleRebuild()
    host.select(landed)
    host.uiChanged()
  }

  /** Create a built-in shape at its preset size (ADR 0090) and select it. Placed like `createEmpty`. */
  const createPrimitive = (kind: PrimitiveKind, parent: number | null, at?: Vec3): void => {
    const open = host.doc()
    if (open === null) return
    const where = at ?? (parent === null ? vec3(r4(host.controls.target.x), r4(host.controls.target.y), r4(host.controls.target.z)) : vec3(0, 0, 0))
    const landed = open.placePrimitive(kind, where, parent)
    if (landed < 0) {
      host.notify.warn('nowhere to put that')
      return
    }
    host.edits().recordEdit(`create ${PRIMITIVE_LABELS[kind].toLowerCase()}`)
    host.rebuildMeshes()
    host.scheduleRebuild()
    host.select(landed)
    host.uiChanged()
    host.loadNewReferencesThen(host.rebuildMeshes)
  }

  /**
   * Frame nodes: put the orbit target on them and pull the camera back far enough to see all of them. The
   * selection's, or a collaborator's (ADR 0155).
   *
   * Along the camera's *current* direction, so framing something never also spins the view — the one thing
   * that makes a focus command disorienting rather than useful. A bounding sphere rather than the box's
   * diagonal, so a long thin platform is framed by its length and not by a corner-to-corner measurement that
   * would push the camera into the next county.
   */
  const frame = (indices: readonly number[]): void => {
    const box = new THREE.Box3()
    for (const i of indices) {
      const g = host.groupAt(i)
      if (g !== undefined) box.expandByObject(g)
    }
    if (box.isEmpty()) return
    host.cameraMoved()
    const centre = box.getCenter(new THREE.Vector3())
    const radius = Math.max(0.5, box.getBoundingSphere(new THREE.Sphere()).radius)
    const camera = host.view.activeCamera()
    const back = camera.position.clone().sub(host.controls.target)
    // Degenerate only if the camera is already at its own target, which the controls do not allow.
    if (back.lengthSq() < 1e-6) back.set(0, 1, 1)
    host.controls.target.copy(centre)
    if (host.view.isometric()) {
      // No fov to frame with: an orthographic camera frames by how much world its frustum holds, so the
      // distance only has to clear the geometry and the frustum does the framing.
      host.view.orthoCamera.zoom = 1
      host.view.syncOrthoFrustum(radius * 1.4)
      host.view.orthoCamera.position.copy(centre).add(back.normalize().multiplyScalar(Math.max(radius * 4, 10)))
    } else {
      const distance = (radius / Math.tan((host.stage.camera.fov * Math.PI) / 360)) * 1.4
      host.stage.camera.position.copy(centre).add(back.normalize().multiplyScalar(distance))
    }
    host.controls.update()
  }
  const focusSelection = (): void => frame(host.selection())

  /**
   * Paste at a world point rather than beside the host.selection().
   *
   * The **first** item lands on the point and the rest keep their offsets from it, so pasting a group of five
   * puts the group where you clicked instead of collapsing it onto one spot.
   */
  const pasteAt = (point: Vec3): void => {
    const open = host.doc()
    if (open === null || host.edits().clipboardSize() === 0) return
    const landed: number[] = []
    for (const item of host.edits().items()) {
      const at = open.paste(item, null)
      if (at >= 0) landed.push(at)
    }
    const first = landed[0]
    if (first === undefined) {
      host.notify.warn(open.mode === 'level' ? 'the clipboard holds prefab nodes, not placements' : 'the clipboard holds placements, not nodes')
      return
    }
    const from = open.transformOf(first).position
    const d = vec3(point.x - from.x, point.y - from.y, point.z - from.z)
    for (const i of landed) {
      const t = open.transformOf(i)
      open.setTransform(i, { ...t, position: vec3(r4(t.position.x + d.x), r4(t.position.y + d.y), r4(t.position.z + d.z)) })
    }
    host.edits().recordEdit(landed.length > 1 ? `paste ${landed.length} here` : 'paste here')
    host.rebuildMeshes()
    host.rebuildLoaded()
    host.applySelection(landed)
    host.loadNewReferencesThen(() => {
      host.rebuildMeshes()
      host.applySelection(landed)
    })
  }
  return {
    /** The selected nodes with any whose ancestor is also selected removed, deepest first. */
    selectionRoots,
    deleteSelected,
    duplicateSelected,
    createEmpty,
    createPrimitive,
    /** Frame the selection without spinning the view. */
    focusSelection,
    /** Frame these nodes, the same way. */
    frame,
    /** Paste at a world point: the first item lands on it and the rest keep their offsets. */
    pasteAt,
  }
}
