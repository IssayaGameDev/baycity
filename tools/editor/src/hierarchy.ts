import type { Doc } from './editorDoc'
import { pressRowToDrag, rowJustDragged, INDENT, ROW_BASE, type DrawnRow } from './hierarchyDrag'
import { icon, type IconName } from './icons'
import { defersToClick, modeFor, type SelectMode } from './selection'

/**
 * The Hierarchy panel: the document as a tree of selectable, renameable, reorderable, re-parentable rows.
 *
 * Nodes nest to any depth, so a row's children are what is placed *relative to it* — dragging one onto
 * another changes what its transform is measured against, and at runtime motion composes down the chain (a
 * bar spinning on a moving deck).
 *
 * A row's **contents** are what it inherits from its prefab followed by its own children, and one twist hides
 * both (ADR 0033, ADR 0035). An inherited row is an object like any other here — it carries the components, so
 * it is what the Inspector shows and what the gizmo moves, and every gesture here works on it (ADR 0151): what
 * you do to it — reorder, delete, drop into, drag out — is recorded on that placement alone.
 *
 * How a row reads (ADR 0150), Unity's way: a cube per row — blue and filled for a prefab, light blue for one
 * of its pieces, grey for an object of the level's own — guide lines down each level of nesting, the eye at
 * the right end on hover, and a count only where a prefab is placed more than once.
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
  /**
   * Right-aligned annotation: how many times the prefab is placed, when it is more than once. Nothing else —
   * `inline` was on every object that is not a prefab, so the commonest row said the least (ADR 0150).
   */
  badge: string
  /** Who else has this node selected, each in their colour (ADR 0158) — shown, never in the way. */
  held: readonly Holder[]
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
export const rowsOf = (
  doc: Doc,
  open: Openness,
  holders: (index: number) => readonly Holder[] = () => [],
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
      badge: shared > 1 ? `×${shared}` : '',
      held: holders(i),
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

/** A row's cube and the class that colours it: a prefab, one of a prefab's pieces, or the level's own. */
export const rowIcon = (row: Pick<Row, 'kind' | 'linked'>): { icon: IconName; className: string } =>
  row.linked ? { icon: 'prefab', className: 'is-prefab' } : row.kind === 'inherited' ? { icon: 'object', className: 'is-piece' } : { icon: 'object', className: 'is-object' }

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
  /** Is this node hidden in the viewport (ADR 0132)? What the eye draws. */
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
  /**
   * A drop happened. `from` is **every** row the drag carried, top to bottom (ADR 0134): the whole selection
   * when the grabbed row was part of it, else just that row. Re-parented under `parent` (`null` = top level)
   * at sibling position `at`.
   */
  onReparent: (from: readonly number[], parent: number | null, at: number) => void
  /**
   * Who else has this node selected, each in their colour — the same as their outline and their icon (ADR 0155,
   * ADR 0158). Absent when nobody else can be here.
   */
  holders?: (index: number) => readonly Holder[]
}

