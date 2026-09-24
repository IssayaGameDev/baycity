import type { Doc } from './editorDoc'
import { modeFor, type SelectMode } from './selection'

/**
 * The Hierarchy panel: the document as a tree of selectable, renameable, reorderable, re-parentable rows.
 *
 * Nodes nest to any depth, so a row's children are what is placed *relative to it* — dragging one onto
 * another changes what its transform is measured against, and at runtime motion composes down the chain (a
 * bar spinning on a moving deck).
 *
 * A row's **contents** are what it inherits from its prefab followed by its own children, and one twist hides
 * both (ADR 0033, ADR 0035). An inherited row is an object like any other here — it carries the components, so
 * it is what the Inspector shows and what the gizmo moves. What it is *not* is independently placeable: its
 * position belongs to the shared prefab, so it cannot be dragged, re-ordered or deleted through a placement,
 * and what you change about it becomes an override on that placement.
 *
 * Everything starts **shut**, so opening a level shows its top-level objects rather than every node at once.
 * Openness is keyed by `Doc.pathOf` rather than by row index, so editing one part of the tree does not shuffle
 * the state of another.
 *
 * Reordering is not cosmetic: checkpoint progression follows node order, and so does the movement-base index
 * a rider replicates (ADR 0021).
 */
export interface Row {
  kind: 'item' | 'inherited'
  /** Depth-first index of this node in the document. */
  index: number
  /** Sibling index within the prefab it is inherited from; `-1` on own rows. */
  pieceIndex: number
  /** Nesting depth; an inherited row sits one deeper than the placement that owns it. */
  depth: number
  /** Stable-ish key for UI state — see the note above. */
  path: string
  /** Depth-first index of the parent, or `null` at the top level. */
  parent: number | null
  /** Position within its own sibling list — what a drop above/below this row inserts at. */
  siblingIndex: number
  label: string
  /** Right-aligned annotation: shared-instance count, or `inline` for a one-off. */
  badge: string
  /** Who else has this node selected (ADR 0089) — the row is not selectable, renamable or draggable. `''` when free. */
  held: string
  /** References a prefab — Unity tints these, and it is the distinction that matters most here. */
  linked: boolean
  /**
   * Switched off (ADR 0099): absent from the level and drawn nowhere. The row **dims**; the checkbox that
   * changes it lives in the Inspector's header, where Unity puts it (ADR 0102).
   */
  disabled: boolean
  /** An **ancestor** is switched off, so this is absent whatever its own flag says — the row dims the same. */
  disabledAbove: boolean
  /**
   * Not drawn in the viewport (ADR 0132) — Unity's eye. **Not the same as `disabled`**, and deliberately
   * shown differently: `disabled` means gone from the level and from the game, this means "I am not looking
   * at it right now". A row that dimmed for both would say neither.
   */
  hidden: boolean
  hasChildren: boolean
  /** Something can be opened under this row: inherited nodes, own children, or both. */
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
/** Width of the fixed gutter the eyes live in, left of everything and outside the indentation. */
const EYE_GUTTER = 18

export const rowsOf = (
  doc: Doc,
  open: Openness,
  heldBy: (index: number) => string | null = () => null,
  isHidden: (index: number) => boolean = () => false,
): Row[] => {
  const rows: Row[] = []
  // Anything deeper than this is inside a collapsed subtree. A depth-first walk means we are back out of
  // it the moment a row appears at that depth or shallower.
  let hideBelow = Number.POSITIVE_INFINITY

  for (let i = 0; i < doc.count(); i++) {
    const depth = doc.depthOf(i)
    if (depth > hideBelow) continue
    hideBelow = Number.POSITIVE_INFINITY

    // Every row is a node the document addresses, inherited ones included. This used to synthesize piece rows
    // from the owning instance's meshes, which is why they could be shown but never selected.
    const kind = doc.kindOf(i)
    const path = doc.pathOf(i)
    const ref = doc.refOf(i)
    const contents = doc.childCount(i)
    const shown = open.expanded.has(path)
    const shared = ref !== null ? doc.refCount(ref) : 0

    rows.push({
      kind: kind === 'inherited' ? 'inherited' : 'item',
      index: i,
      pieceIndex: kind === 'inherited' ? doc.siblingIndexOf(i) : -1,
      depth,
      path,
      parent: doc.parentOf(i),
      siblingIndex: doc.siblingIndexOf(i),
      label: doc.label(i),
      badge: shared > 1 ? `×${shared}` : ref === null && kind !== 'inherited' ? 'inline' : '',
      held: heldBy(i) ?? '',
      linked: ref !== null,
      disabled: !doc.nodeEnabled(i),
      disabledAbove: doc.disabledByAncestor(i),
      hidden: isHidden(i),
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

/**
 * The paths of every ancestor of `index`, nearest first — what has to be open for its row to be on screen.
 *
 * Walks `Doc.parentOf` rather than picking the path string apart. A path is a sibling trail with two
 * separators (`0/2#1`: the second child of the third node, then the node it inherits), and reconstructing an
 * ancestor's path by trimming one is a second implementation of something the document already answers.
 */
export const ancestorPaths = (doc: Doc, index: number): string[] => {
  const out: string[] = []
  for (let at = doc.parentOf(index); at !== null; at = doc.parentOf(at)) out.push(doc.pathOf(at))
  return out
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
  /** Is this node hidden in the viewport (ADR 0132)? What the eye in the left gutter draws. */
  isHidden: (index: number) => boolean
  /**
   * The eye was clicked. `onlyThis` is an alt-click: the node alone, leaving its children where they are;
   * plain, it is the node and everything under it.
   */
  onToggleHidden: (index: number, onlyThis: boolean) => void
  /** Whether the Game row is the current selection (ADR 0052). */
  gameSelected: () => boolean
  /** What the Game row reads: the game's label, or that the level has none. */
  gameLabel: () => string
  /** The Game row was clicked. */
  onSelectGame: () => void
  /** Whether the Environment row is the current selection (ADR 0048). */
  envSelected: () => boolean
  /** The Environment row was clicked. */
  onSelectEnv: () => void
  onRename: (index: number, name: string) => void
  /** Re-parent `from` under `parent` (`null` = top level) at sibling position `at`. */
  /**
   * A drop happened. `from` is **every** row the drag carried, top to bottom (ADR 0134): the whole selection
   * when the grabbed row was part of it, else just that row.
   */
  onReparent: (from: readonly number[], parent: number | null, at: number) => void
  /** Who else holds this node, or `null` (ADR 0089). Absent when nothing is ever held (prefabs). */
  heldBy?: (index: number) => string | null
}

export interface Hierarchy {
  /** Rebuild from the document. Cheap — a level is tens of rows, so no virtualization. */
  render: () => void
  /**
   * Open whatever is hiding this row, and scroll it into view.
   *
   * Selecting in the viewport marks the row here, which is no use at all when the row is inside a collapsed
   * parent: the panel highlighted something nobody could see. Unity reveals the selection, and so does this.
   *
   * Only ever *opens*. Collapsing on the way past would throw away a shape somebody arranged on purpose.
   */
  reveal: (index: number) => void
  /**
   * Start the inline rename on a row, as a double-click does.
   *
   * Exposed so a context menu can offer Rename: double-click is the only way in today, which is a gesture
   * nobody discovers and one that a trackpad makes awkward.
   */
  beginRename: (index: number) => void
  /**
   * Open or shut every row that has contents.
   *
   * Collapse-all is the one that earns its place: a level of thirty placements, each with its prefab's nodes
   * under it, is a hundred rows of which you want four.
   */
  setAllOpen: (open: boolean) => void
}

export const createHierarchy = (container: HTMLElement, host: HierarchyHost): Hierarchy => {
  const expanded = new Set<string>()
  let dragFrom: number | null = null
  /** Every row the drag carries, ascending (ADR 0134). The whole selection, or just the grabbed row. */
  let dragRows: number[] = []
  let editing: number | null = null

  const clearDropMarks = (): void => {
    for (const r of container.children) r.classList.remove('drop-above', 'drop-below', 'drop-onto')
  }

  const render = (): void => {
    const doc = host.doc()
    container.replaceChildren()

    /**
     * The level's environment: not a node, so it sits above the tree rather than in it (ADR 0048). A row rather
     * than a menu item because it has to be *discoverable* — the sun was unreachable before this existed, and
     * a thing you cannot find is not much better.
     *
     * Drawn even when the document is empty: a level with nothing in it still has a sun.
     */
    if (doc !== null && doc.mode === 'level') {
      /**
       * Which game this level is for, and that game's own settings (ADR 0052). A sibling of Environment rather
       * than a section inside it: they are two subjects, and the game decides what the level *is* where the
       * sun decides what it looks like.
       */
      const game = document.createElement('div')
      game.className = `row env${host.gameSelected() ? ' sel' : ''}`
      game.textContent = `🎮 ${host.gameLabel()}`
      game.title = 'which game this level is for, and its settings'
      game.addEventListener('pointerdown', () => host.onSelectGame())
      container.append(game)

      const env = document.createElement('div')
      env.className = `row env${host.envSelected() ? ' sel' : ''}`
      env.textContent = '☀ Environment'
      env.title = 'sun and sky for this level'
      env.addEventListener('pointerdown', () => host.onSelectEnv())
      container.append(env)
    }

    if (doc === null || doc.count() === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = doc === null ? 'nothing open' : 'empty — place something from the Prefabs panel'
      container.append(empty)
      return
    }

    const selection = host.selection()
    const primary = selection[selection.length - 1] ?? null
    const rows = rowsOf(doc, { expanded }, host.heldBy, host.isHidden)
    // Every visible row in draw order: what a Shift-range runs over. Pieces are selectable too, so they are
    // in it — a range that skipped them would jump over what the eye sees between two rows.
    const order = rows.map((r) => r.index)

    for (const row of rows) {
      const el = document.createElement('div')
      el.className = [
        'row',
        row.kind === 'inherited' ? 'inherited' : '',
        row.linked ? 'linked' : '',
        selection.includes(row.index) ? 'sel' : '',
        // The primary is marked apart, because it is the one the Inspector shows and the one a range anchors
        // on: "which of these five am I editing" has to be answerable at a glance.
        row.index === primary && selection.length > 1 ? 'primary' : '',
        row.held !== '' ? 'held' : '',
        // Off itself, or off because something above it is: both read as absent, and the second cannot be
        // fixed on this row, so they look the same and the checkbox says which.
        row.disabled || row.disabledAbove ? 'off' : '',
        // Its own class, never `off`: hidden and switched-off mean different things and must not look alike.
        row.hidden ? 'eyeshut' : '',
      ]
        .filter((c) => c !== '')
        .join(' ')
      // Indentation is the only thing that says "inside", so it comes from the data, not from a class.
      // The eye sits in a fixed gutter at the left of the panel, **outside** the indentation, so the column
      // lines up however deep the tree goes. Indented, the eyes would zigzag down the list (ADR 0132).
      el.style.paddingLeft = `${EYE_GUTTER + 6 + row.depth * 14}px`
      el.dataset.index = String(row.index) // what `reveal` scrolls to after a render

      /**
       * The eye. Empty until the row is hovered, and always drawn once the node is hidden — so the column
       * costs nothing when unused, which is what ADR 0102 objected to about a column of controls here.
       * Alt-click takes the node alone and leaves its children visible, as Unity's does.
       */
      const eye = document.createElement('span')
      eye.className = 'eye'
      eye.textContent = row.hidden ? '◉' : '○'
      eye.title = row.hidden ? 'hidden in the viewport (alt-click: this object only)' : 'hide in the viewport (alt-click: this object only)'
      eye.addEventListener('pointerdown', (ev) => {
        // Before the row's own handler, so hiding something never also selects it.
        ev.stopPropagation()
        ev.preventDefault()
      })
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation()
        host.onToggleHidden(row.index, ev.altKey)
      })
      el.append(eye)

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
      // Someone else has it: their name is the badge, and the row does nothing but say so.
      if (row.held !== '') {
        const badge = document.createElement('span')
        badge.className = 'badge held'
        badge.textContent = row.held
        el.append(badge)
        el.title = `${row.held} has this selected`
        el.addEventListener('pointerdown', (e) => host.onSelect(row.index, modeFor(e), order))
        container.append(el)
        continue
      }

      // Selecting and renaming work on every row, pieces included: a piece is an object now (ADR 0033), so it
      // is what the Inspector shows and what the gizmo moves.
      el.addEventListener('pointerdown', (e) => host.onSelect(row.index, modeFor(e), order))
      el.addEventListener('dblclick', () => {
        editing = row.index
        render()
      })

      /**
       * **A piece can be dragged too, but only out** (ADR 0133). It is resolved into a node of this level at
       * the destination and the placement records it is gone, so nothing about the prefab moves. What is
       * still refused is a piece as a *destination* — `zoneOf` below offers no `onto` for one — because
       * where a piece sits is the prefab's, for every placement at once.
       */
      {
        el.draggable = true
        el.addEventListener('dragstart', (e) => {
          // Grabbing a row that is already selected drags the whole selection; grabbing one that is not
          // drags it alone, and Unity does the same. Ascending, so the drop keeps the order they were in.
          const selected = host.selection()
          dragRows = selected.includes(row.index) ? [...selected].sort((a, b) => a - b) : [row.index]
          dragFrom = row.index
          el.classList.add('dragging')
          // Firefox will not start a drag without payload; the index itself travels in a closure variable
          // because dataTransfer is unreadable during dragover, which is when the target must be known.
          e.dataTransfer?.setData('text/plain', String(row.index))
          if (e.dataTransfer !== null) e.dataTransfer.effectAllowed = 'move'
        })
        el.addEventListener('dragend', () => {
          dragFrom = null
          dragRows = []
          el.classList.remove('dragging')
          clearDropMarks()
        })
      }
      if (row.kind === 'inherited') el.title = 'piece of the shared prefab: editing it changes every instance of that prefab'

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
        // Legal if *any* of the dragged rows can go there; the ones that cannot are skipped on the drop.
        const want = dropTarget(row, zone).parent
        if (!(dragRows.length > 0 ? dragRows : [dragFrom]).some((i) => doc.canReparent(i, want))) {
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
        const rows = dragRows.length > 0 ? dragRows : [dragFrom]
        dragFrom = null
        dragRows = []
        clearDropMarks()
        host.onReparent(rows, parent, at)
      })

      container.append(el)
    }
  }

  /**
   * Open every ancestor of `index`, then bring the row on screen.
   *
   * Re-renders only when something actually opened, so selecting a row that was already visible is a scroll
   * and nothing else. `block: 'nearest'` because a row already in view should not be yanked to the middle.
   */
  const reveal = (index: number): void => {
    const doc = host.doc()
    if (doc === null || index < 0 || index >= doc.count()) return
    let opened = false
    for (const path of ancestorPaths(doc, index)) {
      if (expanded.has(path)) continue
      expanded.add(path)
      opened = true
    }
    if (opened) render()
    container.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  return {
    render,
    reveal,
    beginRename: (index) => {
      editing = index
      render()
    },
    setAllOpen: (open) => {
      expanded.clear()
      const doc = host.doc()
      if (open && doc !== null) for (let i = 0; i < doc.count(); i++) if (doc.childCount(i) > 0) expanded.add(doc.pathOf(i))
      render()
    },
  }
}
