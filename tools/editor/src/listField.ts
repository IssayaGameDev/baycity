import { defaultsOf, type ParamDecls, type ParamSpec } from '@mp/components'

import { slotFor } from './cardDrag'
import { checkField, colorFieldOf, numberScrub, scrubFieldOf, selectField, textField } from './controls'
import { icon } from './icons'

/**
 * A list field (ADR 0182): Unity's serialized array of a struct, drawn as rows. A header names the row's fields once;
 * each row holds its fields side by side, a grip to drag it to another place, and ✕ to take it out; **Add** puts a
 * new row at the end, at the row's defaults. Every edit writes the whole list, so a row's other fields and the other
 * rows are kept as they are now.
 *
 * A row's fields are the plain kinds — number, bool, string, colour (an optional one with an **auto** box) and
 * enum; any other kind is the host's to draw (`cellFor`, a reference column, ADR 0222), else `—`.
 */

type Row = Readonly<Record<string, unknown>>

export interface ListFieldOptions {
  /** The row's fields. */
  readonly item: ParamDecls
  readonly value: readonly Row[]
  readonly title: string
  /** Write the whole list; `ongoing` while a row's number or colour is still being dragged. */
  readonly write: (rows: Row[], ongoing?: boolean) => void
  /** A drag let go: end its undo entry, writing nothing. */
  readonly settle: () => void
  /**
   * A field of a kind this list does not draw — a reference (ADR 0222): the host's control for row `n`'s `value`,
   * writing through `put`; `rows` is the list as it is. `null`, or absent, shows `—`.
   */
  readonly cellFor?: (n: number, key: string, spec: ParamSpec, value: unknown, put: (v: unknown) => void, rows: readonly Row[]) => HTMLElement | null
  /** The **Add** button, handed to the host with a way to append a row over the defaults — a drop on it, for one. */
  readonly onAddButton?: (add: HTMLElement, append: (row: Row) => void) => void
}

export interface ListField {
  readonly root: HTMLElement
  /** Show a list changed elsewhere, unless one of its fields is being worked in. */
  readonly set: (rows: readonly Row[]) => void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export const listField = (o: ListFieldOptions): ListField => {
  const root = el('div', 'lf')
  root.title = o.title
  const keys = Object.keys(o.item)
  root.style.setProperty('--lf-cols', String(keys.length))
  /** The list as last written or shown: what the next edit is made on. */
  let held: Row[] = [...o.value]
  let dragging = false

  const head = el('div', 'lf-head')
  head.append(el('span', 'lf-gap'))
  for (const key of keys) head.append(el('span', 'lf-h', o.item[key]!.label ?? key))
  head.append(el('span', 'lf-gap'))
  const rows = el('div', 'lf-rows')
  const add = el('button', 'lf-add')
  add.type = 'button'
  add.append(icon('plus'), el('span', undefined, 'Add'))
  add.addEventListener('click', () => commit([...held, { ...defaultsOf(o.item) }]))
  root.append(head, rows, add)
  o.onAddButton?.(add, (row) => commit([...held, { ...defaultsOf(o.item), ...row }]))

  const commit = (next: Row[], ongoing = false): void => {
    held = next
    o.write(next, ongoing)
    if (!ongoing) draw()
  }

  /** One field of one row, writing the row back into the list. */
  const cell = (n: number, key: string, spec: ParamSpec): HTMLElement => {
    const value = held[n]?.[key]
    const put = (v: unknown, ongoing = false): void => commit(held.map((r, i) => (i === n ? { ...r, [key]: v } : r)), ongoing)
    const live = { start: () => undefined, end: o.settle }
    const label = spec.label ?? key
    switch (spec.kind) {
      case 'number':
        return scrubFieldOf({
          value: typeof value === 'number' ? value : spec.default,
          spec: numberScrub(spec),
          title: label,
          commit: (v) => put(v),
          live: { ...live, move: (v) => put(v, true) },
        }).root
      case 'bool':
        return checkField(value === true, (on) => put(on), label)
      case 'string':
        return textField(typeof value === 'string' ? value : spec.default, (v) => put(v), { title: label })
      case 'enum':
        return selectField(spec.options.map((x) => ({ value: x, label: x })), typeof value === 'string' ? value : spec.default, (v) => put(v), label)
      case 'color': {
        const shown = typeof value === 'string' && value !== '' ? value : spec.default !== '' ? spec.default : '#808080'
        const swatch = colorFieldOf(shown, (v) => put(v), { ...live, move: (v) => put(v, true) })
        if (spec.optional !== true) return swatch.root
        // Optional (ADR 0182): ticked is auto — the colour left to whoever reads it — and the swatch steps back.
        const box = el('label', 'lf-auto')
        const auto = checkField(value === '' || value === undefined, (on) => put(on ? '' : shown), `${label}: auto`)
        box.append(auto, el('span', undefined, 'auto'))
        const wrap = el('span', 'lf-opt')
        wrap.classList.toggle('is-auto', auto.checked)
        wrap.append(box, swatch.root)
        return wrap
      }
      default:
        return o.cellFor?.(n, key, spec, value, (v) => put(v), held) ?? el('span', 'lf-none', '—')
    }
  }

  /** Drag a row by its grip to another place: where it lands is the first row whose middle is below the pointer. */
  const grab = (e: PointerEvent, n: number, row: HTMLElement): void => {
    if (e.button !== 0) return
    e.preventDefault()
    dragging = true
    row.classList.add('lf-moving')
    const others = (): number[] =>
      [...rows.children].filter((r) => r !== row).map((r) => {
        const b = r.getBoundingClientRect()
        return (b.top + b.bottom) / 2
      })
    let to = n
    const move = (m: PointerEvent): void => {
      to = slotFor(m.clientY, others())
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragging = false
      row.classList.remove('lf-moving')
      if (to === n) return
      const next = held.filter((_, i) => i !== n)
      next.splice(to, 0, held[n]!)
      commit(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const draw = (): void => {
    rows.replaceChildren()
    held.forEach((_, n) => {
      const row = el('div', 'lf-row')
      const grip = el('span', 'lf-grip')
      grip.title = 'Drag to reorder'
      grip.append(icon('grip'))
      grip.addEventListener('pointerdown', (e) => grab(e, n, row))
      row.append(grip)
      for (const key of keys) row.append(cell(n, key, o.item[key]!))
      const remove = el('button', 'lf-x')
      remove.type = 'button'
      remove.title = 'Remove this row'
      remove.append(icon('close'))
      remove.addEventListener('click', () => commit(held.filter((_, i) => i !== n)))
      row.append(remove)
      rows.append(row)
    })
    if (held.length === 0) rows.append(el('div', 'lf-empty', 'empty'))
  }
  draw()

  return {
    root,
    set: (next) => {
      held = [...next]
      // Someone else's change waits while a field here is being worked in or a row is being dragged.
      if (dragging || root.contains(document.activeElement)) return
      draw()
    },
  }
}
