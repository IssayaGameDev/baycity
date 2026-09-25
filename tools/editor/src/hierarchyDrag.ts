import { icon, type IconName } from './icons'

/**
 * Dragging rows in the Hierarchy (ADR 0150), on pointer events rather than the browser's drag and drop, the
 * way the sequence editor's drag was rebuilt (ADR 0147).
 *
 * A press on a row becomes a drag once the pointer has moved a few pixels, so a click still selects. A copy of
 * the row follows the pointer; a **line** shows where it would land, indented to the depth it would land at,
 * or the row it would go into lights up. Between two rows where more than one depth is possible — after the
 * last child of a group, which could stay in the group or leave it — the pointer's distance from the left
 * picks. Holding over a shut row opens it, the panel scrolls at its edges, and Escape puts everything back.
 *
 * The decision is `dropAt`, pure, over measured rows; the rest measures and draws.
 */

/** Left padding of a row, and how far each level of nesting indents it. The guides and the line share them. */
export const ROW_BASE = 6
export const INDENT = 16

/** One visible row as the drop needs it: where it is in the tree, and where it is on screen. */
export interface DropRow {
  readonly index: number
  readonly depth: number
  readonly parent: number | null
  readonly siblingIndex: number
  readonly top: number
  readonly bottom: number
}

export type RowDrop =
  /** Into this row, last among its children. */
  | { readonly kind: 'onto'; readonly index: number }
  /** Between rows: under `parent` (`null` = the top level) at `at`, drawn as a line at `y`, indented to `depth`. */
  | { readonly kind: 'between'; readonly parent: number | null; readonly at: number; readonly y: number; readonly depth: number }

/** Of a row's height, how much at the top and at the bottom means "beside it" rather than "into it". */
const EDGE_BAND = 0.3

/**
 * Where a pointer at height `y` drops, with `wantDepth` the nesting level its distance from the left asks for.
 *
 * Over a row's middle, into it — when `canOnto` says it can take what is carried, which a prefab's piece can
 * (ADR 0151); over its top or bottom, or over any part of a row that cannot, the gap beside it. A gap offers the depths that keep the tree what it
 * shows: before a row at that row's own depth, or after the row above at any depth from the row below's up to
 * its own — closing the groups it ends. `null` only for an empty list.
 */
export const dropAt = (rows: readonly DropRow[], y: number, wantDepth: number, canOnto: (index: number) => boolean): RowDrop | null => {
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (first === undefined || last === undefined) return null
  let above: DropRow | undefined
  let below: DropRow | undefined
  const at = rows.findIndex((r) => y >= r.top && y < r.bottom)
  if (at < 0) {
    if (y < first.top) below = first
    else above = last
  } else {
    const r = rows[at]!
    const t = r.bottom > r.top ? (y - r.top) / (r.bottom - r.top) : 0
    const onto = canOnto(r.index)
    const upper = onto ? t < EDGE_BAND : t < 0.5
    const lower = onto ? t > 1 - EDGE_BAND : t >= 0.5
    if (!upper && !lower) return { kind: 'onto', index: r.index }
    if (upper) {
      above = rows[at - 1]
      below = r
    } else {
      above = r
      below = rows[at + 1]
    }
  }

  // The depths this gap allows.
  let min: number
  let max: number
  if (above === undefined) min = max = below!.depth
  else if (below === undefined) {
    min = 0
    max = above.depth
  } else if (below.depth > above.depth) min = max = below.depth // the first child of an open row
  else {
    min = below.depth
    max = above.depth
  }
  const depth = Math.min(max, Math.max(min, Math.round(wantDepth)))
  const lineY = above === undefined ? below!.top : above.bottom

  if (below !== undefined && depth === below.depth) return { kind: 'between', parent: below.parent, at: below.siblingIndex, y: lineY, depth }
  // After the row above, or after whichever of its ancestors sits at that depth: the groups between close.
  const byIndex = new Map(rows.map((r) => [r.index, r]))
  let x: DropRow = above!
  while (x.depth > depth && x.parent !== null) {
    const up = byIndex.get(x.parent)
    if (up === undefined) break
    x = up
  }
  return { kind: 'between', parent: x.parent, at: x.siblingIndex + 1, y: lineY, depth }
}

// --- on screen ----------------------------------------------------------------------------------------

/** A row on screen: its place in the tree and its element. What the panel drew last; measured when needed. */
export interface DrawnRow {
  readonly row: Omit<DropRow, 'top' | 'bottom'> & { readonly expandable: boolean; readonly expanded: boolean }
  readonly el: HTMLElement
}

export interface RowDragHost {
  /** The scrolling list the rows are in. */
  readonly list: HTMLElement
  /** The rows as drawn right now — asked every frame, because opening a row redraws them. */
  readonly drawn: () => readonly DrawnRow[]
  /** Every row the drag carries, top to bottom (ADR 0134). */
  readonly carried: readonly number[]
  /** What the copy under the pointer says: the grabbed row's icon and name. */
  readonly label: { readonly icon: IconName; readonly text: string; readonly className: string }
  /** Could any of the carried rows go under `parent`. A place none can go shows nothing. */
  readonly canReparent: (parent: number | null) => boolean
  /** Open a shut row the pointer has held over. */
  readonly expand: (index: number) => void
  readonly drop: (parent: number | null, at: number) => void
}

