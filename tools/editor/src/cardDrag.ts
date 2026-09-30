import type { OutsideTarget } from './hierarchyDrag'
import { icon, type IconName } from './icons'

/**
 * Reordering a node's components by dragging a card by its header (ADR 0152) — the stage cards' drag
 * (ADR 0147, `sequenceDrag.ts`) over one flat list. A press becomes a drag after a few pixels, so a click still
 * opens or shuts the card; a copy follows the pointer, a placeholder opens at the **nearest** place from the
 * pointer's height alone, the cards around it slide, the panel scrolls at its edge, and Escape puts it back.
 *
 * Only cards marked `.movable` take part: the Transform is not a component, and a component a prefab owns is
 * in the prefab's list, which a placement cannot reorder (ADR 0038). Any component's card can be dropped on a
 * reference field that takes it, movable or not (ADR 0177).
 *
 * The decision is `slotFor`, pure; the rest measures and moves elements.
 */

/** Where a card dropped at height `y` lands among the others: before the first whose middle is below it. */
export const slotFor = (y: number, mids: readonly number[]): number => {
  const i = mids.findIndex((m) => m > y)
  return i < 0 ? mids.length : i
}

let clickSuppressedUntil = 0
/** A drag just ended on this press, so the click the browser sends after it is not a click. */
export const cardJustDragged = (): boolean => performance.now() < clickSuppressedUntil

const THRESHOLD = 4
const EDGE = 36
const SLIDE_MS = 140

/** Slide what moved from where it was (FLIP), so a placeholder opening does not make cards jump. */
const slide = (cards: readonly HTMLElement[], change: () => void): void => {
  const before = new Map(cards.map((e) => [e, e.getBoundingClientRect().top]))
  change()
  for (const e of cards) {
    const was = before.get(e)
    if (was === undefined || !e.isConnected) continue
    const dy = was - e.getBoundingClientRect().top
    if (Math.abs(dy) < 0.5) continue
    e.style.transition = 'none'
    e.style.transform = `translateY(${dy}px)`
    requestAnimationFrame(() => {
      e.style.transition = `transform ${SLIDE_MS}ms ease`
      e.style.transform = ''
    })
  }
}

const scrollerOf = (e: HTMLElement): HTMLElement | null => {
  for (let at: HTMLElement | null = e.parentElement; at !== null; at = at.parentElement) {
    const o = getComputedStyle(at).overflowY
    if ((o === 'auto' || o === 'scroll') && at.scrollHeight > at.clientHeight) return at
  }
  return null
}

/** What a card's drag can do besides reorder: be dropped on something that takes it (ADR 0177). */
export interface CardDragOptions {
  /**
   * Reorder: the card's place among the movable cards before and after, called only when they differ. Absent for a
   * card that cannot move — a prefab's component, several objects selected — which can still be dropped on a field.
   */
  readonly drop?: (from: number, to: number) => void
  /** What is under the pointer that takes this card — an Inspector reference field — or `null`. */
  readonly outside?: (x: number, y: number) => OutsideTarget | null
  /** What the small copy says while the card is over such a target, or cannot move: its icon and name. */
  readonly label: { readonly icon: IconName; readonly text: string }
}

/**
 * A press on a card's header: a drag if it moves, nothing if it does not.
 *
 * Over the cards, a movable card reorders (`drop`). Over a reference field (`outside`), it is a link, as dragging a
 * component's header is in Unity (ADR 0177): the card goes back to its place, a small copy with its icon and name
 * follows the pointer, and the field lights or greys; dropped there, the field takes it and nothing moves.
 */
