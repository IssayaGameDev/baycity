import { closePopover, installPopoverDismissal, openPopover, popoverOpenFor } from './controls'
import { icon, type IconName } from './icons'

/**
 * A reference field (ADR 0176): a parameter that points at something — an object, a material, a model, a texture —
 * drawn the way Unity draws one, instead of a dropdown. It shows what it points at (a press **pings** it: the row
 * or the tile, found and flashed, the selection left alone), clears with ✕, and opens a searchable picker, and
 * whatever it takes can be dragged onto it: a Hierarchy row, a Project window tile.
 *
 * The two drags are not the same kind. The Project window's is the browser's, whose payload cannot be read before
 * the drop, so the field asks the host what is being dragged (`draggedAssets`). The Hierarchy's is on pointer
 * events (ADR 0150), with no browser events to hear, so the drag asks the field under the pointer instead
 * (`refFieldAt`). Both end in the same two questions — `refuse`, then `take`.
 */

/** What can be dropped on a reference field: a Hierarchy row by index, or a Project window asset by id. */
export type RefDrag = { readonly kind: 'node'; readonly index: number } | { readonly kind: 'asset'; readonly id: string }

/** What the field shows: a name and its icon; `null` for none; `'mixed'` when a multi-selection disagrees. */
export type RefShown = { readonly label: string; readonly icon: IconName; readonly missing?: boolean } | null | 'mixed'

export interface RefChoice {
  readonly value: string
  readonly label: string
  readonly icon: IconName
}

export interface RefFieldOptions {
  readonly shown: RefShown
  /** What it says when it points at nothing: `None (material)`. */
  readonly none: string
  readonly title?: string
  /** The picker's list, asked each time it opens. */
  readonly choices: () => readonly RefChoice[]
  /** Write a value; `null` clears it. */
  readonly pick: (value: string | null) => void
  /** Find what it points at, without selecting it. Absent where there is nothing to find (a built-in shape). */
  readonly ping?: () => void
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
  const clear = el('button', 'rf-x')
  clear.type = 'button'
  clear.title = 'Clear'
  clear.append(icon('close'))
  const open = el('button', 'rf-pick')
  open.type = 'button'
  open.title = 'Pick'
  open.append(icon('search'))
  root.append(name, clear, open)

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
      name.title = o.ping === undefined ? shown.label : `${shown.label} — show it`
    }
    clear.hidden = shown === null
  }
  paint()

  name.addEventListener('click', () => {
    if (shown !== null && shown !== 'mixed') o.ping?.()
  })
  clear.addEventListener('click', () => o.pick(null))

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

  /** One asset at a time: a field holds one. */
  const assetDrag = (): RefDrag | string | null => {
    const ids = o.draggedAssets()
    if (ids.length === 0) return null
    return ids.length > 1 ? 'one at a time' : { kind: 'asset', id: ids[0]! }
  }
  root.addEventListener('dragover', (e) => {
    const drag = assetDrag()
    if (drag === null) return
    if (typeof drag === 'string') {
      over = drag
      paint()
      return
    }
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
    if (drag === null || typeof drag === 'string') return
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
