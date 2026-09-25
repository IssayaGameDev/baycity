import type { Transform } from '@mp/content'
import { eulerToQuat, vec3, type Vec3 } from '@mp/core'
import { createThreeStage, OrbitControls, THREE, TransformControls } from '@mp/render-three'

import type { Doc, LocalPose } from './editorDoc'
import type { PreviewOffset } from './motionPreview'
import { cornerSnapDelta, roundAngle, snapAnglesDeg, worldHalfExtents } from './snap'
import type { GizmoMode, GizmoSpace } from './toolbar'
import type { Notify } from './notices'

/**
 * The transform gizmo: the handles, what they snap to, and how a drag reaches the document (ADR 0031,
 * ADR 0114, ADR 0117, ADR 0121).
 *
 * Last of the eight to move, and the most tangled, because three things had to own themselves first: the
 * item groups it attaches to, the history a drag folds into one entry, and the pointer that tells a click
 * from a drag.
 *
 * It owns `edit` — which tool, which frame, whether snapping is on and by how much, one increment per tool
 * — the pose each selected item held when the drag began, and the two drag flags. Those two are separate on
 * purpose: `dragged` latches for the click handler, and `dragging` gates the *other* way into a transform,
 * the Inspector's numeric fields, because a typed value cannot legitimately arrive mid-drag.
 */

/** Rounded the way the document stores numbers. Angles use `roundAngle`, which rounds in degrees. */
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
const isOne = (v: THREE.Vector3): boolean => Math.abs(v.x - 1) < 1e-4 && Math.abs(v.y - 1) < 1e-4 && Math.abs(v.z - 1) < 1e-4
const isZeroRot = (e: THREE.Euler): boolean => Math.abs(e.x) < 1e-5 && Math.abs(e.y) < 1e-5 && Math.abs(e.z) < 1e-5

/**
 * A group's pose with the preview taken back out (ADR 0141): the transform the document should hold, given what
 * the group shows and what the preview added to it. Each part comes out the way it went in — a sequence's move
 * subtracted, its turn divided off the right of the rotation, its scale divided out.
 *
 * Pure, and exported, because it is the whole of what keeps a drag mid-preview from baking the animation into
 * the file (ADR 0050, ADR 0126).
 */
export const unpreviewed = (
  g: { readonly position: Vec3; readonly quaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number }; readonly scale: Vec3 },
  off: PreviewOffset,
): { position: Vec3; rotation: Vec3; scale: Vec3 } => {
  const turned = new THREE.Quaternion(g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w)
  const unturned = turned.multiply(new THREE.Quaternion(off.turn.x, off.turn.y, off.turn.z, off.turn.w).invert())
  const e = new THREE.Euler().setFromQuaternion(unturned, 'XYZ')
  const div = (a: number, b: number): number => (Math.abs(b) < 1e-9 ? a : a / b)
  return {
    position: vec3(g.position.x - off.position.x, g.position.y - off.position.y, g.position.z - off.position.z),
    rotation: vec3(e.x, e.y, e.z),
    scale: vec3(div(g.scale.x, off.scale.x), div(g.scale.y, off.scale.y), div(g.scale.z, off.scale.z)),
  }
}

/**
 * The world move that puts an object's **minimum corner** on the grid (ADR 0117): what a move snaps to, for an
 * item and for a sequence point's copy (ADR 0144) alike. The corner is of the world axis-aligned box, and a
 * built-in shape is a unit box at scale 1 (ADR 0090), so the world scale *is* the size in metres.
 */
export const cornerSnapOf = (g: THREE.Object3D, step: number): Vec3 => {
  g.updateWorldMatrix(true, false)
  const world = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  g.matrixWorld.decompose(world, quat, scale)
  const half = worldHalfExtents(new THREE.Matrix4().makeRotationFromQuaternion(quat).elements, {
    x: Math.abs(scale.x) / 2,
    y: Math.abs(scale.y) / 2,
    z: Math.abs(scale.z) / 2,
  })
  return cornerSnapDelta({ x: world.x - half.x, y: world.y - half.y, z: world.z - half.z }, step)
}

