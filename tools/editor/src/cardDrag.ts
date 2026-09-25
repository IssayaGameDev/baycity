/**
 * Reordering a node's components by dragging a card by its header (ADR 0152) — the stage cards' drag
 * (ADR 0147, `sequenceDrag.ts`) over one flat list. A press becomes a drag after a few pixels, so a click still
 * opens or shuts the card; a copy follows the pointer, a placeholder opens at the **nearest** place from the
 * pointer's height alone, the cards around it slide, the panel scrolls at its edge, and Escape puts it back.
 *
 * Only cards marked `.movable` take part: the Transform is not a component, and a component a prefab owns is
 * in the prefab's list, which a placement cannot reorder (ADR 0038).
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

/**
 * A press on a card's header: a drag if it moves, nothing if it does not. `drop(from, to)` gets the card's place
 * among the movable cards before and after, and is called only when they differ.
 */
export const pressCardToDrag = (e: PointerEvent, card: HTMLElement, drop: (from: number, to: number) => void): void => {
  if (e.button !== 0) return
  const list = card.parentElement
  if (list === null) return
  const movable = [...list.querySelectorAll<HTMLElement>(':scope > .isec.movable')]
  const from = movable.indexOf(card)
  const others = movable.filter((c) => c !== card)
  if (from < 0 || others.length === 0) return
  const startX = e.clientX
  const startY = e.clientY
  let y = startY
  let x = startX
  let ghost: HTMLElement | null = null
  let placeholder: HTMLElement | null = null
  let offset = { x: 0, y: 0 }
  let slot = from
  let frame = 0

  const begin = (): void => {
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
    document.body.classList.add('card-dragging')
    frame = requestAnimationFrame(tick)
  }

  const locate = (): void => {
    const ph = placeholder
    if (ph === null) return
    const next = slotFor(
      y,
      others.map((c) => {
        const r = c.getBoundingClientRect()
        return (r.top + r.bottom) / 2
      }),
    )
    if (next === slot) return
    slot = next
    slide(others, () => {
      const before = others[next]
      if (before !== undefined) before.before(ph)
      else others.at(-1)!.after(ph)
    })
  }

  const tick = (): void => {
    if (ghost === null) return
    ghost.style.transform = `translate(${x - offset.x}px, ${y - offset.y}px)`
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
    if (ghost === null) return
    cancelAnimationFrame(frame)
    ghost.remove()
    placeholder?.remove()
    card.style.display = ''
    document.body.classList.remove('card-dragging')
    clickSuppressedUntil = performance.now() + 250
    ghost = null
    if (dropped && slot !== from && card.isConnected) drop(from, slot)
  }
  const move = (m: PointerEvent): void => {
    x = m.clientX
    y = m.clientY
    if (ghost === null && Math.hypot(x - startX, y - startY) >= THRESHOLD) begin()
    locate()
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
