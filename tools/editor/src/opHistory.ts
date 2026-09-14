import type { NodeRef, Op } from '@mp/content'

/**
 * Undo/redo by inverse operations (ADR 0089; replaces the snapshot history of ADR 0030).
 *
 * An entry is one edit as the document reported it: the ops that did it and the ops that undo it. Undo hands
 * the entry back for the caller to apply its inverses; redo hands it back to apply its ops again. Nothing here
 * touches a level — this is a stack with labels — which is what keeps it usable when the level is shared:
 * applying an inverse is an ordinary edit from everyone else's point of view, and another person's edits never
 * enter this stack at all.
 *
 * Snapshots went because they cannot be per person: putting back "the whole document as it was" would put back
 * a colleague's work along with mine.
 */
export interface HistoryEntry {
  /** What the edit did, in order. */
  ops: Op[]
  /** What undoes it, in undo order (the last op's inverse first). */
  inverses: Op[]
  label: string
  /** What was selected when the edit was made, by identity that survives renumbering. */
  selection: NodeRef[]
}

export interface OpHistory {
  push: (entry: HistoryEntry) => void
  /** The entry to undo — apply its `inverses` — or `null`. Moves it to the redo side. */
  undo: () => HistoryEntry | null
  /** The entry to redo — apply its `ops` — or `null`. Moves it back to the undo side. */
  redo: () => HistoryEntry | null
  canUndo: () => boolean
  canRedo: () => boolean
  undoLabel: () => string | null
  redoLabel: () => string | null
  /** Forget one entry wherever it sits — its ops no longer apply (the node is gone). */
  drop: (entry: HistoryEntry) => void
  /** Forget everything: a different file's edits are not this one's. */
  clear: () => void
  depth: () => { undo: number; redo: number }
}

const DEFAULT_LIMIT = 100

export const createOpHistory = (limit = DEFAULT_LIMIT): OpHistory => {
  const past: HistoryEntry[] = []
  const future: HistoryEntry[] = []
  return {
    push: (entry) => {
      past.push(entry)
      if (past.length > Math.max(1, limit)) past.shift()
      future.length = 0
    },
    undo: () => {
      const entry = past.pop()
      if (entry === undefined) return null
      future.push(entry)
      return entry
    },
    redo: () => {
      const entry = future.pop()
      if (entry === undefined) return null
      past.push(entry)
      return entry
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undoLabel: () => past[past.length - 1]?.label ?? null,
    redoLabel: () => future[future.length - 1]?.label ?? null,
    drop: (entry) => {
      for (const stack of [past, future]) {
        const at = stack.indexOf(entry)
        if (at >= 0) stack.splice(at, 1)
      }
    },
    clear: () => {
      past.length = 0
      future.length = 0
    },
    depth: () => ({ undo: past.length, redo: future.length }),
  }
}

/**
 * Fold the batches one edit produced into one entry. A gizmo drag is a hundred `setTransform`s on one node:
 * only the last value and the first inverse matter, so consecutive transform ops on one target collapse to
 * one. Everything else keeps its order.
 */
export const foldBatches = (batches: readonly { ops: Op[]; inverses: Op[] }[], label: string, selection: NodeRef[]): HistoryEntry | null => {
  const ops: Op[] = []
  for (const b of batches) ops.push(...b.ops)
  // Inverses of the earliest batch undo last.
  const inverses: Op[] = []
  for (let i = batches.length - 1; i >= 0; i--) inverses.push(...batches[i]!.inverses)
  if (ops.length === 0) return null
  // Forward: the last value written wins. Inverses are already in undo order, so their last entry per target
  // is the state before the first write — also the one to keep.
  return { ops: squashTransforms(ops), inverses: squashTransforms(inverses), label, selection }
}

const transformTarget = (op: Op): string | null => {
  if (op.kind === 'setTransform') return `t:${op.table ?? ''}:${op.id}`
  if (op.kind === 'setOverrideTransform') return `o:${op.owner}:${op.node}`
  return null
}

/** Keep one transform op per target — the last seen — in the position of the first. */
const squashTransforms = (ops: readonly Op[]): Op[] => {
  const out: Op[] = []
  const seen = new Map<string, number>()
  for (const op of ops) {
    const key = transformTarget(op)
    if (key === null) {
      out.push(op)
      continue
    }
    const at = seen.get(key)
    if (at === undefined) {
      seen.set(key, out.length)
      out.push(op)
    } else out[at] = op
  }
  return out
}
