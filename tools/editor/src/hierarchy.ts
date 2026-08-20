import type { Doc } from './editorDoc'
import { modeFor, type SelectMode } from './selection'

/**
 * The Hierarchy panel: the document as a tree of selectable, renameable, reorderable, re-parentable rows.
 *
 * A level's instances nest to any depth, so a row's children are the instances placed *relative to it* —
 * dragging one onto another changes what its transform is measured against, and at runtime motion composes
 * down the chain (a bar spinning on a moving deck).
 *
 * A row's **contents** are its prefab's pieces followed by its child instances, and one twist hides both
 * (ADR 0033). A piece is an object like any other here — it carries the visuals, the collider and the trigger,
 * so it is what the Inspector shows and what the gizmo moves. What it is *not* is independently placeable: it
 * belongs to the shared prefab, so it cannot be dragged, re-ordered or deleted through a placement, and
 * editing it changes every instance of that prefab.
 *
 * Everything starts **shut**, so opening a level shows its top-level objects rather than every piece at once.
 * Openness is keyed by `Doc.pathOf` rather than by row index, so editing one part of the tree does not shuffle
 * the state of another.
 *
 * Reordering is not cosmetic: checkpoint progression follows instance order, and so does the movement-base
 * index a rider replicates (ADR 0021).
 */
export interface Row {
  kind: 'item' | 'piece'
  /** Depth-first index of this node in the document. */
  index: number
  /** Index of a piece within its prefab; `-1` on item rows. */
  pieceIndex: number
  /** Nesting depth; piece rows sit one deeper than their owner. */
  depth: number
  /** Stable-ish key for UI state — see the note above. */
  path: string
  /** Depth-first index of the parent item, or `null` at the top level. */
  parent: number | null
  /** Position within its own sibling list — what a drop above/below this row inserts at. */
  siblingIndex: number
  label: string
  /** Right-aligned annotation: shared-instance count, or `inline` for a one-off. */
  badge: string
  /** References a prefab — Unity tints these, and it is the distinction that matters most here. */
  linked: boolean
  hasChildren: boolean
  /** Something can be opened under this row: pieces, child instances, or both. */
  expandable: boolean
  expanded: boolean
}

/**
 * One collapse state per row, covering everything under it (ADR 0033).
 *
 * There used to be two sets: `collapsed` for child instances and `piecesOpen` for the prefab's pieces, with the
 * twist writing to whichever the row happened to need. That made one control mean two things, and it had a bug
 * with no workaround: the moment an instance gained a child the twist wrote only to `collapsed`, so
 * `piecesOpen` could never be set again and the pieces became **unreachable**.
 */
export interface Openness {
  /**
   * Item paths whose contents — pieces and child instances alike — are shown. **Absent means collapsed**, so a
   * level opens as a list of top-level objects rather than as everything at once.
   */
  expanded: ReadonlySet<string>
}

/**
 * Rows for a document. Pure, so the parts worth getting right — which descendants a collapsed row hides,
 * what a drop above a row would insert at, how a piece row is addressed — are testable without a DOM.
 */
export const rowsOf = (doc: Doc, open: Openness): Row[] => {
  const rows: Row[] = []
  // Anything deeper than this is inside a collapsed subtree. A depth-first walk means we are back out of
  // it the moment a row appears at that depth or shallower.
  let hideBelow = Number.POSITIVE_INFINITY

  for (let i = 0; i < doc.count(); i++) {
    const depth = doc.depthOf(i)
    if (depth > hideBelow) continue
    hideBelow = Number.POSITIVE_INFINITY

    // Every row is a node the document addresses, pieces included (ADR 0033). This used to synthesize piece
    // rows from the owning instance's meshes, which is why they could be shown but never selected.
    const kind = doc.kindOf(i)
    const path = doc.pathOf(i)
    const ref = doc.refOf(i)
    const contents = doc.childCount(i)
    const shown = open.expanded.has(path)
    const shared = ref !== null ? doc.refCount(ref) : 0

    rows.push({
      kind: kind === 'piece' ? 'piece' : 'item',
      index: i,
      pieceIndex: kind === 'piece' ? doc.siblingIndexOf(i) : -1,
      depth,
      path,
      parent: doc.parentOf(i),
      siblingIndex: doc.siblingIndexOf(i),
      label: doc.label(i),
      badge: shared > 1 ? `×${shared}` : ref === null && kind !== 'piece' ? 'inline' : '',
      linked: ref !== null,
      hasChildren: contents > 0,
      expandable: contents > 0,
      expanded: contents > 0 && shown,
    })

    if (contents > 0 && !shown) hideBelow = depth
  }
  return rows
}

