import { mergeAssetOps, applyBatch, OpError, type AssetOp, type Level, type NodeRef, type Op } from '@mp/content'

import type { ClipItem, Doc, OpBatch } from './editorDoc'
import { createOpHistory, foldBatches, type HistoryEntry } from './opHistory'
import type { Notify } from './notices'

/**
 * Undo, redo and the clipboard (ADR 0121).
 *
 * One module because these are one mechanism. Every mutation reaches the room and the history through the
 * same seam: a document reports its ops, and `recordEdit` folds everything reported since the last record into
 * one entry. Every document is a live room (ADR 0089, ADR 0091), so there is nothing to save and no "unsaved".
 *
 * It owns five variables that were loose in the shell: the history itself, the pending batches, the
 * coalescing flag, the held-back drag batches, and the clipboard. `coalescing` and `heldBack` in
 * particular were written from three places and read from one, with nothing saying they belonged together.
 *
 * **One history for everything this tab edits** (ADR 0159): a data-file asset's edit — a material's — sits in the
 * same stack as the level's, in the order they were made, and Ctrl+Z takes back whichever came last.
 */

/**
 * An edit to a data-file asset (ADR 0159): its ops on the asset's live document, and what undoes them, in undo
 * order. Undone by sending those the same way, as this tab's edit.
 */
export interface AssetEdit {
  assetId: string
  ops: AssetOp[]
  inverses: AssetOp[]
  label: string
}

type Entry = ({ kind: 'level' } & HistoryEntry) | ({ kind: 'asset' } & AssetEdit)

/** What the history needs from the editor around it. Getters, so nothing here holds a stale document. */
export interface HistoryHost {
  doc: () => Doc | null
  /** The file's own document — what a save writes, whatever prefab is open on top of it. */
  rootDoc: () => Doc | undefined
  /** The level every op applies to: the file's. A prefab opened on top is one of its table entries. */
  rootLevel: () => Level | null
  selection: () => readonly number[]
  selected: () => number | null
  /** The selection by identity that survives renumbering — what an undo puts back. */
  selectionRefs: () => NodeRef[]
  /** The selected nodes with any whose ancestor is also selected removed — what a copy takes. */
  selectionRoots: () => number[]
  applySelection: (indices: readonly number[]) => void
  deleteSelected: () => void
  /** The open level is a live room: every edit is already on the server (ADR 0089). */
  live: () => boolean
  submit: (batch: { ops: Op[]; inverses: Op[] }) => void
  /** Rebuild the viewport from the document: the item meshes and the physics world. */
  rebuildViewport: () => void
  /**
   * Redraw after an undo's ops, as a remote batch is (`liveSession.ts`): a move puts the groups back where the
   * data says, anything else rebuilds from data, and a gizmo drag holds it off.
   */
  repaint: (ops: readonly Op[]) => void
  /** Fetch what the document references but the runtime has not loaded, then run this. */
  loadNewReferencesThen: (redraw: () => void) => void
  /**
   * Apply a data-file asset's ops as this tab's edit — an undo is an edit like any other to everyone else — and
   * show that asset, as a level undo shows what was selected. `false` when they no longer apply (it is gone).
   */
  applyAsset: (assetId: string, ops: readonly AssetOp[], what: string) => boolean
  notify: Notify
  renderStatus: () => void
  refreshUi: () => void
}

export interface HistoryStore {
  /** Wrap a document so its ops are reported here. Every document the editor builds goes through this. */
  withOps: (d: Doc) => Doc
  /** Fold everything reported since the last record into one entry, labelled. */
  recordEdit: (label: string) => void
  /**
   * An edit to a data-file asset, already made (ADR 0159). `ongoing` while a gesture is still adding to it — a
   * colour being dragged is one entry — until a record of that asset without it, or any other entry, ends it.
   */
  recordAsset: (edit: AssetEdit, ongoing: boolean) => void
  /** Start over: a different file's edits are not this one's. */
  reset: () => void
  undo: () => void
  redo: () => void
  copySelected: () => void
  pasteClipboard: (asChild: boolean) => void
  cutSelected: () => void
  clipboardSize: () => number
  /** The items themselves, for a paste that places them itself. */
  items: () => readonly ClipItem[]
  /** Forget batches held back for a drag — leaving the room, where they have nowhere to go. */
  discardHeld: () => void
  /** One history entry per drag: `begin` holds recording off, `end` folds and sends. */
  beginDrag: () => void
  endDrag: (label: string) => void
  /** Drop a drag without folding it — a pull that never started. */
  abortDrag: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  /** Forget the entries holding these ops — a batch the server refused. */
  dropWhere: (predicate: (entry: { ops: readonly Op[]; inverses: readonly Op[] }) => boolean) => void
  depth: () => { undo: number; redo: number }
  /** What an undo and a redo would take back or put back, by their labels; `null` for nothing (ADR 0155). */
  labels: () => { undo: string | null; redo: string | null }
}

