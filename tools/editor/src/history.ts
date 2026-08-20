/**
 * Undo/redo by snapshot (ADR 0030).
 *
 * Snapshots, not commands. The editor mutates the `Level`/`Prefab` object in place through the doc, and
 * everything visible — meshes, physics, gizmos, panels — is already rebuilt from that object after every
 * edit. So "undo" is "put the old object back and rebuild", which is a mechanism that already exists and
 * cannot drift out of step with the edits. A command log would need an inverse per operation, and the day one
 * of them is wrong the undo silently corrupts the document.
 *
 * The trade is memory and the size of a clone. A level is a few hundred lines of JSON, so at a hundred steps
 * that is well under a megabyte, and a clone costs less than the mesh rebuild that follows it.
 *
 * Generic over the snapshot type and over how to clone it, so this file is testable with plain data and so
 * ownership is explicit: **every value that goes in or comes out is cloned**, and no caller can be holding a
 * live reference into the stack.
 */

export interface HistoryOptions<T> {
  clone: (value: T) => T
  /** How many undo steps to keep. The oldest is dropped past this. */
  limit?: number
}

/** A restored state plus what the edit that produced it was called. */
export interface Restored<T> {
  data: T
  /** The label recorded with the edit, for the status bar: "undid: move". */
  label: string
}

export interface History<T> {
  /**
   * Record the state **before** an edit, with a name for the edit about to happen. Called at the start of
   * every mutation, which is the one rule this design has: snapshot first, then mutate.
   *
   * Clears the redo branch, since redoing past a new edit has no meaning.
   */
  push: (before: T, label: string) => void
  /**
   * Step back. `current` is the live state, which becomes the redo entry. `null` when there is nothing to
   * undo, so the caller can leave the document alone rather than clobber it with a blank.
   */
  undo: (current: T) => Restored<T> | null
  redo: (current: T) => Restored<T> | null
  canUndo: () => boolean
  canRedo: () => boolean
  /** The label of the edit `undo` would reverse, for a menu item that says what it will do. */
  undoLabel: () => string | null
  redoLabel: () => string | null
  /** Forget everything. Called when a different file is opened: its history is not this one's. */
  clear: () => void
  depth: () => { undo: number; redo: number }
}

const DEFAULT_LIMIT = 100

export const createHistory = <T>(opts: HistoryOptions<T>): History<T> => {
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
  /** Entries hold the state *before* their edit, so popping one is stepping back over that edit. */
  const undoStack: Restored<T>[] = []
  const redoStack: Restored<T>[] = []

  return {
    push: (before, label) => {
      undoStack.push({ data: opts.clone(before), label })
      if (undoStack.length > limit) undoStack.shift()
      redoStack.length = 0
    },
    undo: (current) => {
      const entry = undoStack.pop()
      if (entry === undefined) return null
      // The redo entry keeps the *same* label: it names the edit being stepped over, in both directions.
      redoStack.push({ data: opts.clone(current), label: entry.label })
      return entry
    },
    redo: (current) => {
      const entry = redoStack.pop()
      if (entry === undefined) return null
      undoStack.push({ data: opts.clone(current), label: entry.label })
      return entry
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoLabel: () => undoStack[undoStack.length - 1]?.label ?? null,
    redoLabel: () => redoStack[redoStack.length - 1]?.label ?? null,
    clear: () => {
      undoStack.length = 0
      redoStack.length = 0
    },
    depth: () => ({ undo: undoStack.length, redo: redoStack.length }),
  }
}