/** Which of the three bands of a row the pointer is in — Unity's above / onto / below. */
export type DropZone = 'above' | 'onto' | 'below'

/**
 * Band from a pointer's position within a row. The middle half is "make it a child"; the outer quarters
 * insert among the row's own siblings. Piece rows have no middle: nothing can be parented to a piece.
 */
export const zoneFor = (offsetY: number, height: number, allowOnto: boolean): DropZone => {
  const t = height > 0 ? offsetY / height : 0
  if (!allowOnto) return t < 0.5 ? 'above' : 'below'
  if (t < 0.25) return 'above'
  if (t > 0.75) return 'below'
  return 'onto'
}

/** The reparent arguments a drop in `zone` on `row` means: the new parent, and where among its children. */
export const dropTarget = (row: Row, zone: DropZone): { parent: number | null; at: number } => {
  if (zone === 'onto') return { parent: row.index, at: Number.MAX_SAFE_INTEGER } // appended; clamped by the doc
  return { parent: row.parent, at: zone === 'above' ? row.siblingIndex : row.siblingIndex + 1 }
}

export interface HierarchyHost {
  doc: () => Doc | null
  /**
   * Every selected index, primary last (ADR 0031). The panel needs the whole list to mark the rows, and the
   * primary to anchor a Shift-range from.
   */
  selection: () => readonly number[]
  /**
   * A row was clicked. `order` is the indices of the **visible item rows**, top to bottom — which is what a
   * Shift-range means to the eye. With a subtree collapsed those indices are not contiguous, and only this
   * panel knows which rows are on screen.
   */
  onSelect: (index: number, mode: SelectMode, order: readonly number[]) => void
  onRename: (index: number, name: string) => void
  /** Re-parent `from` under `parent` (`null` = top level) at sibling position `at`. */
  onReparent: (from: number, parent: number | null, at: number) => void
}

export interface Hierarchy {
  /** Rebuild from the document. Cheap — a level is tens of rows, so no virtualization. */
  render: () => void
}