export const pressCardToDrag = (e: PointerEvent, card: HTMLElement, opts: CardDragOptions): void => {
  if (e.button !== 0) return
  const list = card.parentElement
  if (list === null) return
  const movable = [...list.querySelectorAll<HTMLElement>(':scope > .isec.movable')]
  const from = movable.indexOf(card)
  const others = movable.filter((c) => c !== card)
  const reorders = opts.drop !== undefined && from >= 0 && others.length > 0
  if (!reorders && opts.outside === undefined) return
  const startX = e.clientX
  const startY = e.clientY
  let y = startY
  let x = startX
  let ghost: HTMLElement | null = null
  let chip: HTMLElement | null = null
  let placeholder: HTMLElement | null = null
  let offset = { x: 0, y: 0 }
  let slot = from
  let frame = 0
  let started = false
  /** The target under the pointer, and whether it takes the card. */
  let aside: { target: OutsideTarget; ok: boolean } | null = null

  const begin = (): void => {
    started = true
    chip = document.createElement('div')
    chip.className = 'hier-ghost'
    chip.append(icon(opts.label.icon))
    const name = document.createElement('span')
    name.textContent = opts.label.text
    chip.append(name)
    document.body.append(chip)
    document.body.classList.add('card-dragging')
    if (reorders) {
      const r = card.getBoundingClientRect()
      offset = { x: startX - r.left, y: startY - r.top }
      ghost = card.cloneNode(true) as HTMLElement
      ghost.classList.add('isec-ghost')
      ghost.style.width = `${r.width}px`
      document.body.append(ghost)
      placeholder = document.createElement('div')
      placeholder.className = 'isec-ph'
      placeholder.style.height = `${r.height}px`
      slide(others, () => {
        card.after(placeholder!)
        card.style.display = 'none'
      })
    }
    frame = requestAnimationFrame(tick)
  }

  /** Put the placeholder where the card would land: slot `next` among the others. */
  const place = (next: number): void => {
    const ph = placeholder
    if (ph === null || next === slot) return
    slot = next
    slide(others, () => {
      const before = others[next]
      if (before !== undefined) before.before(ph)
      else others.at(-1)!.after(ph)
    })
  }

  const locate = (): void => {
    // Asked only when the target changes: what it says about this card does not change while the pointer rests on it.
    const target = opts.outside?.(x, y) ?? null
    if (aside !== null && aside.target.key !== target?.key) {
      aside.target.leave()
      aside = null
    }
    if (target !== null && aside === null) aside = { target, ok: target.offer() }
    const linking = aside !== null || !reorders
    // By style, not `hidden`: both copies set their own `display`, which beats the attribute.
    if (ghost !== null) ghost.style.display = linking ? 'none' : ''
    if (chip !== null) chip.style.display = linking ? '' : 'none'
    if (!reorders) return
    if (aside !== null) return place(from)
    place(
      slotFor(
        y,
        others.map((c) => {
          const r = c.getBoundingClientRect()
          return (r.top + r.bottom) / 2
        }),
      ),
    )
  }

  const tick = (): void => {
    if (!started) return
    if (ghost !== null) ghost.style.transform = `translate(${x - offset.x}px, ${y - offset.y}px)`
    if (chip !== null) chip.style.transform = `translate(${x + 12}px, ${y + 8}px)`
    const scroller = scrollerOf(list)
    if (scroller !== null) {
      const r = scroller.getBoundingClientRect()
      const speed = y < r.top + EDGE ? -(r.top + EDGE - y) : y > r.bottom - EDGE ? y - (r.bottom - EDGE) : 0
      if (speed !== 0) scroller.scrollTop += Math.round(speed / 3)
    }
    locate()
    frame = requestAnimationFrame(tick)
  }

  const end = (dropped: boolean): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    if (!started) return
    started = false
    cancelAnimationFrame(frame)
    ghost?.remove()
    chip?.remove()
    placeholder?.remove()
    ghost = null
    chip = null
    card.style.display = ''
    document.body.classList.remove('card-dragging')
    clickSuppressedUntil = performance.now() + 250
    const off = aside
    aside = null
    if (off !== null) {
      if (dropped && off.ok) off.target.take()
      else off.target.leave()
      return
    }
    if (dropped && reorders && slot !== from && card.isConnected) opts.drop?.(from, slot)
  }
  const move = (m: PointerEvent): void => {
    x = m.clientX
    y = m.clientY
    if (!started && Math.hypot(x - startX, y - startY) >= THRESHOLD) begin()
    if (started) locate()
  }
  const up = (): void => end(true)
  const cancel = (): void => end(false)
  const key = (k: KeyboardEvent): void => {
    if (k.key !== 'Escape' || !started) return
    k.stopPropagation()
    end(false)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
}
