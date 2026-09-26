import { refKey, type NodeRef } from '@mp/content'

/**
 * What the editor is not drawing (ADR 0132) — Unity's eye column.
 *
 * **A view of the level, never a change to it.** It does not reach the game, it is not in the level file,
 * and it takes no sequence number: the server keeps it in its state folder and relays the whole set to everyone
 * in the room. That is what makes it different from the `active` checkbox (ADR 0099), which switches a node
 * off *in the level* and is content.
 *
 * Nodes are named by `refKey`, the same string holds use, so a prefab's piece is keyed by the placement it
 * is under and hiding one wall does not hide it in every tower.
 */

/** The little of a document this needs: enough to walk a subtree and name what is in it. */
export interface HiddenDoc {
  count: () => number
  depthOf: (i: number) => number
  refAt: (i: number) => NodeRef | null
}

/**
 * The keys one toggle covers: the node, and everything under it unless `onlyThis`.
 *
 * **Every descendant is named, rather than hiding them by implication.** A set membership test is then the
 * whole of `hiddenAt`, with no ancestor walk on the render path — and, more to the point, "hide this one
 * only" (alt-click) and "hide this branch" stay two different sets rather than one set plus an exception.
 * The cost is that a child added later is not hidden by its parent's earlier toggle, which is visible and
 * fixable by the person who can see it.
 */
export const keysUnder = (doc: HiddenDoc, index: number, onlyThis = false): string[] => {
  const own = doc.refAt(index)
  if (own === null) return []
  const out = [refKey(own)]
  if (onlyThis) return out
  const depth = doc.depthOf(index)
  for (let i = index + 1; i < doc.count() && doc.depthOf(i) > depth; i++) {
    const ref = doc.refAt(i)
    if (ref !== null) out.push(refKey(ref))
  }
  return out
}

export interface HiddenView {
  /** Every hidden key, as the server last said. */
  keys: () => ReadonlySet<string>
  /** Replace the set outright. Never a delta, so a dropped event cannot leave two editors disagreeing. */
  set: (keys: readonly string[]) => void
  /** Is this node being left out of the viewport right now? `false` for all of them while showing all. */
  hiddenAt: (doc: HiddenDoc, index: number) => boolean
  /** Is anything hidden at all — what decides whether the viewport's Reveal is worth offering. */
  any: () => boolean
  /**
   * Reveal everything without forgetting it (ADR 0132).
   *
   * Local and momentary: it is a way to look, not a change, so it is not sent to anyone and not remembered
   * across a reload. It is also the way out of somebody else's hiding, which is reachable now that the set
   * is shared.
   */
  showingAll: () => boolean
  setShowingAll: (on: boolean) => void
}

export const createHiddenView = (): HiddenView => {
  let keys = new Set<string>()
  let showAll = false
  return {
    keys: () => keys,
    set: (next) => {
      keys = new Set(next)
    },
    hiddenAt: (doc, index) => {
      if (showAll || keys.size === 0) return false
      const ref = doc.refAt(index)
      return ref !== null && keys.has(refKey(ref))
    },
    any: () => keys.size > 0,
    showingAll: () => showAll,
    setShowingAll: (on) => {
      showAll = on
    },
  }
}
