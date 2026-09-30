import { closePopover, installPopoverDismissal, openPopover, popoverOpenFor } from './controls'
import { icon, type IconName } from './icons'

/**
 * A reference field (ADR 0176, ADR 0177): a parameter that points at something — an object, a component, a material,
 * a model, a texture — drawn and handled the way Unity's object field is. It shows what it points at: a press
 * **pings** it (the row or the tile, found and flashed, the selection left alone), a double-click **opens** it (the
 * object selected, the asset shown). Delete or Backspace on it clears it; the picker is a search over what fits,
 * None first; and whatever it takes can be dragged onto it — a Hierarchy row, an Inspector card by its header, a
 * Project window tile, the first of several.
 *
 * The drags are not all the same kind. The Project window's is the browser's, whose payload cannot be read before
 * the drop, so the field asks the host what is being dragged (`draggedAssets`). The Hierarchy's and the cards' are
 * on pointer events (ADR 0150, ADR 0152), with no browser events to hear, so the drag asks the field under the
 * pointer instead (`refFieldAt`). All end in the same two questions — `refuse`, then `take`.
 */

/**
 * What can be dropped on a reference field: a Hierarchy row by index, an Inspector card — one component of the node
 * at `index` — or a Project window asset by id.
 */
export type RefDrag =
  | { readonly kind: 'node'; readonly index: number }
  | { readonly kind: 'component'; readonly index: number; readonly component: string }
  | { readonly kind: 'asset'; readonly id: string }

/** What the field shows: a name and its icon; `null` for none; `'mixed'` when a multi-selection disagrees. */
export type RefShown = { readonly label: string; readonly icon: IconName; readonly missing?: boolean } | null | 'mixed'

export interface RefChoice {
  readonly value: string
  readonly label: string
  readonly icon: IconName
}

export interface RefFieldOptions {
  readonly shown: RefShown
  /** What it says when it points at nothing: `None (Material)`. */
  readonly none: string
  readonly title?: string
  /** The picker's list, asked each time it opens. */
  readonly choices: () => readonly RefChoice[]
  /** Write a value; `null` clears it. */
  readonly pick: (value: string | null) => void
  /** Find what it points at, without selecting it. Absent where there is nothing to find (a built-in shape). */
  readonly ping?: () => void
  /** Open what it points at: the object selected, the asset shown — Unity's double-click. */
  readonly open?: () => void
  /** Why this drag cannot land here, or `null` when it can. */
  readonly refuse: (drag: RefDrag) => string | null
  /** Take a drag `refuse` let through. */
  readonly take: (drag: RefDrag) => void
  /** The assets a Project window drag carries right now; empty when none is under way. */
  readonly draggedAssets: () => readonly string[]
}

export interface RefField {
  readonly root: HTMLElement
  /** Show a value changed elsewhere, in place. */
  readonly set: (shown: RefShown) => void
}

/** What a pointer drag asks the field under it: may it land (and show that), and take it. */
export interface RefTarget {
  /** Light the field for this drag, or grey it with why; `true` when it may land. */
  readonly offer: (drag: RefDrag) => boolean
  /** The drag moved off it. */
  readonly leave: () => void
  readonly take: (drag: RefDrag) => void
}

const targets = new WeakMap<HTMLElement, RefTarget>()

/** The reference field under a point, for a drag that is not the browser's (the Hierarchy's). */
export const refFieldAt = (x: number, y: number): RefTarget | null => {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('.rf')
  return hit === null || hit === undefined ? null : (targets.get(hit) ?? null)
}

