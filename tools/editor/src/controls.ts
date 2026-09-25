/**
 * The editor's controls: a number you drag sideways to change, a tick box, a dropdown, a text and a colour
 * field, a segmented switch, and a popover. Our own DOM, in the editor's own look — the sequence editor's first
 * (ADR 0147), then every field in the Inspector (ADR 0152), which is what took Tweakpane out of the editor: its
 * widgets were a second visual language, and a narrow panel of mixed ones read as a developer's tool.
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

/**
 * How a number field drags, from what a declaration says (ADR 0113): a pixel is one `step`, landing on its
 * multiples; a bounded number without one crosses its range in 200 px, landing on the decade under that.
 *
 * The step shapes **the drag only**. Typed, any value in range is taken as it is — Tweakpane's `step` also
 * snapped what was typed, anchored to the value the field was built with, which made 33 unreachable from
 * 32.98 in steps of 0.05.
 */
export const numberScrub = (d: { readonly step?: number; readonly min?: number; readonly max?: number }): ScrubSpec => {
  const perPixel = d.step ?? (d.min !== undefined && d.max !== undefined ? (d.max - d.min) / 200 : 0.1)
  return {
    perPixel,
    grain: d.step ?? 10 ** Math.floor(Math.log10(perPixel)),
    ...(d.min === undefined ? {} : { min: d.min }),
    ...(d.max === undefined ? {} : { max: d.max }),
  }
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

/**
 * What a field reports while it is being dragged (a number) or picked (a colour), before it lets go: `start`
 * once, `move` with each new value, `end` always — changed or not, so a caller that opened something (one
 * history entry for the whole drag) closes it. The field's `commit` still runs after a drag that changed it.
 */
export interface Live<T> {
  readonly start: () => void
  readonly move: (v: T) => void
  readonly end: () => void
}

export interface ScrubFieldOptions {
  /**
   * `null` when a selection disagrees (ADR 0112): blank with a `—`, and typed only — a drag would need a
   * number to start from, and any one of theirs would be a claim about the others.
   */
  readonly value: number | null
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
  /** Report the drag as it goes, for a value the viewport should follow before the pointer lets go. */
  readonly live?: Live<number>
}

/** A number field that can be handed a new value from outside — the transform, which the gizmo moves. */
export interface ScrubHandle {
  readonly root: HTMLElement
  /** Show `v` (stored units), unless it is being dragged or typed in, which wins. */
  readonly set: (v: number) => void
}

/** The field clicked for typing while another's edit rebuilt the panel under it. */
let refocus: string | null = null

/** Movement before a press becomes a drag, so a click still reaches the text. */
const DRAG_THRESHOLD = 3

/**
 * A number field: **drag it sideways** to change the number, **click it** to type. One edit when the drag ends
 * or the typing is done — not one per pixel, which would rebuild the panel under the pointer. What the viewport
 * should show while dragging is `live`'s, which the caller keeps to one history entry.
 */
export const scrubField = (o: ScrubFieldOptions): HTMLElement => scrubFieldOf(o).root

export const scrubFieldOf = (o: ScrubFieldOptions): ScrubHandle => {
  const toShown = o.toShown ?? ((v: number) => v)
  const fromShown = o.fromShown ?? ((v: number) => v)
  let shown: number | null = o.value === null ? null : toShown(o.value)
  const root = el('div', `sf${o.axis === undefined ? '' : ` sf-${o.axis}`}${shown === null ? ' mixed' : ''}`)
  if (o.title !== undefined) root.title = o.title
  if (o.label !== undefined) root.append(el('span', 'sf-l', o.label))
  const input = el('input', 'sf-v')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.spellcheck = false
  const reset = (): void => {
    input.value = shown === null ? '' : shownNumber(shown)
    input.placeholder = shown === null ? '—' : ''
  }
  reset()
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

  /**
   * What the field now holds is the new number: a field whose edit does not rebuild the panel (a live one)
   * stays on screen, and must not revert to where it started on the next Escape.
   */
  const finish = (v: number): void => {
    if (shown !== null && Math.abs(v - shown) <= 1e-12) {
      reset()
      return
    }
    shown = v
    root.classList.remove('mixed')
    reset()
    o.commit(fromShown(v))
  }

  let press: { x: number; start: number; dragging: boolean; value: number } | null = null
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || root.classList.contains('editing')) return
    e.preventDefault()
    press = { x: e.clientX, start: shown === null ? 0 : (parseTyped(input.value) ?? shown), dragging: false, value: shown ?? 0 }
    root.setPointerCapture?.(e.pointerId)
  })
  root.addEventListener('pointermove', (e) => {
    // A mixed value has nothing to drag from: a press on it only opens it for typing.
    if (press === null || shown === null) return
    const dx = e.clientX - press.x
    if (!press.dragging && Math.abs(dx) < DRAG_THRESHOLD) return
    if (!press.dragging) {
      press.dragging = true
      root.classList.add('scrubbing')
      document.body.classList.add('scrubbing')
      o.live?.start()
    }
    const next = scrubbed(press.start, dx, o.spec, e.shiftKey)
    if (next === press.value) return
    press.value = next
    input.value = shownNumber(next)
    o.live?.move(fromShown(next))
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
      o.live?.end()
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

  /** Typed, it is clamped and **never snapped** to the drag's grain: every value in range can be reached (ADR 0113). */
  const typed = (): void => {
    root.classList.remove('editing')
    if (refocus === o.key) refocus = null
    const v = parseTyped(input.value)
    if (v === null) {
      reset()
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
      reset()
      input.blur()
    }
  })
  input.addEventListener('blur', typed)

  const set = (v: number): void => {
    if (press?.dragging === true || root.classList.contains('editing')) return
    shown = toShown(v)
    root.classList.remove('mixed')
    reset()
  }
  return { root, set }
}

