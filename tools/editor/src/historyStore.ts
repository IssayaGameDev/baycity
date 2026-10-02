import { mergeAssetOps, applyBatch, OpError, type AssetOp, type Level, type NodeRef, type Op } from '@mp/content'

import type { ClipItem, Doc, OpBatch } from './editorDoc'
import { createOpHistory, foldBatches, type HistoryEntry } from './opHistory'
import type { Notify } from './notices'
import { assetSteps, levelSteps, planRedo, planUndo, squashTransforms, type AssetStep, type LevelStep, type UndoStep } from './undoSteps'

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
 *
 * **An undo leaves what someone changed since** (ADR 0194, Kodjo's call): every entry keeps its steps, and an undo or
 * a redo takes back each only while what it wrote is still there (`undoSteps.ts`) — a level edit, an asset edit and
 * an agent's turn alike.
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

/**
 * One prompt to an agent, while it works (ADR 0194): its edits gather here, and become one history entry when it
 * ends — one Ctrl+Z for the whole prompt, the level's edits and the assets' together.
 */
export interface Turn {
  readonly label: string
  readonly steps: UndoStep[]
  /** Which file's history it belongs to: a turn still open when another file is opened is not this one's. */
  readonly generation: number
}

/** A finished turn in the history. */
interface TurnEntry {
  kind: 'turn'
  label: string
  steps: UndoStep[]
}

/** A level edit: its ops and inverses, as the room was sent them, and its steps — what an undo works from. */
type LevelEntry = { kind: 'level' } & HistoryEntry & { steps: LevelStep[] }
/** An asset edit, its steps kept up with its ops while a gesture merges into it. */
type AssetEntry = { kind: 'asset' } & AssetEdit & { steps: AssetStep[] }

type Entry = LevelEntry | AssetEntry | TurnEntry

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
   * show that asset, as a level undo shows what was selected — unless `show` is false: a turn's undo, which leaves
   * the selection alone. `false` when they no longer apply (it is gone).
   */
  applyAsset: (assetId: string, ops: readonly AssetOp[], what: string, show?: boolean) => boolean
  /** A data-file asset as this tab shows it now — what a turn's undo checks its values against. */
  assetNow: (assetId: string) => unknown
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
  recordAsset: (edit: AssetEdit, ongoing: boolean, turn?: Turn | null) => void
  /**
   * Run `edit` with this tab's document changes held here (ADR 0194): applied, but neither sent nor recorded, and
   * gathered in `into` — even when `edit` throws — for the caller to `commitHeld` or `discardHeld`.
   */
  holding: <T>(into: OpBatch[], edit: () => T) => T
  /** Send held batches to the room as one, and record them: an entry of their own, or steps of `turn`. */
  commitHeld: (batches: readonly OpBatch[], label: string, turn: Turn | null) => void
  /** Take held batches back off the level, never sent. The ops that did it, for a repaint. */
  discardHeldBatches: (batches: readonly OpBatch[]) => Op[]
  /** A turn begins: nothing is recorded until it ends. */
  startTurn: (label: string) => Turn
  /** A turn ends: its edits, if it made any, become one entry. */
  endTurn: (turn: Turn) => void
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
  /** Where batches go while an action's edit is held (`holding`): not to the room, not to the history. */
  let holdingInto: OpBatch[] | null = null
  /** Bumped by every reset: a turn begun before it belongs to another file. */
  let generation = 0
  const onDocOps = (batch: OpBatch): void => {
    if (holdingInto !== null) {
      holdingInto.push(batch)
      return
    }
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
    // A held edit is recorded by whoever holds it; a shared function's own record inside one is not a second entry.
    if (coalescing || holdingInto !== null) return
    pushLevel(pending, label)
    pending = []
  }

  /** A level entry of these batches: folded for the room's record, its steps squashed for undo. */
  const pushLevel = (batches: readonly OpBatch[], label: string): void => {
    const entry = foldBatches([...batches], label, host.selectionRefs())
    if (entry === null) return
    open = null
    history.push({ kind: 'level', ...entry, steps: squashTransforms(levelSteps(batches)) })
    host.renderStatus()
  }

  /** The asset entry a gesture is still adding to, while it is the last thing done. */
  let open: AssetEntry | null = null

  const recordAsset = (edit: AssetEdit, ongoing: boolean, turn: Turn | null = null): void => {
    if (turn !== null) {
      if (turn.generation === generation) turn.steps.push(...assetSteps(edit.assetId, edit.ops, edit.inverses))
      return
    }
    const top = history.last()
    if (edit.ops.length > 0) {
      if (open !== null && open === top && open.assetId === edit.assetId && open.label === edit.label) {
        // One more step of the same gesture: the newest value per path, and the value before the first.
        open.ops = mergeAssetOps(open.ops, edit.ops)
        open.inverses = mergeAssetOps(edit.inverses, open.inverses)
        open.steps = assetSteps(open.assetId, open.ops, open.inverses)
      } else {
        open = { kind: 'asset', ...edit, steps: assetSteps(edit.assetId, edit.ops, edit.inverses) }
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
    generation++
  }

  const holding = <T,>(into: OpBatch[], edit: () => T): T => {
    if (holdingInto !== null) throw new Error('an edit is already being held')
    holdingInto = into
    try {
      return edit()
    } finally {
      holdingInto = null
    }
  }

  const commitHeld = (batches: readonly OpBatch[], label: string, turn: Turn | null): void => {
    const ops = batches.flatMap((b) => b.ops)
    if (ops.length === 0) return
    // One message to the room for the whole action, applied there all or nothing.
    if (host.live()) host.submit({ ops, inverses: [...batches].reverse().flatMap((b) => b.inverses) })
    if (turn !== null) {
      if (turn.generation === generation) turn.steps.push(...levelSteps(batches))
      return
    }
    pushLevel(batches, label)
  }

  const discardHeldBatches = (batches: readonly OpBatch[]): Op[] => {
    const level = host.rootLevel()
    const inverses = [...batches].reverse().flatMap((b) => b.inverses)
    if (level === null || inverses.length === 0) return []
    return applyBatch(level, inverses).ops
  }

  /** Turns begun and not ended: a batch the server refuses mid-turn is taken out of one of these. */
  const openTurns = new Set<Turn>()
  const startTurn = (label: string): Turn => {
    const turn: Turn = { label, steps: [], generation }
    openTurns.add(turn)
    return turn
  }
  const endTurn = (turn: Turn): void => {
    openTurns.delete(turn)
    if (turn.generation !== generation || turn.steps.length === 0) return
    open = null
    history.push({ kind: 'turn', label: turn.label, steps: turn.steps })
    host.renderStatus()
  }


  /**
   * Undo or redo an entry around what others changed since (`undoSteps.ts`, ADR 0194): worked out on copies, then
   * applied straight to the level — not through a document, so nothing is re-reported — and sent as this tab's edit,
   * as any undo is. What someone changed since is left theirs, and counted. `null` when nothing of it could be taken
   * back or put again: the entry is dropped and a warning says why.
   *
   * The redraw is `host.repaint`, not a rebuild of everything: undoing a move puts the groups back where the data
   * says, as a teammate's move does. A level edit puts back what was selected when it was made; a turn leaves the
   * selection alone (the agent never chose it), and only an asset edit shows its asset.
   */
  const applyEntry = (entry: Entry, way: 'undo' | 'redo', what: string): number | null => {
    open = null
    const level = host.rootLevel() ?? { id: '', config: {}, nodes: [] }
    const plan = (way === 'undo' ? planUndo : planRedo)(entry.steps, level, host.assetNow)
    if (plan.level.length === 0 && plan.assets.size === 0) {
      host.notify.warn(plan.kept > 0 ? `cannot ${what}: everything it changed has been changed since by someone else` : `cannot ${what}: it is gone`)
      return null
    }
    if (plan.level.length > 0) {
      let applied: { ops: Op[]; inverses: Op[] }
      try {
        applied = applyBatch(level, plan.level)
      } catch (e) {
        host.notify.warn(`cannot ${what}: ${e instanceof OpError ? e.message : String(e)}`)
        return null
      }
      if (host.live() && applied.ops.length > 0) host.submit(applied)
      pending = []
      host.repaint(applied.ops)
    }
    for (const [assetId, ops] of plan.assets) host.applyAsset(assetId, ops, what, entry.kind === 'asset')
    plan.done()
    if (entry.kind === 'level') {
      const doc = host.doc()
      // What was selected when the edit was made; putting it back also redraws the panels.
      host.applySelection(doc === null ? [] : entry.selection.map((r: NodeRef) => doc.indexOfRef(r)).filter((i): i is number => i !== null))
    }
    return plan.kept
  }

  /** What was left alone, said with the undo: changes someone made since. */
  const keptNote = (kept: number): string => (kept === 0 ? '' : ` — kept ${kept} change${kept === 1 ? '' : 's'} made since by someone else`)

  const undo = (): void => {
    const entry = history.undo()
    if (entry === null) {
      host.notify.warn('nothing to undo')
      return
    }
    const kept = applyEntry(entry, 'undo', `undo ${entry.label}`)
    if (kept === null) {
      history.drop(entry)
      return
    }
    host.notify.ok(`undid: ${entry.label}${keptNote(kept)}`)
  }

  const redo = (): void => {
    const entry = history.redo()
    if (entry === null) {
      host.notify.warn('nothing to redo')
      return
    }
    const kept = applyEntry(entry, 'redo', `redo ${entry.label}`)
    if (kept === null) {
      history.drop(entry)
      return
    }
    host.notify.ok(`redid: ${entry.label}${keptNote(kept)}`)
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
    holding,
    commitHeld,
    discardHeldBatches,
    startTurn,
    endTurn,
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
    dropWhere: (predicate) => {
      // A refused batch takes only its own steps out of a turn, open or finished; a turn goes once nothing is left of it.
      const prune = (steps: UndoStep[]): void => {
        for (let i = steps.length - 1; i >= 0; i--) {
          const s = steps[i]!
          if (s.kind === 'level' && predicate({ ops: [s.op], inverses: [s.inverse] })) steps.splice(i, 1)
        }
      }
      for (const t of openTurns) prune(t.steps)
      history.dropWhere((e) => {
        if (e.kind === 'level') return predicate(e)
        if (e.kind !== 'turn') return false
        prune(e.steps)
        return e.steps.length === 0
      })
    },
    depth: () => history.depth(),
    labels: () => ({ undo: history.undoLabel(), redo: history.redoLabel() }),
  }
}