export const createHierarchy = (container: HTMLElement, host: HierarchyHost): Hierarchy => {
  const expanded = new Set<string>()
  let dragFrom: number | null = null
  let editing: number | null = null

  const clearDropMarks = (): void => {
    for (const r of container.children) r.classList.remove('drop-above', 'drop-below', 'drop-onto')
  }

  const render = (): void => {
    const doc = host.doc()
    container.replaceChildren()
    if (doc === null || doc.count() === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = doc === null ? 'nothing open' : 'empty — place something from the Prefabs panel'
      container.append(empty)
      return
    }

    const selection = host.selection()
    const primary = selection[selection.length - 1] ?? null
    const rows = rowsOf(doc, { expanded })
    // Every visible row in draw order: what a Shift-range runs over. Pieces are selectable too, so they are
    // in it — a range that skipped them would jump over what the eye sees between two rows.
    const order = rows.map((r) => r.index)

    for (const row of rows) {
      const el = document.createElement('div')
      el.className = [
        'row',
        row.kind === 'piece' ? 'piece' : '',
        row.linked ? 'linked' : '',
        selection.includes(row.index) ? 'sel' : '',
        // The primary is marked apart, because it is the one the Inspector shows and the one a range anchors
        // on: "which of these five am I editing" has to be answerable at a glance.
        row.index === primary && selection.length > 1 ? 'primary' : '',
      ]
        .filter((c) => c !== '')
        .join(' ')
      // Indentation is the only thing that says "inside", so it comes from the data, not from a class.
      el.style.paddingLeft = `${6 + row.depth * 14}px`

      const twist = document.createElement('span')
      twist.className = 'twist'
      twist.textContent = row.expandable ? (row.expanded ? '▾' : '▸') : ''
      if (row.expandable) {
        twist.addEventListener('pointerdown', (e) => {
          e.stopPropagation() // opening is not selecting
          if (expanded.has(row.path)) expanded.delete(row.path)
          else expanded.add(row.path)
          render()
        })
      }
      el.append(twist)

      if (editing === row.index) {
        // Inline rename. Blank commits as "no name", which reverts the label to the fallback.
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'ctl rename'
        input.spellcheck = false
        input.value = doc.nameOf(row.index)
        input.placeholder = row.label
        let done = false
        const finish = (commit: boolean): void => {
          if (done) return // blur fires after Enter/Escape too
          done = true
          editing = null
          if (commit) host.onRename(row.index, input.value.trim())
          else render()
        }
        input.addEventListener('keydown', (e) => {
          e.stopPropagation() // Del/Ctrl+D are editor shortcuts; while typing they are text
          if (e.key === 'Enter') finish(true)
          else if (e.key === 'Escape') finish(false)
        })
        input.addEventListener('blur', () => finish(true))
        el.append(input)
        container.append(el)
        // Focus once the row is in the document, or the caret has nowhere to go.
        requestAnimationFrame(() => {
          input.focus()
          input.select()
        })
        continue
      }

      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = row.label
      el.append(name)

      if (row.badge !== '') {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = row.badge
        el.append(badge)
      }

      // Selecting and renaming work on every row, pieces included: a piece is an object now (ADR 0033), so it
      // is what the Inspector shows and what the gizmo moves.
      el.addEventListener('pointerdown', (e) => host.onSelect(row.index, modeFor(e), order))
      el.addEventListener('dblclick', () => {
        editing = row.index
        render()
      })

      // Dragging stays instance-only: where a piece sits is the prefab's decision, not this placement's, so a
      // drag would have to mean moving it in every instance of that prefab.
      if (row.kind === 'item') {
        el.draggable = true
        el.addEventListener('dragstart', (e) => {
          dragFrom = row.index
          el.classList.add('dragging')
          // Firefox will not start a drag without payload; the index itself travels in a closure variable
          // because dataTransfer is unreadable during dragover, which is when the target must be known.
          e.dataTransfer?.setData('text/plain', String(row.index))
          if (e.dataTransfer !== null) e.dataTransfer.effectAllowed = 'move'
        })
        el.addEventListener('dragend', () => {
          dragFrom = null
          el.classList.remove('dragging')
          clearDropMarks()
        })
      } else {
        el.title = 'piece of the shared prefab: editing it changes every instance of that prefab'
      }

      // Any row is a drop *neighbour* (insert above/below among its siblings); only an item row can be
      // dropped *onto*, since a piece cannot be a parent.
      const zoneOf = (e: DragEvent): DropZone => {
        const box = el.getBoundingClientRect()
        return zoneFor(e.clientY - box.top, box.height, row.kind === 'item')
      }
      el.addEventListener('dragover', (e) => {
        if (dragFrom === null) return
        const zone = zoneOf(e)
        clearDropMarks()
        if (!doc.canReparent(dragFrom, dropTarget(row, zone).parent)) {
          if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'none'
          return // no marker: an illegal drop should look impossible, not merely fail
        }
        e.preventDefault()
        if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move'
        el.classList.add(zone === 'onto' ? 'drop-onto' : zone === 'above' ? 'drop-above' : 'drop-below')
      })
      el.addEventListener('drop', (e) => {
        if (dragFrom === null) return
        e.preventDefault()
        const { parent, at } = dropTarget(row, zoneOf(e))
        const from = dragFrom
        dragFrom = null
        clearDropMarks()
        if (doc.canReparent(from, parent)) host.onReparent(from, parent, at)
      })

      container.append(el)
    }
  }

  return { render }
}
