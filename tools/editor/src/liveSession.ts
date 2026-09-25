import { applyBatch, OpError, refKey, type Level, type NodeRef, type Op } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'
import { eulerToQuat } from '@mp/core'
import { createThreeStage, THREE, type OutlineGroup } from '@mp/render-three'

import { createCollab, httpTransport, parsePresence, type Hold, type Peer } from './collab'
import type { Doc, LocalPose } from './editorDoc'
import type { Notify } from './notices'

/**
 * The live room: the document stream, who else is in it, what they hold, and where their pointers are
 * (ADR 0089, ADR 0091, ADR 0121).
 *
 * One module because these are one mechanism. Every remote change arrives through `collab`'s hooks and leaves
 * through one repaint, and the hold badges, the tinted outlines and the presence poses are all keyed to the
 * same connection. It owns nine variables that were loose in the shell — `collab` itself, the peer list, the
 * last snapshot, `joining`, the deferred ops, the hold map and its last key, the hold outlines and the presence
 * timer.
 *
 * `joining` is the one worth naming: it exists so the **first** snapshot builds the document the caller is
 * about to build while a later one reinstalls it here, and two callers each raising and lowering it around
 * their own `await` was two chances to leak it. `joinRoom` owns it now.
 */

/** What the room needs from the editor around it. Getters, so nothing here holds a stale document. */
export interface LiveHost {
  /**
   * The whole hidden set arrived from the room (ADR 0132) — on the snapshot, and whenever anyone toggles.
   * The host stores it and repaints; nothing about the level changed, so no ops and no history.
   */
  onHidden: (keys: string[]) => void
  stage: ReturnType<typeof createThreeStage>
  doc: () => Doc | null
  /** The level every op applies to: the open file's, whatever prefab is open on top of it. */
  rootLevel: () => Level | null
  /** Whether the open file is a level; a prefab room streams a wrapper instead. */
  isLevel: () => boolean
  /**
   * Rebuild the file's document over a snapshot, keeping the history. `false` when it was refused — no root,
   * or a prefab room is open, whose snapshots are a prefab wrapper and would put its root in the level's
   * place.
   */
  reinstallRoot: (level: Level) => boolean
  selection: () => readonly number[]
  selectionRefs: () => NodeRef[]
  applySelection: (indices: readonly number[]) => void
  deselect: () => void
  groupAt: (i: number) => THREE.Group | undefined
  groupPose: (g: THREE.Group) => LocalPose
  /** A gizmo drag owns the groups; a remote repaint waits for the pointer to come up. */
  gizmoDragging: () => boolean
  /** A play session owns the physics world; a remote repaint would free it under the player. */
  playing: () => boolean
  applyPreviewPoses: () => void
  /** Rebuild the item meshes and the physics world from the document. */
  rebuildViewport: () => void
  rebuildSubtree: (i: number) => void
  scheduleRebuild: () => void
  installEnvironment: (config: ReturnType<NonNullable<ReturnType<LiveHost['doc']>>['environment']> | undefined) => void
  loadNewReferencesThen: (redraw: () => void) => void
  invalidatePreviews: () => void
  hierarchyRender: () => void
  refreshUi: () => void
  inspectorRebuild: () => void
  inspectorSync: () => void
  notify: Notify
  setProblem: (message: string) => void
  renderStatus: () => void
  /** Forget the history entries holding a batch the server refused. */
  dropHistoryWhere: (predicate: (entry: { ops: readonly Op[]; inverses: readonly Op[] }) => boolean) => void
}

