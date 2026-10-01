import { applyBatch, OpError, refKey, type Level, type NodeRef, type Op } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'
import { eulerToQuat } from '@mp/core'
import { createThreeStage, THREE, type OutlineGroup } from '@mp/render-three'

import { createCollab, httpTransport, parseCameraPresence, parseFollowPresence, parseMotionPresence, parsePresence, peerChanges, type CameraPresence, type FieldFocus, type FieldSpot, type Hold, type OpenAsset, type Peer, type Room } from './collab'
import type { Doc, LocalPose } from './editorDoc'
import type { Notify } from './notices'
import { repaintFor } from './remoteRepaint'

/**
 * A connection's colour: its outline in the viewport (ADR 0145), its icon in the top bar and its badge in the
 * Hierarchy (ADR 0155). From the connection id, so every tab in the room works out the same one unasked.
 */
export const peerColour = (connId: string): number => {
  let h = 0
  for (let i = 0; i < connId.length; i++) h = (h * 31 + connId.charCodeAt(i)) >>> 0
  return new THREE.Color().setHSL((h % 360) / 360, 0.75, 0.6).getHex()
}
/** The same colour for CSS. */
export const peerCss = (connId: string): string => `#${peerColour(connId).toString(16).padStart(6, '0')}`

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
  /** The object shown changed: its values in place, or the panel again when its shape changed (ADR 0168). */
  inspectorRefresh: () => void
  notify: Notify
  setProblem: (message: string) => void
  /** Who is in the room, or how this tab is connected to it, changed: the icons redraw (ADR 0155). */
  presenceChanged: () => void
  /** A peer's camera, while this tab follows someone (ADR 0155). */
  onCamera: (from: string, pose: Omit<CameraPresence, 'kind'>) => void
  /** A peer started following `leader`, or stopped (`null`). */
  onFollow: (from: string, leader: string | null) => void
  /** A peer's Motion preview started or stopped, while this tab follows someone (ADR 0184). */
  onMotion: (from: string, ms: number | null) => void
  /** What anyone in the room holds changed: a follow takes the leader's (ADR 0184). */
  holdsChanged: () => void
  /** A data-file asset was edited, by anyone, this tab included (ADR 0159): `assetSync.ts` checks and applies it. */
  onAsset: (data: unknown) => void
  /** The assets this tab has open in its Inspector (ADR 0159): told to everyone with the selection. */
  openAssetIds: () => string[]
  /** Who has which asset open changed: the Inspector's icons redraw. */
  openAssetsChanged: () => void
  /** Who is in which Inspector field changed (ADR 0160): the rings redraw. */
  fieldsChanged: () => void
  /** Who is in which level changed (ADR 0162): the games window redraws. */
  roomsChanged: () => void
  /** A level was made, renamed or deleted somewhere (ADR 0162): the list is read again. */
  levelsChanged: () => void
  /** Forget the history entries holding a batch the server refused. */
  dropHistoryWhere: (predicate: (entry: { ops: readonly Op[]; inverses: readonly Op[] }) => boolean) => void
}