const THRESHOLD = 4
const EDGE = 28
/** How long the pointer holds over a shut row before it opens. */
const OPEN_AFTER_MS = 600

let clickSuppressedUntil = 0
/** A drag just ended on this press, so the click the browser sends after it is not a click. */
export const rowJustDragged = (): boolean => performance.now() < clickSuppressedUntil

/** A press on a row: a drag if it moves, nothing if it does not. */
export const pressRowToDrag = (e: PointerEvent, host: RowDragHost): void => {
  if (e.button !== 0) return
  const startX = e.clientX
  const startY = e.clientY
  let x = startX
  let y = startY
  let ghost: HTMLElement | null = null
  let line: HTMLElement | null = null
  let landing: RowDrop | null = null
  let holding: { index: number; since: number } | null = null
  let frame = 0

  const marks = (): void => {
    for (const d of host.drawn()) {
      d.el.classList.toggle('carried', host.carried.includes(d.row.index))
      d.el.classList.toggle('drop-onto', landing?.kind === 'onto' && landing.index === d.row.index)
    }
  }

  const begin = (): void => {
    ghost = document.createElement('div')
    ghost.className = `hier-ghost ${host.label.className}`
    ghost.append(icon(host.label.icon))
    const name = document.createElement('span')
    name.textContent = host.label.text
    ghost.append(name)
    if (host.carried.length > 1) {
      const more = document.createElement('span')
      more.className = 'more'
      more.textContent = `+${host.carried.length - 1}`
      ghost.append(more)
    }
    document.body.append(ghost)
    line = document.createElement('div')
    line.className = 'hier-line'
    line.hidden = true
    document.body.append(line)
    document.body.classList.add('hier-dragging')
    frame = requestAnimationFrame(tick)
  }

  const locate = (): void => {
    const drawn = host.drawn()
    const box = host.list.getBoundingClientRect()
    const rows = drawn.map((d) => {
      const r = d.el.getBoundingClientRect()
      return { ...d.row, top: r.top, bottom: r.bottom }
    })
    const over = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    const want = (x - box.left - ROW_BASE - INDENT / 2) / INDENT
    const drop = over ? dropAt(rows, y, want, (index) => host.canReparent(index)) : null
    landing = drop !== null && host.canReparent(drop.kind === 'onto' ? drop.index : drop.parent) ? drop : null

    if (line !== null) {
      if (landing?.kind === 'between') {
        const left = box.left + ROW_BASE + landing.depth * INDENT + 4
        line.hidden = false
        line.style.left = `${left}px`
        line.style.width = `${Math.max(12, box.right - left - 6)}px`
        line.style.top = `${landing.y - 1}px`
      } else line.hidden = true
    }

    // Hold over a shut row and it opens, so a drop can reach inside it.
    const into = landing?.kind === 'onto' ? landing.index : null
    const shut = into === null ? undefined : drawn.find((d) => d.row.index === into && d.row.expandable && !d.row.expanded)
    if (shut === undefined) holding = null
    else if (holding === null || holding.index !== shut.row.index) holding = { index: shut.row.index, since: performance.now() }
    else if (performance.now() - holding.since >= OPEN_AFTER_MS) {
      holding = null
      host.expand(shut.row.index)
    }
    marks()
  }

  const tick = (): void => {
    if (ghost === null) return
    ghost.style.transform = `translate(${x + 12}px, ${y + 8}px)`
    const r = host.list.getBoundingClientRect()
    if (x >= r.left && x <= r.right) {
      const speed = y < r.top + EDGE ? -(r.top + EDGE - y) : y > r.bottom - EDGE ? y - (r.bottom - EDGE) : 0
      if (speed !== 0) host.list.scrollTop += Math.round(speed / 3)
    }
    locate()
    frame = requestAnimationFrame(tick)
  }

  const end = (drop: boolean): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    if (ghost === null) return
    cancelAnimationFrame(frame)
    ghost.remove()
    line?.remove()
    ghost = null
    document.body.classList.remove('hier-dragging')
    clickSuppressedUntil = performance.now() + 250
    const landed = landing
    landing = null
    for (const d of host.drawn()) d.el.classList.remove('carried', 'drop-onto')
    if (!drop || landed === null) return
    if (landed.kind === 'onto') host.drop(landed.index, Number.MAX_SAFE_INTEGER) // appended; clamped by the doc
    else host.drop(landed.parent, landed.at)
  }
  const move = (m: PointerEvent): void => {
    x = m.clientX
    y = m.clientY
    if (ghost === null && Math.hypot(x - startX, y - startY) >= THRESHOLD) begin()
  }
  const up = (): void => end(true)
  const cancel = (): void => end(false)
  const key = (k: KeyboardEvent): void => {
    if (k.key !== 'Escape' || ghost === null) return
    k.stopPropagation()
    end(false)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
}