export const createHistoryStore = (host: HistoryHost): HistoryStore => {
  /** Batches held back during a drag: the room sees presence, not a hundred ops. */
  let heldBack: OpBatch[] = []

  const history = createOpHistory<Entry>()
  /** Batches the open documents reported since the last `recordEdit`. A gizmo drag piles up a hundred. */
  let pending: OpBatch[] = []
  const onDocOps = (batch: OpBatch): void => {
    pending.push(batch)
    if (!host.live()) return
    // Mid-drag the room sees presence, not a hundred ops: the batches wait and go as one when the drag ends.
    if (coalescing) heldBack.push(batch)
    else host.submit(batch)
  }
  /** Every document this file builds reports its ops here; the top of the stack and the root alike. */
  const withOps = (d: Doc): Doc => {
    d.onOps = onDocOps
    return d
  }
  /** True while a gizmo drag is in flight: one history entry per drag, not one per pointer event. */
  let coalescing = false
  /**
   * Record that an edit just happened: fold the batches the document reported since the last record into one
   * history entry. An edit that changed nothing reported nothing — the document drops an op whose inverse is
   * `null` — so a click on a gizmo handle, or picking the material a piece already had, records nothing, and
   * Ctrl+Z never needs pressing twice for one visible change.
   */
  const recordEdit = (label: string): void => {
    if (coalescing) return
    const entry = foldBatches(pending, label, host.selectionRefs())
    pending = []
    if (entry === null) return
    history.push({ kind: 'level', ...entry })
    host.renderStatus()
  }

  /** The asset entry a gesture is still adding to, while it is the last thing done. */
  let open: Entry | null = null

  const recordAsset = (edit: AssetEdit, ongoing: boolean): void => {
    const top = history.last()
    if (edit.ops.length > 0) {
      if (open !== null && open === top && open.kind === 'asset' && open.assetId === edit.assetId && open.label === edit.label) {
        // One more step of the same gesture: the newest value per path, and the value before the first.
        open.ops = mergeAssetOps(open.ops, edit.ops)
        open.inverses = mergeAssetOps(edit.inverses, open.inverses)
      } else {
        open = { kind: 'asset', ...edit }
        history.push(open)
      }
    }
    if (!ongoing) open = null
    host.renderStatus()
  }

  /** Start a fresh history: a different file's edits are not this one's. */
  const resetHistory = (): void => {
    history.clear()
    pending = []
    open = null
  }


  /**
   * Apply a history entry's ops straight to the level — not through a document, so nothing is re-reported — then
   * redraw the way a remote batch is, and put the selection back by identity. Resolves `false` when the ops no
   * longer apply (the node is gone); the entry is dropped and a warning says why.
   *
   * The redraw is `host.repaint`, not a rebuild of everything: undoing a move puts the groups back where the
   * data says, as a teammate's move does. It used to re-bake the sky and build every mesh and the physics world
   * twice, which on a level of a few hundred objects was the second an undo took.
   */
  const applyHistory = (ops: readonly Op[], keep: readonly NodeRef[], what: string): boolean => {
    const level = host.rootLevel()
    if (level === null) return false
    let applied: { ops: Op[]; inverses: Op[] }
    try {
      applied = applyBatch(level, ops)
    } catch (e) {
      host.notify.warn(`cannot ${what}: ${e instanceof OpError ? e.message : String(e)}`)
      return false
    }
    // An undo is an edit like any other to the room.
    if (host.live() && applied.ops.length > 0) host.submit(applied)
    pending = []
    host.repaint(applied.ops)
    const open = host.doc()
    const restored = open === null ? [] : keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
    // What was selected when the edit was made; putting it back also redraws the panels.
    host.applySelection(restored)
    return true
  }

  /** Apply one side of an entry: a level's ops, or an asset's, each the way it is edited. */
  const applyEntry = (entry: Entry, side: 'ops' | 'inverses', what: string): boolean => {
    open = null
    if (entry.kind === 'asset') return host.applyAsset(entry.assetId, entry[side], what)
    return applyHistory(entry[side], entry.selection, what)
  }

  const undo = (): void => {
    const entry = history.undo()
    if (entry === null) {
      host.notify.warn('nothing to undo')
      return
    }
    if (!applyEntry(entry, 'inverses', `undo ${entry.label}`)) {
      history.drop(entry)
      return
    }
    host.notify.ok(`undid: ${entry.label}`)
  }

  const redo = (): void => {
    const entry = history.redo()
    if (entry === null) {
      host.notify.warn('nothing to redo')
      return
    }
    if (!applyEntry(entry, 'ops', `redo ${entry.label}`)) {
      history.drop(entry)
      return
    }
    host.notify.ok(`redid: ${entry.label}`)
  }

  /**
   * The clipboard: one item, in memory.
   *
   * Not the system clipboard. Reading it needs a permission prompt or a paste event, and a scene object is not
   * text anybody would paste elsewhere — so a copy here would be a permission dialog in exchange for nothing.
   * The cost is that copying between two browser tabs of the editor does not work.
   */
  let clipboard: ClipItem[] = []

  const copySelected = (): void => {
    const open = host.doc()
    if (open === null || host.selection().length === 0) return
    // Ascending, so pasting a multi-item copy puts things back in the order they were in.
    const roots = host.selectionRoots().reverse()
    const items = roots.map((i) => open.copy(i)).filter((item): item is ClipItem => item !== null)
    if (items.length === 0) return
    clipboard = items
    host.notify.ok(items.length > 1 ? `copied ${items.length} items` : `copied ${open.label(roots[0]!)}`)
    host.refreshUi()
  }

  const pasteClipboard = (asChild: boolean): void => {
    const open = host.doc()
    if (open === null || clipboard.length === 0) return
    // A sibling of the selection by default, which is what every editor does; into it on the Shift variant,
    // since nesting is a placement decision and worth its own gesture (ADR 0025).
    const primary = host.selected()
    const parent = primary === null ? null : asChild ? primary : open.parentOf(primary)
    const landed: number[] = []
    for (const item of clipboard) {
      const at = open.paste(item, parent)
      if (at >= 0) landed.push(at)
    }
    if (landed.length === 0) {
      host.notify.warn(open.mode === 'level' ? 'the clipboard holds prefab pieces, not instances' : 'the clipboard holds instances, not pieces')
      return
    }
    recordEdit(landed.length > 1 ? `paste ${landed.length}` : 'paste')
    host.rebuildViewport()
    host.applySelection(landed)
    // A pasted item can name a material this document had never referenced.
    host.loadNewReferencesThen(() => {
      host.rebuildViewport()
      host.applySelection(landed)
    })
  }

  const cutSelected = (): void => {
    if (host.doc() === null || host.selection().length === 0) return
    copySelected()
    host.deleteSelected()
  }

  /**
   * A drag is one history entry, not one per pointer event.
   *
   * `begin` holds `recordEdit` off while a hundred transform ops are reported; `end` folds them into one entry
   * and sends the room one message. Both the gizmo and the face tool had a verbatim copy of this sequence.
   */
  const beginDrag = (): void => {
    coalescing = true
    heldBack = []
  }
  const endDrag = (label: string): void => {
    coalescing = false
    const drag = foldBatches(heldBack, label, [])
    heldBack = []
    if (drag !== null && host.live()) host.submit({ ops: drag.ops, inverses: drag.inverses })
    recordEdit(label)
  }

  return {
    withOps,
    recordEdit,
    recordAsset,
    reset: resetHistory,
    undo,
    redo,
    copySelected,
    pasteClipboard,
    cutSelected,
    clipboardSize: () => clipboard.length,
    items: () => clipboard,
    discardHeld: () => void (heldBack = []),
    beginDrag,
    endDrag,
    abortDrag: () => void (coalescing = false),
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    dropWhere: (predicate) => history.dropWhere((e) => e.kind === 'level' && predicate(e)),
    depth: () => history.depth(),
    labels: () => ({ undo: history.undoLabel(), redo: history.redoLabel() }),
  }
}