export const createLiveSession = (host: LiveHost) => {
  // ============================== live levels (ADR 0089) ==============================
  /** Every connection in the room, this tab's included: the server lists them all. */
  let livePeers: Peer[] = []
  /** The level the last snapshot carried, for `openFile` to build its document over. */
  let latestSnapshot: Level | null = null
  /** True while `openFile` awaits its first snapshot; a later one (reconnect) reinstalls the document itself. */
  let joining = false
  /** Remote ops that landed mid-drag: applied to the data already, repainted when the drag ends. */
  let deferredRemote: Op[] = []
  /** Is the open document a live room? Levels and prefabs both are (ADR 0089, ADR 0091). */
  const live = (): boolean => collab.name() !== null

  const TRANSFORM_KINDS = new Set<string>(['setTransform', 'setOverrideTransform'])

  // ------------------------------ holds (phase 3, ADR 0158) ------------------------------
  /**
   * Every hold in the room by `refKey`, theirs and mine: what each connection has selected. **Shown, never
   * refused** (ADR 0158) — several people may have one node, and anyone edits anything.
   */
  let holdMap = new Map<string, Hold[]>()
  /**
   * The same holds as the room sent them. A connection's come in the order it took them, which a selection's
   * primary — its last — depends on; `holdMap` groups them by node, which loses that.
   */
  let holdsNow: Hold[] = []
  /** The selection the server was last told to hold, as a key, so an unchanged selection sends nothing. */
  let lastHoldKey: string | null = null

  /** The other connections that have node `index` itself selected, in the order they took it. */
  const holdersOf = (index: number): readonly Hold[] => {
    const ref = host.doc()?.refAt(index) ?? null
    if (ref === null || holdMap.size === 0) return []
    const mine = collab.connId()
    return (holdMap.get(refKey(ref)) ?? []).filter((h) => h.connId !== mine)
  }

  /**
   * Tell the room what I have selected, whole, every time it changes: the nodes, and the asset open in the
   * Inspector — which everyone in every document hears (ADR 0159).
   */
  const syncHolds = (): void => {
    if (!live()) return
    syncOpenAssets()
    const refs = host.selectionRefs()
    const key = refs.map(refKey).sort().join('|')
    if (key === lastHoldKey) return
    lastHoldKey = key
    void collab.setHolds(refs).catch(() => undefined)
  }

  // ------------------------------ open assets (ADR 0159) ------------------------------
  /** Who has which asset open, everyone's, from the server: the whole set. */
  let openAssets: OpenAsset[] = []
  /** What the server was last told this tab has open; `null` on a new connection, which has nothing open yet. */
  let lastOpenKey: string | null = null
  const syncOpenAssets = (): void => {
    if (!live()) return
    const ids = host.openAssetIds()
    const key = ids.join('|')
    if (key === lastOpenKey) return
    lastOpenKey = key
    void collab.setOpenAssets(ids).catch(() => undefined)
  }
  // ------------------------------ rooms (ADR 0162) ------------------------------
  /** Who is in which document, everyone's, from the server. */
  let rooms: Room[] = []
  /** The others in a level, by its qualified name: never this tab. */
  const peopleIn = (level: string): readonly Peer[] => {
    const me = collab.connId()
    const room = rooms.find((r) => r.kind === 'level' && r.name === level)
    return (room?.peers ?? []).filter((p) => p.connId !== me && !mineEver.has(p.connId))
  }

  // ------------------------------ fields (ADR 0160) ------------------------------
  /** Who is in which Inspector field, everyone's, from the server: the whole set. */
  let fieldsNow: FieldFocus[] = []
  /** The field this tab is in, kept so a new connection can say it again. */
  let mySpot: FieldSpot | null = null
  let lastFieldKey: string | null = null
  const sendField = (): void => {
    if (!live()) return
    const key = JSON.stringify(mySpot)
    if (key === lastFieldKey) return
    lastFieldKey = key
    void collab.setField(mySpot).catch(() => undefined)
  }
  /** This tab's lines are named in this document: a node's ref means nothing in another level. */
  const docTarget = (suffix: string): string => `${collab.kind() ?? 'level'}:${collab.name() ?? ''}|${suffix}`
  /** The others in a line of `target`, one per connection. */
  const fieldsOn = (target: string): readonly (FieldFocus & { connId: string })[] => {
    const me = collab.connId()
    return fieldsNow.filter((f) => f.connId !== me && !mineEver.has(f.connId) && f.targets.includes(target))
  }

  /** The others who have this asset open, one per connection, in the order they opened it. */
  const openersOf = (assetId: string): readonly Peer[] => {
    const me = collab.connId()
    return openAssets.filter((o) => o.assetId === assetId && o.connId !== me && !mineEver.has(o.connId)).map((o) => ({ connId: o.connId, name: o.name }))
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
    for (const h of [...holdMap.values()].flat()) {
      if (h.connId === mine) continue
      const i = open.indexOfRef(h.ref)
      const g = i === null ? undefined : host.groupAt(i)
      if (g === undefined) continue
      byConn.set(h.connId, [...(byConn.get(h.connId) ?? []), g])
    }
    holdOutlines = [...byConn].map(([connId, roots]) => ({ roots, color: peerColour(connId) }))
  }

  /** The room's holds changed: redraw the badges and the outlines. Nothing leaves my selection for it. */
  const onHoldsChanged = (holds: Hold[]): void => {
    const next = new Map<string, Hold[]>()
    for (const h of holds) next.set(refKey(h.ref), [...(next.get(refKey(h.ref)) ?? []), h])
    holdMap = next
    holdsNow = holds
    rebuildHoldOutlines()
    host.hierarchyRender()
    host.holdsChanged()
  }

  /**
   * Redraw after ops changed the level from outside the document — a remote batch, an undo. Transforms alone
   * move groups. Otherwise only what the ops touched is rebuilt, as this tab's own edit is (`remoteRepaint.ts`,
   * ADR 0167): each touched node's subtree, the physics a moment later, the Inspector only when it shows one of
   * them. What reshapes the tree, a prefab's definition, or an op not known rebuilds everything from data and puts
   * the selection back by identity. Mid-drag, the redraw waits: the gizmo owns the groups until the pointer comes up.
   * Play is the game in a frame, with a world of its own (ADR 0172), so it holds nothing back.
   */
  const repaintAfterOps = (ops: readonly Op[]): void => {
    if (host.gizmoDragging()) {
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
    const plan = open.reading(() =>
      repaintFor(ops, (ref, componentId) => {
        const i = open.indexOfRef(ref)
        return i === null ? undefined : open.components(i).find((c) => c.id === componentId)?.type
      }),
    )
    // The sky and its light re-bake only when the environment changed.
    if (plan.environment) host.installEnvironment(open.environment())
    if (plan.all) {
      const keep = host.selectionRefs()
      host.deselect()
      host.rebuildViewport()
      const restored = keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
      if (restored.length > 0) host.applySelection(restored)
      host.refreshUi()
      host.inspectorRebuild()
      host.loadNewReferencesThen(host.rebuildViewport)
      return
    }
    const touched = (): number[] => open.reading(() => [...new Set(plan.nodes.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null))])
    for (const i of touched()) host.rebuildSubtree(i)
    host.applyPreviewPoses()
    host.scheduleRebuild()
    rebuildHoldOutlines()
    host.hierarchyRender()
    // Another object's edit leaves the Inspector alone; one to the object shown updates its values in place, a
    // field being dragged or typed in keeping its own (ADR 0168).
    const shown = new Set(host.selectionRefs().map(refKey))
    const showsOne = (refs: readonly NodeRef[]): boolean => refs.some((r) => shown.has(refKey(r)))
    if (plan.environment || showsOne(plan.nodes)) host.inspectorRefresh()
    // A material or model named for the first time draws once it has loaded.
    host.loadNewReferencesThen(() => {
      for (const i of touched()) host.rebuildSubtree(i)
    })
  }

  /** Repaint what arrived while the redraw was held off — the end of a gizmo drag. */
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

  /**
   * What a peer streams: a drag's poses, or, for following (ADR 0155, ADR 0184), a camera, who they follow, or
   * their Motion preview. A drag poses their groups where they are and writes nothing; `end` puts every group
   * back on its data.
   */
  const onPresence = (from: string, data: unknown): void => {
    const camera = parseCameraPresence(data)
    if (camera !== null) {
      host.onCamera(from, { position: camera.position, target: camera.target, ortho: camera.ortho })
      return
    }
    const follow = parseFollowPresence(data)
    if (follow !== null) {
      host.onFollow(from, follow.leader)
      return
    }
    const motion = parseMotionPresence(data)
    if (motion !== null) {
      host.onMotion(from, motion.ms)
      return
    }
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
    onPeers: (peers) => onPeers(peers),
    onHolds: (holds) => onHoldsChanged(holds),
    onPresence: (from, _name, data) => onPresence(from, data),
    onPrefabOps: (assetId, ops) => onPrefabOps(assetId, ops),
    onAsset: (data) => host.onAsset(data),
    onOpenAssets: (open) => {
      openAssets = open
      host.openAssetsChanged()
    },
    onFields: (fields) => {
      fieldsNow = fields
      host.fieldsChanged()
    },
    onRooms: (next) => {
      rooms = next
      host.roomsChanged()
    },
    onLevelsChanged: () => host.levelsChanged(),
    onError: (message) => host.notify.error(`live: ${message}`),
    onConnection: (state) => {
      // Every stream that comes up is a new connection, with nothing open on the server yet.
      if (state === 'live') {
        lastOpenKey = null
        syncOpenAssets()
        lastFieldKey = null
        sendField()
      }
      host.presenceChanged()
    },
  })

  /**
   * Every connection id this tab has had. A reconnect is a new connection while the server may still list the
   * old one for a moment, under your own name: that is not somebody joining or leaving.
   */
  const mineEver = new Set<string>()
  /**
   * Who is in the room now. Arrivals and departures are said (ADR 0155) — but not the room as it was when this
   * tab joined, which is the icons' to show rather than a toast per person already there.
   */
  const onPeers = (peers: Peer[]): void => {
    const me = collab.connId()
    if (me !== null) mineEver.add(me)
    if (!joining) {
      const { joined, left } = peerChanges(livePeers, peers, mineEver)
      for (const p of joined) host.notify.ok(`${p.name} joined`)
      for (const p of left) host.notify.ok(`${p.name} left`)
    }
    livePeers = peers
    host.presenceChanged()
  }

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
    /** Is the open document a live room? Levels and prefabs both are (ADR 0089, ADR 0091). */
    live,
    /** Join a room; resolves the snapshot it greeted us with, or `null`. */
    joinRoom,
    leave: () => collab.leave(),
    /** Leaving everything: the room, the holds, the held batches and the presence timer. */
    leaveAll: () => {
      collab.leave()
      holdMap = new Map()
      holdsNow = []
      lastHoldKey = null
      lastOpenKey = null
      lastFieldKey = null
      stopPresence()
    },
    ping: () => collab.ping(),
    beaconLeave: () => collab.beaconLeave(),
    submit: (batch: { ops: Op[]; inverses: Op[] }) => collab.submit(batch),
    submitToPrefab: (assetId: string, ops: Op[]) => collab.submitToPrefab(assetId, ops),
    flush: () => collab.flush(),
    name: () => collab.name(),
    connId: () => collab.connId(),
    /** Everyone in the room, this tab included; nobody once no room is open. */
    peers: (): readonly Peer[] => (live() ? livePeers : []),
    /** How this tab's stream is, or `null` with no room open. */
    connection: () => collab.connection(),
    /** Send to everyone else in the room, kept nowhere (a camera, a follow). */
    presence: (data: unknown) => collab.presence(data),
    /** What a connection holds, in the order it took them: for Focus, the card (ADR 0155) and a follow (ADR 0184). */
    holdsOf: (connId: string): Hold[] => holdsNow.filter((h) => h.connId === connId),
    /** Report ops that arrived while the redraw was held off — a drag ending, a play-test ending. */
    drainDeferred: drainDeferredRemote,
    /** Redraw after ops changed the level from outside the document: a move puts groups back, anything else rebuilds. */
    repaint: repaintAfterOps,
    /** The others who have this node selected — its badges in the Hierarchy (ADR 0158). */
    holdersOf,
    /** Tell the room what I hold: the selection and the asset open, whole, every time they change. */
    syncHolds,
    /** The others who have this asset open (ADR 0159) — the icons on it in the Inspector. */
    openersOf,
    /** The Inspector field this tab is in, or none (ADR 0160): everyone is told. */
    setField: (spot: FieldSpot | null) => {
      mySpot = spot
      sendField()
    },
    /** `suffix` — a node's `refKey`, `@game`, `@env` — as a target in the open document. */
    docTarget,
    /** The others in a line of this target (ADR 0160) — the rings in the Inspector. */
    fieldsOn,
    /** The others in a level, by qualified name (ADR 0162) — the faces on the games window's tiles. */
    peopleIn,
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