/** What the gizmo needs from the editor around it. */
export interface GizmoHost {
  stage: ReturnType<typeof createThreeStage>
  canvas: HTMLCanvasElement
  controls: OrbitControls
  scene: THREE.Scene
  /** The authored item groups — a top-level node's parent when it has none. */
  instanceRoot: () => THREE.Group
  doc: () => Doc | null
  selection: () => readonly number[]
  selected: () => number | null
  groupAt: (i: number) => THREE.Group | undefined
  rebuildSubtree: (i: number) => void
  rebuildLoaded: () => void
  playing: () => boolean
  /** The preview clock, which a write-back subtracts so a sequence's offset is not baked in (ADR 0050). */
  previewMs: () => number
  motionOffsetAt: (index: number, timeMs: number) => PreviewOffset
  /** Clear the face highlight when the tool changes away from Face (ADR 0119). */
  clearFaceHover: () => void
  /** A sequence's move point is open for dragging, and its copy has the handles instead (ADR 0144). */
  editingPoint: () => boolean
  edits: () => { beginDrag: () => void; endDrag: (label: string) => void }
  room: { startPresence: () => void; stopPresence: () => void; drainDeferred: () => void }
  inspectorSync: () => void
  uiChanged: () => void
  notify: Notify
}

export const createGizmoTool = (host: GizmoHost) => {
  /**
   * Snap increments, **one per tool** (ADR 0114).
   *
   * One number cannot serve three: 0.5 is a sensible grid in metres, a useless one in degrees, and a coarse one
   * for scale. Unity and Blender both keep three, and the viewport's snap field shows only the active tool's so
   * it does not grow three fields wide.
   *
   * `rotate` is in **degrees** — what the field shows and what a person thinks in; the radians are the gizmo's
   * business.
   */
  const STEP_LIMITS: Record<GizmoMode, { min: number; max: number; grain: number; unit: string }> = {
    translate: { min: 0.05, max: 10, grain: 0.05, unit: 'm' },
    rotate: { min: 1, max: 90, grain: 1, unit: '°' },
    scale: { min: 0.05, max: 5, grain: 0.05, unit: '×' },
    face: { min: 0.05, max: 10, grain: 0.05, unit: 'm' },
  }

  const edit: { mode: GizmoMode; snap: boolean; steps: Record<GizmoMode, number>; space: GizmoSpace } = {
    mode: 'translate',
    snap: true,
    steps: { translate: 0.5, rotate: 15, scale: 0.1, face: 0.5 },
    // Which frame the handles point along. Three forces `local` for scale and `world` for the free-rotate
    // ring, exactly as Unity does, so this only ever changes what it can.
    space: 'world',
  }

  const gizmo = new TransformControls(host.stage.camera, host.canvas)
  /**
   * Translation and scale snap to an **absolute** grid anchored at zero, which is what `TransformControls` does
   * for both: `Math.round(v / snap) * snap`.
   *
   * Rotation is left to us (ADR 0114). Three snaps `rotationAngle` — how far the drag has turned — not the
   * angle it lands on, so an object sitting at 7° goes to 22°, 37°, 52° and can never reach 15° or 30°. That
   * is a grid anchored to wherever you started, and it means snapping cannot straighten anything. `snapRotation`
   * below does it absolutely instead.
   */
  const applySnap = (): void => {
    // Translation and rotation are ours: three snaps a position's **centre** and a rotation's **delta**, and
    // neither is what snapping is for (ADR 0114, ADR 0117). Scale it does absolutely, which is right.
    gizmo.setTranslationSnap(null)
    gizmo.setRotationSnap(null)
    gizmo.setScaleSnap(edit.snap ? edit.steps.scale : null)
  }

  /**
   * Snap the primary's **minimum corner** to the grid, not its centre (ADR 0117).
   *
   * Snapping the centre made half of all sizes wrong: a box three cells wide, centred on a grid line, has its
   * edges halfway between lines, so its end cells are half covered — which is where keycaps hung over a
   * platform's edge. The edge is what meets the next platform; the centre is a number nobody looks at.
   *
   * The corner is of the **world axis-aligned** box, so a wall rotated on its edge snaps by the face you are
   * butting against something. Snapped in world space and converted back through the parent, so a child of a
   * moved or rotated group lands where the grid is rather than where its parent's frame happens to put it.
   *
   * Only the primary; `mirrorDragToSelection` gives the others its delta, as translation always has.
   */
  const snapTranslation = (): void => {
    const at = host.selected()
    if (edit.mode !== 'translate' || !edit.snap || at === null) return
    const g = host.groupAt(at)
    const step = edit.steps.translate
    if (g === undefined || step <= 0) return
    const d = cornerSnapOf(g, step)
    if (d.x === 0 && d.y === 0 && d.z === 0) return
    // The delta is a world translation; the group's position is in its parent's frame.
    const world = g.getWorldPosition(new THREE.Vector3())
    const parent = g.parent ?? host.instanceRoot()
    parent.updateWorldMatrix(true, false)
    const before = parent.worldToLocal(world.clone())
    const after = parent.worldToLocal(world.clone().add(new THREE.Vector3(d.x, d.y, d.z)))
    g.position.add(after.sub(before))
  }

  /**
   * Snap the primary's rotation onto the absolute grid, per axis (ADR 0114).
   *
   * Per Euler axis rather than as a whole orientation: a gizmo drag turns about **one** ring, so the other two
   * angles are already whatever they were and rounding them changes nothing. The free-rotate ring turns about a
   * camera-facing axis, where this is an approximation — predictable, and the price of a snap that lands on
   * round angles at all.
   *
   * Only the primary, because `mirrorDragToSelection` hands the others its **delta**: that keeps a group's
   * relative angles, and it is what translation already does, where three snaps the primary and the rest follow.
   */
  const snapRotation = (): void => {
    const at = host.selected()
    if (edit.mode !== 'rotate' || !edit.snap || at === null) return
    const g = host.groupAt(at)
    if (g === undefined) return
    const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
    const snapped = snapAnglesDeg(e, edit.steps.rotate)
    g.quaternion.setFromEuler(new THREE.Euler(snapped.x, snapped.y, snapped.z, 'XYZ'))
  }
  host.scene.add(gizmo.getHelper())

  /**
   * Point the gizmo at the primary's group, or at nothing.
   *
   * `meshes.buildAll` replaces every group, so anything holding one is stale the moment it returns — and a gizmo
   * holding a group that is no longer in the scene throws on the next click ("the attached 3D object must be a
   * part of the scene graph", then a null `updateMatrixWorld` in `pointerDown`). Called at both of `meshes.buildAll`'
   * exits, so the invariant holds however it was reached: a redraw after an async asset load
   * (`loadNewReferences`) never went through a host.selection() change, which is how the stale attachment survived.
   */
  const reattachGizmo = (): void => {
    // Face is not a `TransformControls` mode (ADR 0119): the handles are the faces themselves, so the gizmo
    // would only be three arrows in the way. An open move point is the same (ADR 0144): the handles are on its
    // copy, and two sets a metre apart would be a tangle.
    const at = host.selected()
    const g = at === null || host.playing() || edit.mode === 'face' || host.editingPoint() ? undefined : host.groupAt(at)
    if (g === undefined) gizmo.detach()
    else gizmo.attach(g)
    // Every selection change comes through here, and a face chosen on a box that is no longer selected
    // cannot be pulled (ADR 0129). Cleared from here rather than from `applySelection` because the host's
    // entry is an arrow: `pickTool` is constructed after the selection code that would otherwise call it.
    if (edit.mode === 'face') host.clearFaceHover()
  }

  /** Switch transform tool (the viewport's tool strip and the T/R/S keys are the same path). */
  const setMode = (mode: GizmoMode): void => {
    edit.mode = mode
    // `setMode` only knows the three it draws; Face detaches it instead (ADR 0119).
    if (mode !== 'face') gizmo.setMode(mode)
    host.clearFaceHover()
    reattachGizmo()
    host.uiChanged()
  }

  const setSpace = (space: GizmoSpace): void => {
    edit.space = space
    gizmo.space = space
    host.uiChanged()
  }

  // ============================== animation editing (ADR 0029) ==============================
  /**
   * The preview clock, in milliseconds of level time (ADR 0103).
   *
   * It poses **every** moving item, not only the host.selection(): a preview is meant to show what the level does at
   * that instant, and a lift that stood still while the platform beside it moved would be worse than no
   * preview at all. That is also why it is one clock for the whole level rather than one per object — motion is
   * timed against other motion, and a staggered row is the thing you actually need to look at.
   */
  /**
   * What each host.selected() item looked like when the current drag began.
   *
   * One job now: a multi-host.selection() mirrors the primary's delta onto everything else, which is meaningless
   * without the pose each of them started from (ADR 0031). It used to have a second — snapshotting the keys of
   * an animated item, whose whole track was rewritten by a delta on every pointer event — and ADR 0050 removed
   * it, because an offset track moves by its transform and needs nothing to accumulate against.
   */
  interface DragStart {
    pose: LocalPose
    scale: Vec3
  }
  let dragStart = new Map<number, DragStart>()

  /** A drag has happened, so the click handler knows this pointerup was not a click. */
  let gizmoDragged = false
  /**
   * A drag is in flight, so the gizmo owns the host.selection()'s pose.
   *
   * Separate from `gizmoDragged`, which latches for the click handler. This one gates the *other* way into a
   * transform — the Inspector's numeric fields — because a typed value cannot legitimately arrive from a person
   * mid-drag, and letting one through mid-drag re-poses the item from the document underneath the drag.
   */
  let gizmoDragging = false
  gizmo.addEventListener('dragging-changed', (event) => {
    const dragging = event.value as boolean
    host.controls.enabled = !dragging
    gizmoDragging = dragging
    if (dragging) {
      gizmoDragged = true
      // One history entry per drag, recorded when it ends. `coalescing` holds `recordEdit` off while the hundred
      // pointer events each report a transform op; the record at the end folds them into one.
      host.edits().beginDrag()
      host.room.startPresence()
      dragStart = new Map()
      if (host.doc() !== null) {
        for (const i of host.selection()) {
          const g = host.groupAt(i)
          if (g === undefined) continue
          dragStart.set(i, {
            // Read off the group, not from `poseOf`, though at this instant they agree: every value compared
            // against it later is also read off a group, so both sides share one rounding and one euler branch.
            // Mixing the stored euler with a re-derived one leaves a residue in the delta that accumulates.
            pose: groupPose(g),
            scale: vec3(g.scale.x, g.scale.y, g.scale.z),
          })
        }
      }
    } else {
      host.room.stopPresence()
      // The whole drag as one op per node — what the history holds, and what the room gets.
      host.edits().endDrag(host.selection().length > 1 ? `${edit.mode} ${host.selection().length}` : edit.mode)
      dragStart = new Map()
      host.rebuildLoaded()
      host.room.drainDeferred()
    }
  })
  gizmo.addEventListener('objectChange', () => {
    // Before the write-back and before the mirror, so the document and the other host.selected() items both see the
    // snapped value rather than the raw one (ADR 0114, ADR 0117).
    snapTranslation()
    snapRotation()
    writeBackSelected()
    mirrorDragToSelection()
    if (edit.mode === 'scale') for (const i of host.selection()) host.rebuildSubtree(i)
    host.inspectorSync()
  })

  /**
   * Apply the primary's drag delta to every other host.selected() item (ADR 0031).
   *
   * Translation is a shared world delta, which is the obvious reading of dragging five platforms. Rotation and
   * scale apply the same **local** delta to each item about its own origin — they do *not* orbit the host.selection()
   * about a shared pivot, which is what Unity does and what this deliberately is not: orbiting needs a pivot
   * object and a decision about where the pivot goes, and moving five things by the same amount is the case
   * that actually comes up when laying out a level.
   */
  const mirrorDragToSelection = (): void => {
    const open = host.doc()
    const at = host.selected()
    if (host.selection().length < 2 || at === null || open === null) return
    const primaryStart = dragStart.get(at)
    const primaryGroup = host.groupAt(at)
    if (primaryStart === undefined || primaryGroup === undefined) return

    const now = groupPose(primaryGroup)
    // Rotation as a local delta about each item's own origin, and scale as a ratio — a difference would be
    // meaningless for scale, and a zero start would make the ratio meaningless too.
    const dr = vec3(now.rotation.x - primaryStart.pose.rotation.x, now.rotation.y - primaryStart.pose.rotation.y, now.rotation.z - primaryStart.pose.rotation.z)
    const ds = vec3(
      primaryStart.scale.x === 0 ? 1 : primaryGroup.scale.x / primaryStart.scale.x,
      primaryStart.scale.y === 0 ? 1 : primaryGroup.scale.y / primaryStart.scale.y,
      primaryStart.scale.z === 0 ? 1 : primaryGroup.scale.z / primaryStart.scale.z,
    )

    /**
     * Translation is shared in **world** space, then converted into each item's own parent frame.
     *
     * A local delta would only be right for items that share a parent. Selecting a top-level platform and a crate
     * nested under a moving deck is ordinary, and their local frames differ by the deck's whole transform — so a
     * local delta would send the crate somewhere unrelated to the drag.
     */
    const worldOf = (group: THREE.Object3D, local: Vec3): THREE.Vector3 => {
      const parent = group.parent ?? host.instanceRoot()
      parent.updateWorldMatrix(true, false)
      return parent.localToWorld(new THREE.Vector3(local.x, local.y, local.z))
    }
    const worldDelta = worldOf(primaryGroup, now.position).sub(worldOf(primaryGroup, primaryStart.pose.position))

    for (const i of host.selection()) {
      if (i === host.selected()) continue
      const g = host.groupAt(i)
      const start = dragStart.get(i)
      if (g === undefined || start === undefined) continue

      // Posed from the *start* pose plus the delta, never from the running one: a hundred pointer events during
      // one drag must produce one offset, not a hundred compounding ones.
      const parent = g.parent ?? host.instanceRoot()
      parent.updateWorldMatrix(true, false)
      const target = parent.worldToLocal(worldOf(g, start.pose.position).add(worldDelta))
      g.position.copy(target)
      const q = eulerToQuat(vec3(start.pose.rotation.x + dr.x, start.pose.rotation.y + dr.y, start.pose.rotation.z + dr.z))
      g.quaternion.set(q.x, q.y, q.z, q.w)
      g.scale.set(start.scale.x * ds.x, start.scale.y * ds.y, start.scale.z * ds.z)
      writeBackItem(i)
    }
  }

  /**
   * Where a gizmo drag lands, per item (ADR 0103, ADR 0142).
   *
   * Always on the node's **authored transform**: a sequence's points are its own, relative to that, and are
   * dragged on their copy (ADR 0144).
   *
   * What it has to undo is the preview: while the clock runs, the group sits at rest **plus** its sequences'
   * offset, so writing the group's pose straight back would bake that offset into the transform and the object
   * would walk across the level every time it was nudged mid-preview. Taking the offset out is exact rather
   * than a delta against a snapshot, because a sequence's offset depends on the clock and not on the
   * transform the drag is rewriting.
   */
  const writeBackItem = (index: number): void => {
    const open = host.doc()
    if (open === null) return
    const g = host.groupAt(index)
    if (g === undefined) return
    const t = unpreviewed(g, host.motionOffsetAt(index, host.previewMs()))
    const scale = new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z)
    open.setTransform(index, {
      position: vec3(r4(t.position.x), r4(t.position.y), r4(t.position.z)),
      ...(isZeroRot(new THREE.Euler(t.rotation.x, t.rotation.y, t.rotation.z))
        ? {}
        : { rotation: vec3(roundAngle(t.rotation.x), roundAngle(t.rotation.y), roundAngle(t.rotation.z)) }),
      ...(isOne(scale) ? {} : { scale: vec3(r4(scale.x), r4(scale.y), r4(scale.z)) }),
    })
  }

  /** The primary's own write-back — what a gizmo drag or a typed Inspector value lands on first. */
  const writeBackSelected = (): void => {
    const at = host.selected()
    if (at !== null) writeBackItem(at)
  }

  /**
   * A group's local pose as a `Transform`, with `rotation`/`scale` left out when they are the identity.
   *
   * Built and handed to `open.setTransform` rather than mutating what `transformOf` returned: for an overridden
   * piece those are different objects, since reading gives the prefab's value and writing creates the
   * placement's own (ADR 0033).
   */
  const transformOfGroup = (g: THREE.Group): Transform => {
    const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
    return {
      position: vec3(r4(g.position.x), r4(g.position.y), r4(g.position.z)),
      ...(isZeroRot(e) ? {} : { rotation: vec3(roundAngle(e.x), roundAngle(e.y), roundAngle(e.z)) }),
      ...(isOne(g.scale) ? {} : { scale: vec3(r4(g.scale.x), r4(g.scale.y), r4(g.scale.z)) }),
    }
  }

  const groupPose = (g: THREE.Group): LocalPose => {
    const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
    return { position: vec3(r4(g.position.x), r4(g.position.y), r4(g.position.z)), rotation: vec3(roundAngle(e.x), roundAngle(e.y), roundAngle(e.z)) }
  }

  return {
    /** The three.js control itself, for a caller that has to re-point its camera. */
    control: gizmo,
    /** Which tool, which frame, and the snap increments — one per tool (ADR 0114). */
    edit,
    stepLimits: STEP_LIMITS,
    setMode,
    setSpace,
    /** Re-apply the snap settings to the control. */
    applySnap,
    /** Put the handles on the primary, or take them away. */
    reattach: reattachGizmo,
    /** A gizmo drag happened, so the release that follows is not a click. */
    dragged: () => gizmoDragged,
    setDragged: (value: boolean) => void (gizmoDragged = value),
    /** A drag is in flight, so the gizmo owns the selection's pose. */
    dragging: () => gizmoDragging,
    /** Write one item's group pose back into the document. */
    writeBackItem,
    writeBackSelected,
    /** A group's pose as the document stores it. */
    transformOfGroup,
    groupPose,
  }
}
