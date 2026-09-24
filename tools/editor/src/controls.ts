/**
 * The sequence editor's controls (ADR 0147): a number you drag sideways to change, a segmented switch, and a
 * popover. Our own DOM, in the editor's own look — Tweakpane's widgets are a second visual language, and a
 * narrow panel of mixed ones read as a developer's tool.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// --- dragging a number --------------------------------------------------------------------------------

/** How a dragged number moves: this much per pixel, landing on multiples of `grain`, inside `min`–`max`. */
export interface ScrubSpec {
  readonly perPixel: number
  readonly grain: number
  readonly min?: number
  readonly max?: number
}

const decimalsOf = (grain: number): number => Math.max(0, Math.ceil(-Math.log10(grain) - 1e-9))

/**
 * Where a drag of `dx` pixels takes a number that started at `start`. Held Shift is ten times finer, and lands on
 * a tenth of the grain, the way Blender's and Unity's number fields behave.
 */
export const scrubbed = (start: number, dx: number, spec: ScrubSpec, fine = false): number => {
  const grain = fine ? spec.grain / 10 : spec.grain
  const raw = start + dx * spec.perPixel * (fine ? 0.1 : 1)
  const snapped = Math.round(raw / grain) * grain
  const clamped = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, snapped))
  return Number(clamped.toFixed(decimalsOf(grain))) + 0
}

/** What was typed, as a number: a real minus sign and a comma both accepted. `null` when it is not one. */
export const parseTyped = (text: string): number | null => {
  const t = text.trim().replace(/−/g, '-').replace(',', '.')
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** A number as a field shows it: at most three decimals, no trailing zeros. */
export const shownNumber = (v: number): string => String(Math.round(v * 1000) / 1000 + 0)

export interface ScrubFieldOptions {
  readonly value: number
  /** A short label inside the field, the handle you drag by: `X`, `Y`, `Z`. */
  readonly label?: string
  /** Colours the label as the axis does in the viewport. */
  readonly axis?: 'x' | 'y' | 'z'
  /** After the number: `s`, `°`, `%`. */
  readonly unit?: string
  readonly spec: ScrubSpec
  readonly title?: string
  /** The number as shown, from the one stored, and back — a 0–1 opacity shown as a percentage. */
  readonly toShown?: (v: number) => number
  readonly fromShown?: (v: number) => number
  readonly commit: (v: number) => void
  /**
   * Which field this is, stable across rebuilds (`<step>:point.x`). Typing into one field and clicking the next
   * commits the first, which rebuilds the panel; the key is how the new copy of the second takes the focus.
   */
  readonly key?: string
}

/** The field clicked for typing while another's edit rebuilt the panel under it. */
let refocus: string | null = null

/** Movement before a press becomes a drag, so a click still reaches the text. */
const DRAG_THRESHOLD = 3

/**
 * A number field: **drag it sideways** to change the number, **click it** to type. One edit when the drag ends
 * or the typing is done — not one per pixel, which would rebuild the panel under the pointer.
 */
export const scrubField = (o: ScrubFieldOptions): HTMLElement => {
  const toShown = o.toShown ?? ((v: number) => v)
  const fromShown = o.fromShown ?? ((v: number) => v)
  const shown = toShown(o.value)
  const root = el('div', `sf${o.axis === undefined ? '' : ` sf-${o.axis}`}`)
  if (o.title !== undefined) root.title = o.title
  if (o.label !== undefined) root.append(el('span', 'sf-l', o.label))
  const input = el('input', 'sf-v')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.spellcheck = false
  input.value = shownNumber(shown)
  root.append(input)
  if (o.unit !== undefined) root.append(el('span', 'sf-u', o.unit))

  // The rebuilt copy of the field just clicked: open it for typing, as the click asked.
  if (o.key !== undefined && refocus === o.key) {
    queueMicrotask(() => {
      if (!root.isConnected) return
      root.classList.add('editing')
      input.focus()
      input.select()
    })
  }

  const finish = (v: number): void => {
    if (Math.abs(v - shown) > 1e-12) o.commit(fromShown(v))
    else input.value = shownNumber(shown)
  }

  let press: { x: number; start: number; dragging: boolean; value: number } | null = null
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || root.classList.contains('editing')) return
    e.preventDefault()
    press = { x: e.clientX, start: parseTyped(input.value) ?? shown, dragging: false, value: shown }
    root.setPointerCapture?.(e.pointerId)
  })
  root.addEventListener('pointermove', (e) => {
    if (press === null) return
    const dx = e.clientX - press.x
    if (!press.dragging && Math.abs(dx) < DRAG_THRESHOLD) return
    if (!press.dragging) {
      press.dragging = true
      root.classList.add('scrubbing')
      document.body.classList.add('scrubbing')
    }
    press.value = scrubbed(press.start, dx, o.spec, e.shiftKey)
    input.value = shownNumber(press.value)
  })
  const release = (e: PointerEvent): void => {
    if (press === null) return
    const p = press
    press = null
    root.releasePointerCapture?.(e.pointerId)
    root.classList.remove('scrubbing')
    document.body.classList.remove('scrubbing')
    if (p.dragging) {
      finish(p.value)
      return
    }
    // A click: the text is yours.
    refocus = o.key ?? null
    root.classList.add('editing')
    input.focus()
    input.select()
  }
  root.addEventListener('pointerup', release)
  root.addEventListener('pointercancel', release)

  const typed = (): void => {
    root.classList.remove('editing')
    if (refocus === o.key) refocus = null
    const v = parseTyped(input.value)
    if (v === null) {
      input.value = shownNumber(shown)
      return
    }
    const clamped = Math.min(o.spec.max ?? Infinity, Math.max(o.spec.min ?? -Infinity, v))
    finish(clamped)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      input.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      input.value = shownNumber(shown)
      input.blur()
    }
  })
  input.addEventListener('blur', typed)
  return root
}