// --- a labelled line --------------------------------------------------------------------------------------

/**
 * A line of the Inspector (ADR 0152): its label in the column `--lw` sets on the panel, then its controls — the
 * object Inspector's component cards and the asset Inspector alike. The label names the line (`data-field`) for
 * who is in which field (`fieldPresence.ts`, ADR 0160).
 */
export const fieldRow = (label: string, ...controls: HTMLElement[]): HTMLElement => {
  const line = el('div', 'irow')
  line.dataset.field = label
  const slot = el('div', 'irow-c')
  slot.append(...controls)
  line.append(el('span', 'irow-l', label), slot)
  return line
}

// --- a tick box, a dropdown, a text, a colour --------------------------------------------------------------

/** A tick box. `null` is a selection that disagrees (ADR 0112): drawn half-set, and a click sets every one. */
export const checkField = (value: boolean | null, pick: (on: boolean) => void, title?: string): HTMLInputElement => {
  const box = el('input', 'ck')
  box.type = 'checkbox'
  box.checked = value === true
  box.indeterminate = value === null
  if (title !== undefined) box.title = title
  box.addEventListener('change', () => pick(box.checked))
  return box
}

export interface Choice {
  readonly value: string
  readonly label: string
}

/**
 * A dropdown. `null` is a selection that disagrees: a `—` shows, and is not itself a choice, so every pick is
 * something to write.
 */
export const selectField = (choices: readonly Choice[], value: string | null, pick: (v: string) => void, title?: string): HTMLSelectElement => {
  const select = el('select', 'sel')
  if (title !== undefined) select.title = title
  if (value === null) {
    const blank = el('option', undefined, '—')
    blank.value = ''
    blank.disabled = true
    blank.hidden = true
    select.append(blank)
  }
  for (const c of choices) {
    const opt = el('option', undefined, c.label)
    opt.value = c.value
    select.append(opt)
  }
  if (value === null) select.selectedIndex = 0
  else select.value = value
  select.addEventListener('change', () => pick(select.value))
  return select
}

/** A line of text, written when it loses the focus or on Enter. `null` disagrees: blank, and blank writes nothing. */
export const textField = (value: string | null, commit: (v: string) => void, opts: { readonly placeholder?: string; readonly title?: string } = {}): HTMLInputElement => {
  const input = el('input', 'txt')
  input.type = 'text'
  input.spellcheck = false
  input.value = value ?? ''
  input.placeholder = value === null ? '—' : (opts.placeholder ?? '')
  if (opts.title !== undefined) input.title = opts.title
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur()
  })
  input.addEventListener('change', () => {
    if (value === null && input.value.trim() === '') return
    commit(input.value)
  })
  return input
}

const HEX = /^#?([0-9a-f]{6})$/i

/**
 * A colour, `#rrggbb`: a swatch that opens the browser's own picker, and the code to type. The picker reports
 * as it is dragged, through `live`, and settles on `change`. `null` disagrees: the code is blank.
 */
export const colorField = (value: string | null, commit: (v: string) => void, live?: Live<string>): HTMLElement =>
  colorFieldOf(value, commit, live).root

/** A colour field that can be handed a new value from outside — someone else's edit, on a panel that stays up. */
export interface ColorHandle {
  readonly root: HTMLElement
  /** Show `v`, unless the picker is open or the code is being typed, which wins. */
  readonly set: (v: string) => void
}

export const colorFieldOf = (value: string | null, commit: (v: string) => void, live?: Live<string>): ColorHandle => {
  const root = el('div', 'clr')
  const swatch = el('input', 'clr-s')
  swatch.type = 'color'
  swatch.value = value ?? '#000000'
  const code = el('input', 'clr-v')
  code.type = 'text'
  code.spellcheck = false
  code.value = value ?? ''
  code.placeholder = value === null ? '—' : ''
  let picking = false
  swatch.addEventListener('input', () => {
    code.value = swatch.value
    if (live === undefined) return
    if (!picking) {
      picking = true
      live.start()
    }
    live.move(swatch.value)
  })
  swatch.addEventListener('change', () => {
    code.value = swatch.value
    commit(swatch.value)
    if (picking) {
      picking = false
      live?.end()
    }
    // The picker closed: the keyboard goes back to the editor, so Ctrl+Z reaches it (a field owns its keys).
    swatch.blur()
  })
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') code.blur()
  })
  code.addEventListener('change', () => {
    const m = HEX.exec(code.value.trim())
    if (m === null) {
      code.value = value ?? ''
      return
    }
    const v = `#${m[1]!.toLowerCase()}`
    code.value = v
    swatch.value = v
    commit(v)
  })
  root.append(swatch, code)
  const set = (v: string): void => {
    if (picking || root.contains(document.activeElement)) return
    swatch.value = v
    code.value = v
    code.placeholder = ''
  }
  return { root, set }
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