/** The target a field element answers to, for tests and for a caller holding the element. */
export const refTargetOf = (root: HTMLElement): RefTarget | null => targets.get(root) ?? null

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export const refField = (o: RefFieldOptions): RefField => {
  installPopoverDismissal()
  const root = el('div', 'rf')
  if (o.title !== undefined) root.title = o.title
  const name = el('button', 'rf-name')
  name.type = 'button'
  const open = el('button', 'rf-pick')
  open.type = 'button'
  open.title = 'Pick'
  open.append(icon('search'))
  root.append(name, open)

  let shown = o.shown
  /** A drag over the field: why it cannot land, `null` when it can, `undefined` when none is. */
  let over: string | null | undefined

  const paint = (): void => {
    name.replaceChildren()
    root.classList.toggle('rf-ok', over === null)
    root.classList.toggle('rf-no', typeof over === 'string')
    root.classList.toggle('rf-none', shown === null)
    root.classList.toggle('rf-missing', shown !== null && shown !== 'mixed' && shown.missing === true)
    if (typeof over === 'string') {
      name.append(el('span', 'rf-t', over))
      name.title = over
    } else if (shown === 'mixed') {
      name.append(el('span', 'rf-t', '—'))
      name.title = 'differs across the selection'
    } else if (shown === null) {
      name.append(el('span', 'rf-t', o.none))
      name.title = ''
    } else {
      name.append(icon(shown.icon), el('span', 'rf-t', shown.label))
      name.title = o.ping === undefined ? `${shown.label} · Delete clears` : `${shown.label} — click to show it, double-click to open · Delete clears`
    }
  }
  paint()

  const pointsAt = (): boolean => shown !== null && shown !== 'mixed' && shown.missing !== true
  name.addEventListener('click', () => {
    if (pointsAt()) o.ping?.()
  })
  name.addEventListener('dblclick', () => {
    if (pointsAt()) o.open?.()
  })
  // Unity's way to clear one: Delete on the focused field. Kept from the editor's own Delete, which deletes objects.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    e.preventDefault()
    e.stopPropagation()
    if (shown !== null) o.pick(null)
  })

  /** The picker: a search box over the choices, None first. A press on one writes it and closes. */
  open.addEventListener('click', () => {
    if (popoverOpenFor(open)) return closePopover()
    const panel = el('div', 'rf-list')
    const search = el('input', 'txt rf-search')
    search.type = 'text'
    search.spellcheck = false
    search.placeholder = 'Search'
    const rows = el('div', 'rf-rows')
    const all = o.choices()
    const draw = (): void => {
      const q = search.value.trim().toLowerCase()
      rows.replaceChildren()
      const row = (label: string, glyph: IconName | null, value: string | null): void => {
        const b = el('button', 'rf-row')
        b.type = 'button'
        if (glyph !== null) b.append(icon(glyph))
        b.append(el('span', 'rf-t', label))
        b.addEventListener('click', () => {
          closePopover()
          o.pick(value)
        })
        rows.append(b)
      }
      if (q === '') row('None', null, null)
      const hits = all.filter((c) => q === '' || c.label.toLowerCase().includes(q))
      for (const c of hits) row(c.label, c.icon, c.value)
      if (hits.length === 0 && q !== '') rows.append(el('div', 'rf-empty', 'nothing matches'))
    }
    search.addEventListener('input', draw)
    // Enter takes the first match, as a search box in a picker does.
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      rows.querySelector<HTMLButtonElement>('.rf-row')?.click()
    })
    draw()
    panel.append(search, rows)
    openPopover(open, panel, { className: 'pop-ref' })
    search.focus()
  })

  const target: RefTarget = {
    offer: (drag) => {
      over = o.refuse(drag)
      paint()
      return over === null
    },
    leave: () => {
      if (over === undefined) return
      over = undefined
      paint()
    },
    take: (drag) => {
      over = undefined
      paint()
      if (o.refuse(drag) === null) o.take(drag)
    },
  }
  targets.set(root, target)

  /** A field holds one: of several tiles, the first — as Unity takes the first of several dragged. */
  const assetDrag = (): RefDrag | null => {
    const id = o.draggedAssets()[0]
    return id === undefined ? null : { kind: 'asset', id }
  }
  root.addEventListener('dragover', (e) => {
    const drag = assetDrag()
    if (drag === null) return
    if (!target.offer(drag)) return
    e.preventDefault()
    const dt = e.dataTransfer
    // The tile says which effects it allows; a folder move allows only `move`.
    if (dt) dt.dropEffect = dt.effectAllowed === 'move' ? 'move' : 'copy'
  })
  root.addEventListener('dragleave', (e) => {
    if (!(e.relatedTarget instanceof Node && root.contains(e.relatedTarget))) target.leave()
  })
  root.addEventListener('drop', (e) => {
    const drag = assetDrag()
    target.leave()
    if (drag === null) return
    e.preventDefault()
    target.take(drag)
  })

  return {
    root,
    set: (next) => {
      shown = next
      paint()
    },
  }
}
