import type { Doc } from './editorDoc'

/**
 * The Hierarchy panel: the document as a tree of selectable, renameable, reorderable, re-parentable rows.
 *
 * A level's instances nest to any depth, so a row's children are the instances placed *relative to it* —
 * dragging one onto another changes what its transform is measured against, and at runtime motion composes
 * down the chain (a bar spinning on a moving deck). A row can also be opened to show the **pieces** of the
 * prefab it references; those are a way *in* (double-click opens the shared definition with that piece
 * selected) rather than editable here, because a piece belongs to the prefab, not to this placement.
 *
 * Two kinds of openness, with opposite defaults, matching what each is for: child instances show by
 * default (the tree is the point), prefab pieces stay shut (they are detail). Both are keyed by
 * `Doc.pathOf` rather than by row index, so editing one part of the tree does not shuffle the collapse
 * state of another.
 *
 * Reordering is not cosmetic: checkpoint progression follows instance order, and so does the movement-base
 * index a rider replicates (ADR 0021).
 */
export interface Row {
  kind: 'item' | 'piece'
  /** Depth-first index of the item (or, for a piece row, of its owning item). */
  index: number
  /** Index of the piece within the item's prefab; `-1` on item rows. */
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
  /** Something can be opened under this row (children, or the prefab's pieces). */
  expandable: boolean
  expanded: boolean
}

export interface Openness {
  /** Item paths whose child instances are hidden. Absent = shown. */
  collapsed: ReadonlySet<string>
  /** Item paths whose prefab pieces are shown. Absent = hidden. */
  piecesOpen: ReadonlySet<string>
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

    const path = doc.pathOf(i)
    const ref = doc.refOf(i)
    const specs = doc.meshSpecs(i)
    const hasChildren = doc.childCount(i) > 0
    const canOpenPieces = doc.mode === 'level' && specs.length > 0
    const childrenShown = hasChildren && !open.collapsed.has(path)
    const piecesShown = canOpenPieces && open.piecesOpen.has(path)
    const shared = ref !== null ? doc.refCount(ref) : 0

    rows.push({
      kind: 'item',
      index: i,
      pieceIndex: -1,
      depth,
      path,
      parent: doc.parentOf(i),
      siblingIndex: doc.siblingIndexOf(i),
      label: doc.label(i),
      badge: shared > 1 ? `×${shared}` : ref === null ? 'inline' : '',
      linked: ref !== null,
      hasChildren,
      expandable: hasChildren || canOpenPieces,
      // "Open" means the twist is down: children showing, or pieces showing when there are no children.
      expanded: hasChildren ? childrenShown : piecesShown,
    })

    if (hasChildren && !childrenShown) hideBelow = depth

    if (!piecesShown) continue
    for (let p = 0; p < specs.length; p++) {
      const spec = specs[p]!
      rows.push({
        kind: 'piece',
        index: i,
        pieceIndex: p,
        depth: depth + 1,
        path: `${path}#${p}`,
        parent: i,
        siblingIndex: p,
        label: spec.name ?? spec.collider.kind,
        badge: '',
        linked: false,
        hasChildren: false,
        expandable: false,
        expanded: false,
      })
    }
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
  selected: () => number | null
  onSelect: (index: number) => void
  /** A piece row was activated: open the prefab behind `index` and select piece `pieceIndex`. */
  onOpenPiece: (index: number, pieceIndex: number) => void
  onRename: (index: number, name: string) => void
  /** Re-parent `from` under `parent` (`null` = top level) at sibling position `at`. */
  onReparent: (from: number, parent: number | null, at: number) => void
}

export interface Hierarchy {
  /** Rebuild from the document. Cheap — a level is tens of rows, so no virtualization. */
  render: () => void
}

export const createHierarchy = (container: HTMLElement, host: HierarchyHost): Hierarchy => {
  const collapsed = new Set<string>()
  const piecesOpen = new Set<string>()
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

    const selected = host.selected()
    for (const row of rowsOf(doc, { collapsed, piecesOpen })) {
      const el = document.createElement('div')
      el.className = [
        'row',
        row.kind === 'piece' ? 'piece' : '',
        row.linked ? 'linked' : '',
        row.kind === 'item' && row.index === selected ? 'sel' : '',
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
          // Children take the twist when there are any; pieces get it only when there are none.
          const set = row.hasChildren ? collapsed : piecesOpen
          if (set.has(row.path)) set.delete(row.path)
          else set.add(row.path)
          render()
        })
      }
      el.append(twist)

      if (row.kind === 'item' && editing === row.index) {
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

      if (row.kind === 'item') {
        el.addEventListener('pointerdown', () => host.onSelect(row.index))
        el.addEventListener('dblclick', () => {
          editing = row.index
          render()
        })
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
        el.addEventListener('dblclick', () => host.onOpenPiece(row.index, row.pieceIndex))
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
