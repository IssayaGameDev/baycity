/**
 * Multi-selection: which items are selected, and which one is the primary (ADR 0031).
 *
 * A list rather than a set, and the order matters: **the last entry is the primary** — the one clicked most
 * recently. That is what the Inspector shows, what the timeline edits, and where the gizmo sits, so a
 * multi-selection still has exactly one answer to "which one" wherever only one makes sense. It is also the
 * anchor a Shift-range extends from.
 *
 * Indices are depth-first positions in the document, which every insertion above them shifts — so a selection
 * is only valid until the next structural edit. Callers re-derive it, and `clampTo` is the safety net for the
 * case where a rebuild shrank the document under a stale list.
 */

/** How a click combines with what is already selected. */
export type SelectMode = 'replace' | 'toggle' | 'range'

/** The mode a pointer or key event asks for. Ctrl/Cmd toggles one; Shift extends a range. */
export const modeFor = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelectMode =>
  e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace'

/** The primary — the last clicked — or `null` when nothing is selected. */
export const primaryOf = (selection: readonly number[]): number | null => selection[selection.length - 1] ?? null

/**
 * Add `index` if absent, remove it if present. Adding moves it to the end, which makes it the primary: a
 * Ctrl-click is still a click, and the thing just clicked is what the Inspector should show.
 */
export const toggleIn = (selection: readonly number[], index: number): number[] => {
  const without = selection.filter((i) => i !== index)
  return without.length === selection.length ? [...without, index] : without
}

/**
 * The contiguous run between the primary and `index`, in the order rows are **displayed**.
 *
 * Display order, not index order, because a range in the Hierarchy is what the eye sees between two rows —
 * and with collapsed subtrees the visible rows are a subset whose depth-first indices are not contiguous.
 * Passing the visible order in keeps that knowledge in the panel and this function pure.
 *
 * The far end becomes the primary, so a second Shift-click re-ranges from the same anchor the way every list
 * behaves. With no existing selection there is no anchor, so it degenerates to selecting the one row.
 */
export const rangeIn = (selection: readonly number[], order: readonly number[], index: number): number[] => {
  const primary = primaryOf(selection)
  if (primary === null) return [index]
  const from = order.indexOf(primary)
  const to = order.indexOf(index)
  // A row that is not on screen cannot bound a visible range; fall back to selecting just the target.
  if (from < 0 || to < 0) return [index]
  const run = from <= to ? order.slice(from, to + 1) : order.slice(to, from + 1).reverse()
  return [...run]
}

/** Apply a click. `order` is only needed for `range`. */
export const applySelect = (selection: readonly number[], index: number, mode: SelectMode, order: readonly number[] = []): number[] => {
  if (mode === 'toggle') return toggleIn(selection, index)
  if (mode === 'range') return rangeIn(selection, order, index)
  return [index]
}

/** Drop anything outside `0..count-1`, for a list held across a rebuild that shrank the document. */
export const clampTo = (selection: readonly number[], count: number): number[] => selection.filter((i) => i >= 0 && i < count)

/**
 * Selected indices with any that sit **inside another selected item's subtree** removed.
 *
 * What a structural operation wants. Deleting a parent takes its children with it, so a selection of both
 * would try to delete the child twice — and duplicating both would produce the child twice, once inside the
 * copied parent. `depthOf` is enough to find them: in a depth-first walk, a node is inside the previous
 * shallower node's subtree.
 */
export const rootsOf = (selection: readonly number[], depthOf: (i: number) => number): number[] => {
  const sorted = [...selection].sort((a, b) => a - b)
  const roots: number[] = []
  let skipBelow = Number.POSITIVE_INFINITY
  for (const i of sorted) {
    if (depthOf(i) > skipBelow) continue // inside a root already taken
    roots.push(i)
    skipBelow = depthOf(i)
  }
  return roots
}