export const createLiveSession = (host: LiveHost) => {
  // ============================== live levels (ADR 0089) ==============================
  /** Who else has this level open. */
  let livePeers: Peer[] = []
  /** The level the last snapshot carried, for `openFile` to build its document over. */
  let latestSnapshot: Level | null = null
  /** True while `openFile` awaits its first snapshot; a later one (reconnect) reinstalls the document itself. */
  let joining = false
  /** Remote ops that landed mid-drag: applied to the data already, repainted when the drag ends. */
  let deferredRemote: Op[] = []
  /** Is the open document a level in a live session? Prefabs and materials are files with locks, as before. */
  /** Is the open document a live room? Both kinds are now (ADR 0091); a material is still a file with a lock. */
  const live = (): boolean => collab.name() !== null

  const TRANSFORM_KINDS = new Set<string>(['setTransform', 'setOverrideTransform'])

  // ------------------------------ holds (phase 3) ------------------------------
  /** Every hold in the room by `refKey`, theirs and mine. */
  let holdMap = new Map<string, Hold>()
  /** The selection the server was last told to hold, as a key, so an unchanged selection sends nothing. */
  let lastHoldKey: string | null = null

  /** The name of another connection holding node `index` or any node above it; `null` when it is free. */
  const heldBy = (index: number): string | null => {
    const open = host.doc()
    if (open === null || holdMap.size === 0) return null
    const mine = collab.connId()
    for (let i: number | null = index; i !== null; i = open.parentOf(i)) {
      const ref = open.refAt(i)
      if (ref === null) continue
      const h = holdMap.get(refKey(ref))
      if (h !== undefined && h.connId !== mine) return h.name
    }
    return null
  }

  /**
   * Tell the room what I hold: the selection, whole, every time it changes. The server refuses a ref someone
   * else has (a race the local filter lost): the refused nodes drop out of the selection.
   */
  const syncHolds = (): void => {
    if (!live()) return
    const refs = host.selectionRefs()
    const key = refs.map(refKey).sort().join('|')
    if (key === lastHoldKey) return
    lastHoldKey = key
    void collab.setHolds(refs).then((r) => {
      if (r.ok) return
      host.notify.warn(`${r.holder} has that selected`)
      const refused = new Set(r.refused.map(refKey))
      const open = host.doc()
      if (open === null) return
      host.applySelection(host.selection().filter((i) => {
        const ref = open.refAt(i)
        return ref === null || !refused.has(refKey(ref))
      }))
    })
  }

  const holdColour = (connId: string): number => {
    let h = 0
    for (let i = 0; i < connId.length; i++) h = (h * 31 + connId.charCodeAt(i)) >>> 0
    return new THREE.Color().setHSL((h % 360) / 360, 0.75, 0.6).getHex()
  }
  /**
   * What others hold, as outlines in their colours (ADR 0145): a group per connection, each hold's node group —
   * which carries its subtree, as a hold does. Outlined every frame from the groups as they are posed, so a
   * collaborator's drag keeps up with no per-frame work here.
   *
   * Recomputed from `meshes.buildAll` as well as on a holds event, and that is the load-bearing part: a rebuild
   * replaces every group, and an outline of a group no longer in the scene draws nothing at all. Cached rather
   * than asked each frame, because finding a node by its ref walks the document.
   */
  let holdOutlines: OutlineGroup[] = []
  const rebuildHoldOutlines = (): void => {
    holdOutlines = []
    const open = host.doc()
    if (open === null || !live()) return
    const mine = collab.connId()
    const byConn = new Map<string, THREE.Object3D[]>()
    for (const h of holdMap.values()) {
      if (h.connId === mine) continue
      const i = open.indexOfRef(h.ref)
      const g = i === null ? undefined : host.groupAt(i)
      if (g === undefined) continue
      byConn.set(h.connId, [...(byConn.get(h.connId) ?? []), g])
    }
    holdOutlines = [...byConn].map(([connId, roots]) => ({ roots, color: holdColour(connId) }))
  }

  /** The room's holds changed: drop what I can no longer have, redraw the badges and the outlines. */
  const onHoldsChanged = (holds: Hold[]): void => {
    holdMap = new Map(holds.map((h) => [refKey(h.ref), h]))
    const mine = host.selection()
    if (mine.some((i) => heldBy(i) !== null)) host.applySelection(mine.filter((i) => heldBy(i) === null))
    rebuildHoldOutlines()
    host.hierarchyRender()
  }

  /**
   * Redraw after ops changed the level from outside the document — a remote batch, an undo. Transforms alone
   * move groups; anything else rebuilds from data, as every structural edit does, and puts the selection back
   * by identity. Mid-drag, the redraw waits: the gizmo owns the groups until the pointer comes up.
   *
   * **And while playing.** `rebuildLoaded` frees the physics world and builds a new one, and a play session
   * lives in that world: its character is a body in it, its visuals came from that `loaded`. Repainting under
   * a play-test therefore pulled the floor out from under the player on every remote edit. Editing is
   * suspended while playing anyway, so the redraw waits exactly as a drag's does and `play.stop` drains it.
   */
  const repaintAfterOps = (ops: readonly Op[]): void => {
    if (host.gizmoDragging() || host.playing()) {
      deferredRemote.push(...ops)
      return
    }
    const open = host.doc()
    if (open === null) return
    if (ops.every((o) => TRANSFORM_KINDS.has(o.kind))) {
      host.applyPreviewPoses()
      // A remote scale change: the meshes are built from the scale (ADR 0090), so the touched subtrees redraw.
      for (const o of ops) {
        const ref: NodeRef | null = o.kind === 'setTransform' ? (o.table !== undefined ? { table: o.table, id: o.id } : { id: o.id }) : o.kind === 'setOverrideTransform' ? { owner: o.owner, node: o.node } : null
        const i = ref === null ? null : open.indexOfRef(ref)
        if (i !== null) host.rebuildSubtree(i)
      }
      host.scheduleRebuild()
      host.inspectorSync()
      return
    }
    const keep = host.selectionRefs()
    host.deselect()
    host.installEnvironment(open.environment())
    host.rebuildViewport()
    const restored = keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
    if (restored.length > 0) host.applySelection(restored)
    host.refreshUi()
    host.inspectorRebuild()
    host.loadNewReferencesThen(host.rebuildViewport)
  }

  /** Repaint what arrived while the redraw was held off — the end of a gizmo drag, the end of a play-test. */
  const drainDeferredRemote = (): void => {
    if (deferredRemote.length === 0) return
    const ops = deferredRemote
    deferredRemote = []
    repaintAfterOps(ops)
  }

  /**
   * A fresh copy of the **level** arrived (a reconnect): rebuild the document over it, keeping the history.
   *
   * Refused while a prefab room is open: that stream's snapshots are a prefab wrapper, and building a level
   * document over one would put a prefab's root in the level's place.
   */
  const reinstallLevel = (level: Level): void => {
    if (!host.reinstallRoot(level)) return
    lastHoldKey = null // a reconnect is a new connection: the server holds nothing for it yet
    syncHolds()
  }

  // ------------------------------ presence (phase 4) ------------------------------
  /** ~10 Hz: what a pointer drag looks like from across the room without a POST per pointer event. */
  const PRESENCE_MS = 100
  let presenceTimer: ReturnType<typeof setInterval> | null = null
  /** Batches the document reported during a gizmo drag: held back and sent as one op at drag end. */

  /** The poses of what I am dragging, off the groups: what the gizmo has set, whatever the document will store. */
  const dragPoses = (): { ref: NodeRef; position: Vec3; rotation: Vec3; scale: Vec3 }[] => {
    const open = host.doc()
    if (open === null) return []
    const out: { ref: NodeRef; position: Vec3; rotation: Vec3; scale: Vec3 }[] = []
    for (const i of host.selection()) {
      const g = host.groupAt(i)
      const ref = open.refAt(i)
      if (g === undefined || ref === null) continue
      const pose = host.groupPose(g)
      out.push({ ref, position: pose.position, rotation: pose.rotation, scale: vec3(g.scale.x, g.scale.y, g.scale.z) })
    }
    return out
  }
  const startPresence = (): void => {
    if (!live() || presenceTimer !== null) return
    presenceTimer = setInterval(() => collab.presence({ kind: 'pose', poses: dragPoses() }), PRESENCE_MS)
  }
  const stopPresence = (): void => {
    if (presenceTimer === null) return
    clearInterval(presenceTimer)
    presenceTimer = null
    collab.presence({ kind: 'pose', poses: [], end: true })
  }

  /** A peer's drag: pose their groups where they are, write nothing. `end` puts every group back on its data. */
  const onPresence = (data: unknown): void => {
    const p = parsePresence(data)
    const open = host.doc()
    if (p === null || open === null) return
    if (p.end === true) {
      // Not while my own gizmo owns the groups: my drag end repaints, and the deferred remote ops with it.
      if (!host.gizmoDragging()) host.applyPreviewPoses()
      return
    }
    for (const pose of p.poses) {
      const i = open.indexOfRef(pose.ref)
      const g = i === null ? undefined : host.groupAt(i)
      if (i === null || g === undefined || (host.gizmoDragging() && host.selection().includes(i))) continue
      g.position.set(pose.position.x, pose.position.y, pose.position.z)
      const q = eulerToQuat(pose.rotation)
      g.quaternion.set(q.x, q.y, q.z, q.w)
      g.scale.set(pose.scale.x, pose.scale.y, pose.scale.z)
    }
  }

  /**
   * A prefab the open level uses was edited in its own document (ADR 0091). Its ops are written against that
   * prefab's wrapper, whose one root **is** the definition this level resolved, so wrapping and applying them
   * writes through to every placement at once. Nothing is sent back: this level's own sequence did not move.
   */
  const onPrefabOps = (assetId: string, ops: Op[]): void => {
    const level = host.rootLevel()
    const root = level?.prefabs?.[assetId]
    if (level === undefined || level === null || root === undefined) return
    try {
      applyBatch({ id: assetId, config: {}, nodes: [root] }, ops)
    } catch (e) {
      // The definition here is behind the server's; the next open will take a fresh copy.
      host.notify.error(`a prefab changed in a way this level could not follow: ${e instanceof OpError ? e.message : String(e)}`)
      return
    }
    // Every placement of it changed shape, so this is the structural repaint, not the cheap one.
    const open = host.doc()
    if (open === null) return
    const keep = host.selectionRefs()
    host.deselect()
    host.rebuildViewport()
    const restored = keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
    if (restored.length > 0) host.applySelection(restored)
    host.refreshUi()
    host.inspectorRebuild()
    host.invalidatePreviews()
    host.loadNewReferencesThen(host.rebuildViewport)
  }

  const collab = createCollab(httpTransport(), {
    level: () => (host.isLevel() ? host.rootLevel() : null),
    onSnapshot: (level) => {
      latestSnapshot = level
      if (!joining) reinstallLevel(level)
    },
    onApplied: (ops) => repaintAfterOps(ops),
    onHidden: (keys) => host.onHidden(keys),
    onRejected: (batch, reason) => {
      // The batch is already rolled back in the data; forget the history entry that holds it, then redraw.
      host.dropHistoryWhere((entry) => entry.ops.some((o) => batch.ops.includes(o)) || entry.inverses.some((o) => batch.ops.includes(o)))
      host.notify.error(`edit refused: ${reason}`)
      repaintAfterOps(batch.inverses)
    },
    onPeers: (peers) => {
      livePeers = peers
      host.renderStatus()
    },
    onHolds: (holds) => onHoldsChanged(holds),
    onPresence: (_from, _name, data) => onPresence(data),
    onPrefabOps: (assetId, ops) => onPrefabOps(assetId, ops),
    onError: (message) => host.notify.error(`live: ${message}`),
  })

  /**
   * Join a room and hand back the snapshot it greeted us with.
   *
   * `joining` lives here rather than being raised and lowered by each caller around its own `await`: the flag
   * exists so the **first** snapshot builds the document the caller is about to build, while a later one (a
   * reconnect) reinstalls it here. Two callers each managing that by hand is two chances to leak it.
   */
  const joinRoom = async (name: string, kind?: 'prefab'): Promise<Level | null> => {
    joining = true
    try {
      await collab.join(name, kind)
    } finally {
      joining = false
    }
    return latestSnapshot
  }

  return {
    /** Is the open document a live room? Both kinds are (ADR 0091); a material is still a file with a lock. */
    live,
    /** Join a room; resolves the snapshot it greeted us with, or `null`. */
    joinRoom,
    leave: () => collab.leave(),
    /** Leaving everything: the room, the holds, the held batches and the presence timer. */
    leaveAll: () => {
      collab.leave()
      holdMap = new Map()
      lastHoldKey = null
      stopPresence()
    },
    ping: () => collab.ping(),
    beaconLeave: () => collab.beaconLeave(),
    submit: (batch: { ops: Op[]; inverses: Op[] }) => collab.submit(batch),
    submitToPrefab: (assetId: string, ops: Op[]) => collab.submitToPrefab(assetId, ops),
    flush: () => collab.flush(),
    name: () => collab.name(),
    connId: () => collab.connId(),
    peers: () => livePeers,
    /** Report ops that arrived while the redraw was held off — a drag ending, a play-test ending. */
    drainDeferred: drainDeferredRemote,
    /** Redraw after ops changed the level from outside the document: a move puts groups back, anything else rebuilds. */
    repaint: repaintAfterOps,
    /** The name of another connection holding this node or any above it; `null` when it is free. */
    heldBy,
    /** Tell the room what I hold: the selection, whole, every time it changes. */
    syncHolds,
    /** A reconnect is a new connection: the server holds nothing for it yet. */
    forgetHolds: () => void (lastHoldKey = null),
    rebuildHolds: rebuildHoldOutlines,
    /** What others hold, one outline group per connection (ADR 0145). */
    holdOutlines: (): readonly OutlineGroup[] => holdOutlines,
    startPresence,
    stopPresence,
    /** Hide or show nodes for everyone in the room (ADR 0132). The server's echo is the ack. */
    setHidden: (keys: string[], hidden: boolean) => collab.setHidden(keys, hidden),
  }
}
