import { stripHydrated, applyBatch, OpError, type Level, type NodeRef, type Op } from '@mp/content'

import { askUnsaved } from './confirm'
import type { ClipItem, Doc, OpBatch } from './editorDoc'
import { saveFile } from './filesApi'
import { createOpHistory, foldBatches } from './opHistory'

/**
 * Undo, redo, the clipboard, and whether the open document is on disk (ADR 0121).
 *
 * One module because these are one mechanism. Every mutation reaches the room and the history through the
 * same seam: a document reports its ops, `recordEdit` folds everything reported since the last record into
 * one entry, and `dirty` is set there — so "can I undo" and "is this on disk" stay separate questions, which
 * they are (undo depth survives a save).
 *
 * It owns six variables that were loose in the shell: the history itself, the pending batches, the
 * coalescing flag, the held-back drag batches, `dirty`, and the clipboard. `coalescing` and `heldBack` in
 * particular were written from three places and read from one, with nothing saying they belonged together.
 */

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
  fileName: () => string
  /** Who holds the file lock when it is not you, or `null`. */
  readOnlyBy: () => string | null
  /** Take the lock the pending write needs; resolves the owner when refused, `null` when it is ours. */
  claimFileLock: () => Promise<string | null>
  /** Prefabs hydration added to the table — stripped on the way out so the file keeps references. */
  hydratedPrefabs: () => string[]
  /** Invalidate previews, re-read the asset database, refresh the file list. */
  afterSave: () => Promise<void>
  /** Rebuild the viewport from the document: the item meshes and the physics world. */
  rebuildViewport: () => void
  /**
   * Redraw after an undo's ops, as a remote batch is (`liveSession.ts`): a move puts the groups back where the
   * data says, anything else rebuilds from data, and a gizmo drag or a play-test holds it off.
   */
  repaint: (ops: readonly Op[]) => void
  /** Fetch what the document references but the runtime has not loaded, then run this. */
  loadNewReferencesThen: (redraw: () => void) => void
  setStatus: (message: string) => void
  renderStatus: () => void
  refreshUi: () => void
}

export interface HistoryStore {
  /** Wrap a document so its ops are reported here. Every document the editor builds goes through this. */
  withOps: (d: Doc) => Doc
  /** Fold everything reported since the last record into one entry, labelled. */
  recordEdit: (label: string) => void
  /** Start over: a different file's edits are not this one's. */
  reset: () => void
  undo: () => void
  redo: () => void
  /** Write the open document to disk; `false` when it did not happen, so a caller can refuse to move on. */
  saveNow: () => Promise<boolean>
  /** May the open document be replaced? Asks first when it has edits that are not on disk. */
  guardUnsaved: () => Promise<boolean>
  dirty: () => boolean
  /** A live level is saved as it is edited, so opening one starts clean. */
  setDirty: (value: boolean) => void
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
}