// --- a segmented switch --------------------------------------------------------------------------------

export interface Segment<T extends string> {
  readonly value: T
  readonly label: string
  readonly title?: string
}

/** One of a few, side by side, the chosen one lit. Choosing the one already chosen does nothing. */
export const segmented = <T extends string>(options: readonly Segment<T>[], value: T, pick: (v: T) => void): HTMLElement => {
  const root = el('div', 'seg')
  for (const o of options) {
    const b = el('button', `seg-b${o.value === value ? ' on' : ''}`, o.label)
    b.type = 'button'
    if (o.title !== undefined) b.title = o.title
    b.addEventListener('click', () => {
      if (o.value !== value) pick(o.value)
    })
    root.append(b)
  }
  return root
}

// --- a popover ------------------------------------------------------------------------------------------

/**
 * One popover for the editor, as there is one context menu (`menu.ts`): opening a second closes the first.
 * It hangs under what opened it, flips above when there is no room, and goes on a press elsewhere, Escape, a
 * resize, or a scroll outside it.
 */
let open: { root: HTMLElement; anchor: HTMLElement; onDismiss?: () => void } | null = null

/**
 * Close it. `dismissed` says it was the person — a press elsewhere, Escape — rather than the editor tidying up,
 * and only then does its `onDismiss` run.
 */
export const closePopover = (dismissed = false): void => {
  const was = open
  open = null
  if (was === null) return
  was.root.remove()
  if (dismissed) was.onDismiss?.()
}

export const popoverOpenFor = (anchor: HTMLElement): boolean => open !== null && open.anchor === anchor

export const openPopover = (anchor: HTMLElement, content: HTMLElement, opts: { readonly className?: string; readonly onDismiss?: () => void } = {}): HTMLElement => {
  closePopover()
  const root = el('div', `pop${opts.className === undefined ? '' : ` ${opts.className}`}`)
  root.append(content)
  root.style.visibility = 'hidden'
  document.body.append(root)
  const a = anchor.getBoundingClientRect()
  const r = root.getBoundingClientRect()
  const margin = 6
  const left = Math.max(margin, Math.min(a.left, window.innerWidth - r.width - margin))
  const below = a.bottom + 4
  const top = below + r.height + margin > window.innerHeight ? Math.max(margin, a.top - r.height - 4) : below
  root.style.left = `${Math.round(left)}px`
  root.style.top = `${Math.round(top)}px`
  root.style.visibility = 'visible'
  open = { root, anchor, ...(opts.onDismiss === undefined ? {} : { onDismiss: opts.onDismiss }) }
  return root
}

let installed = false
/** The dismissal listeners, once, the first time a popover is wanted. */
export const installPopoverDismissal = (): void => {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (open === null) return
      const t = e.target as Node
      if (!open.root.contains(t) && !open.anchor.contains(t)) closePopover(true)
    },
    true,
  )
  window.addEventListener('keydown', (e) => {
    if (open !== null && e.key === 'Escape') {
      e.stopPropagation()
      closePopover(true)
    }
  })
  window.addEventListener('resize', () => closePopover(true))
  window.addEventListener(
    'wheel',
    (e) => {
      if (open !== null && !open.root.contains(e.target as Node)) closePopover(true)
    },
    { passive: true, capture: true },
  )
}