/** Someone else who has a node selected. */
export interface Holder {
  name: string
  /** CSS colour. */
  colour: string
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

const span = (className: string, text?: string): HTMLSpanElement => {
  const s = document.createElement('span')
  s.className = className
  if (text !== undefined) s.textContent = text
  return s
}

export const createHierarchy = (container: HTMLElement, host: HierarchyHost): Hierarchy => {
  const expanded = new Set<string>()
  /** The row whose press left a multi-selection alone, to collapse it on the click if no drag came of it. */
  let pressKept: number | null = null
  let editing: number | null = null
  /** What the last render drew, for a drag to measure. */
  let drawn: DrawnRow[] = []

  /** A level setting above the tree: the Game and Environment rows (ADR 0048, ADR 0052). */
  const settingRow = (name: IconName, text: string, title: string, selected: boolean, onPick: () => void): HTMLElement => {
    const row = document.createElement('div')
    row.className = `row env${selected ? ' sel' : ''}`
    row.title = title
    row.append(icon(name, 'ic ico'), span('name', text))
    row.addEventListener('pointerdown', () => onPick())
    return row
  }

  const render = (): void => {
    const doc = host.doc()
    container.replaceChildren()
    drawn = []

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
      container.append(settingRow('gamepad', host.gameLabel(), 'which game this level is for, and its settings', host.gameSelected(), host.onSelectGame))
      container.append(settingRow('sun', 'Environment', 'sun, sky and camera for this level', host.envSelected(), host.onSelectEnv))
    }

    if (doc === null || doc.count() === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = doc === null ? 'nothing open' : 'empty — place something from the Project panel'
      container.append(empty)
      return
    }

    const selection = host.selection()
    const primary = selection[selection.length - 1] ?? null
    const rows = rowsOf(doc, { expanded }, host.holders, host.isHidden)
    // Every visible row in draw order: what a Shift-range runs over. Pieces are selectable too, so they are
    // in it — a range that skipped them would jump over what the eye sees between two rows.
    const order = rows.map((r) => r.index)

    for (const row of rows) {
      const el = document.createElement('div')
      const look = rowIcon(row)
      el.className = [
        'row',
        row.kind === 'inherited' ? 'inherited' : '',
        row.linked ? 'linked' : '',
        selection.includes(row.index) ? 'sel' : '',
        // The primary is marked apart, because it is the one the Inspector shows and the one a range anchors
        // on: "which of these five am I editing" has to be answerable at a glance.
        row.index === primary && selection.length > 1 ? 'primary' : '',
        // Off itself, or off because something above it is: both read as absent, and the second cannot be
        // fixed on this row, so they look the same and the checkbox says which.
        row.disabled || row.disabledAbove ? 'off' : '',
        // Its own class, never `off`: hidden and switched-off mean different things and must not look alike.
        row.hidden ? 'eyeshut' : '',
      ]
        .filter((c) => c !== '')
        .join(' ')
      // Indentation is the only thing that says "inside", so it comes from the data, not from a class.
      el.style.paddingLeft = `${ROW_BASE + row.depth * INDENT}px`
      el.dataset.index = String(row.index) // what `reveal` scrolls to after a render

      // A line down each level of nesting above this row, so a long open group reads as one.
      if (row.depth > 0) {
        const guides = span('guides')
        guides.style.width = `${row.depth * INDENT}px`
        el.append(guides)
      }

      const twist = span(row.expandable ? `twist${row.expanded ? '' : ' shut'}` : 'twist')
      if (row.expandable) {
        twist.append(icon('chevron'))
        twist.addEventListener('pointerdown', (e) => {
          e.stopPropagation() // opening is not selecting
          if (expanded.has(row.path)) expanded.delete(row.path)
          else expanded.add(row.path)
          render()
        })
      }
      el.append(twist, icon(look.icon, `ic ico ${look.className}`))

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
        drawn.push({ row, el }) // still a row on screen, which a drop measures around
        // Focus once the row is in the document, or the caret has nowhere to go.
        requestAnimationFrame(() => {
          input.focus()
          input.select()
        })
        continue
      }

      el.append(span('name', row.label))

      /**
       * The eye, at the right end (ADR 0150): drawn on hover, and always once the node is hidden, so the
       * column costs nothing when unused (ADR 0102) and pushes nothing to the right. Alt-click takes the node
       * alone and leaves its children visible, as Unity's does.
       */
      const eye = document.createElement('button')
      eye.type = 'button'
      eye.className = 'eye'
      eye.append(icon(row.hidden ? 'disable' : 'enable'))
      eye.title = row.hidden ? 'hidden in the viewport: click to show (alt-click: this object only)' : 'hide in the viewport (alt-click: this object only)'
      eye.addEventListener('pointerdown', (ev) => {
        // Before the row's own handler, so hiding something never also selects it or starts a drag.
        ev.stopPropagation()
        ev.preventDefault()
      })
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation()
        host.onToggleHidden(row.index, ev.altKey)
      })
      el.append(eye)

      if (row.badge !== '') el.append(span('badge', row.badge))
      // Who else has it selected: a badge each, in their colour. Shown, and nothing more (ADR 0158).
      for (const h of row.held) {
        const holder = span('badge held', h.name)
        holder.style.setProperty('--peer', h.colour)
        el.append(holder)
      }
      if (row.held.length > 0) el.title = `${row.held.map((h) => h.name).join(' and ')} ${row.held.length === 1 ? 'has' : 'have'} this selected too`

      // Selecting and renaming work on every row, pieces included: a piece is an object now (ADR 0033), so it
      // is what the Inspector shows and what the gizmo moves.
      // A plain press on a row of a multi-selection waits for the click, so a drag can still carry the whole
      // selection (ADR 0134). A drag never produces the click, so the selection survives it.
      el.addEventListener('pointerdown', (e) => {
        const mode = modeFor(e)
        pressKept = defersToClick(host.selection(), row.index, mode, e.button) ? row.index : null
        if (pressKept === null) host.onSelect(row.index, mode, order)
        // Read after the press has had its say, so a Ctrl-press that took this row out carries it alone.
        const selected = host.selection()
        /**
         * Every row drags, a piece included (ADR 0151): among its siblings it is reordered and stays a piece;
         * anywhere else it lands as a copy and the placement records it gone (ADR 0133). A piece takes a drop
         * as well, into its placement's record. What each means is the document's (`Doc.reparent`).
         *
         * Grabbing a row that is already selected drags the whole selection; grabbing one that is not drags it
         * alone, as Unity does. Ascending, so the drop keeps the order they were in.
         */
        const carried = selected.includes(row.index) ? [...selected].sort((a, b) => a - b) : [row.index]
        pressRowToDrag(e, {
          list: container,
          drawn: () => drawn,
          carried,
          label: { icon: look.icon, text: row.label, className: look.className },
          canReparent: (parent) => carried.some((i) => host.doc()?.canReparent(i, parent) === true),
          expand: (index) => {
            const d = host.doc()
            if (d === null) return
            expanded.add(d.pathOf(index))
            render()
          },
          drop: (parent, at) => {
            pressKept = null
            host.onReparent(carried, parent, at)
          },
        })
      })
      el.addEventListener('click', () => {
        if (rowJustDragged()) {
          pressKept = null
          return
        }
        if (pressKept !== row.index) return
        pressKept = null
        host.onSelect(row.index, 'replace', order)
      })
      el.addEventListener('dblclick', () => {
        editing = row.index
        render()
      })
      if (row.kind === 'inherited') el.title = 'piece of the shared prefab: editing it changes every instance of that prefab'

      container.append(el)
      drawn.push({ row, el })
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