export const createHistoryStore = (host: HistoryHost): HistoryStore => {
  /** Batches held back during a drag: the room sees presence, not a hundred ops. */
  let heldBack: OpBatch[] = []

  const history = createOpHistory()
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
   * Are there edits not on disk?
   *
   * Set at `recordEdit`, the one seam every mutation already goes through, and cleared by `resetHistory` —
   * which runs on save and on opening a document, the two moments after which there is nothing to lose. A
   * separate flag rather than `history.canUndo()`: undo depth survives a save, and asking "can I undo" is not
   * asking "is this on disk".
   */
  let dirty = false

  /**
   * Write the open document to disk. Awaitable, because the unsaved-edits prompt has to be able to save
   * *and then* continue with whatever the person was doing.
   *
   * Resolves `true` on success. A failed write resolves `false` rather than throwing, so a caller that was
   * about to replace the document does not replace it after a save that did not happen.
   */
  const saveNow = async (): Promise<boolean> => {
    const root = host.rootDoc()
    if (root === undefined) return false
    if (host.live()) return true // every edit already reached the server; the file follows within a second
    const blocked = host.readOnlyBy()
    if (blocked !== null) {
      host.setStatus(`not saved: ${host.fileName()} is locked by ${blocked}`)
      return false
    }
    // The name may have changed since the file was opened (Save-as), or this may be a new file: the lock follows
    // what is about to be written. Refused means someone else has a file by that name open.
    const owner = await host.claimFileLock()
    if (owner !== null) {
      host.setStatus(`not saved: ${host.fileName()} is locked by ${owner}`)
      return false
    }
    // Saving writes the *file*, not whatever prefab is open on top of it, and the id follows the name. Letting
    // them drift is how content/levels ended up with three files all claiming "level1".
    root.setId(host.fileName())
    try {
      await saveFile('levels', host.fileName(), stripHydrated(root.toJSON() as Level, host.hydratedPrefabs()))
    } catch (e: unknown) {
      host.setStatus(`save failed: ${String(e)}`)
      return false
    }
    dirty = false
    host.setStatus(`saved ${host.fileName()}`)
    await host.afterSave()
    host.refreshUi()
    return true
  }

  /**
   * May the open document be replaced? Asks first if it has edits that are not on disk.
   *
   * Every path that unloads a document goes through this: switching game, switching between levels and
   * prefabs, and opening another file. Nothing else may replace `docStack` — the undo history is cleared with
   * the document, so unsaved work is gone for good rather than one Ctrl+Z away.
   */
  const guardUnsaved = async (): Promise<boolean> => {
    if (!dirty) return true
    const choice = await askUnsaved(host.fileName())
    if (choice === 'cancel') return false
    if (choice === 'discard') return true
    return saveNow()
  }


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
    history.push(entry)
    dirty = !host.live() // a live level is saved as it is edited
    host.renderStatus()
  }

  /** Start a fresh history: a different file's edits are not this one's. */
  const resetHistory = (): void => {
    history.clear()
    pending = []
    dirty = false
  }


  /**
   * Apply a history entry's ops straight to the level — not through a document, so nothing is re-reported — then
   * redraw the way a remote batch is, and put the selection back by identity. Resolves `false` when the ops no
   * longer apply (the node is gone); the entry is dropped and the status bar says why.
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
      host.setStatus(`cannot ${what}: ${e instanceof OpError ? e.message : String(e)}`)
      return false
    }
    // An undo is an edit like any other to the room.
    if (host.live() && applied.ops.length > 0) host.submit(applied)
    pending = []
    dirty = !host.live()
    host.repaint(applied.ops)
    const open = host.doc()
    const restored = open === null ? [] : keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
    // What was selected when the edit was made; putting it back also redraws the panels.
    host.applySelection(restored)
    return true
  }

  const undo = (): void => {
    const entry = history.undo()
    if (entry === null) {
      host.setStatus('nothing to undo')
      return
    }
    if (!applyHistory(entry.inverses, entry.selection, `undo ${entry.label}`)) {
      history.drop(entry)
      return
    }
    host.setStatus(`undid: ${entry.label}`)
  }

  const redo = (): void => {
    const entry = history.redo()
    if (entry === null) {
      host.setStatus('nothing to redo')
      return
    }
    if (!applyHistory(entry.ops, entry.selection, `redo ${entry.label}`)) {
      history.drop(entry)
      return
    }
    host.setStatus(`redid: ${entry.label}`)
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
    host.setStatus(items.length > 1 ? `copied ${items.length} items` : `copied ${open.label(roots[0]!)}`)
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
      host.setStatus(open.mode === 'level' ? 'the clipboard holds prefab pieces, not instances' : 'the clipboard holds instances, not pieces')
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
    reset: resetHistory,
    undo,
    redo,
    saveNow,
    guardUnsaved,
    dirty: () => dirty,
    setDirty: (value) => void (dirty = value),
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
    dropWhere: (predicate) => history.dropWhere(predicate),
    depth: () => history.depth(),
  }
}
