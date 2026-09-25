/**
 * Who is in which Inspector field (ADR 0160): this tab's, reported as it moves, and everyone else's, drawn as a
 * ring in their colour round the line's controls, their name on the line's hover.
 *
 * One mechanism for both Inspectors. A line is named by its card — `data-card` on the nearest element above it
 * that has one — and its label, `data-field`, which `fieldRow` sets. Every tab draws the same cards and labels
 * for the same thing, so the names agree without anything else being shared.
 *
 * **In a field** is the keyboard in it (typing, a dropdown, a picker open) or a pointer pressed on it (a number
 * being dragged, which takes no focus). Leaving is reported a moment late, so a press that moves into typing, or
 * a panel rebuilt under the focus, does not flicker the ring off and on for everyone else.
 */

/** A line of an Inspector: its card and its label. */
export interface Spot {
  card: string
  field: string
}

/** Someone else in a line, and their colour. */
export interface Ring extends Spot {
  name: string
  colour: string
}

export interface FieldPresenceHost {
  /** This tab went into a line, or out of every one (`null`). */
  report: (spot: Spot | null) => void
  /** The others in lines of what this panel shows now. */
  rings: () => readonly Ring[]
}

export interface FieldPresence {
  /** Draw the rings again: someone moved, or the panel shows something else. A rebuilt panel repaints itself. */
  repaint: () => void
}

/** How long leaving a field waits for the next one, so going from one to another is one move, not two. */
const LEAVE_MS = 150

/** The line an event landed in, inside `within`, or `null`. */
export const spotOf = (target: EventTarget | null, within: HTMLElement): Spot | null => {
  if (!(target instanceof Element) || !within.contains(target)) return null
  const line = target.closest<HTMLElement>('[data-field]')
  const card = line?.closest<HTMLElement>('[data-card]')
  if (line === null || line === undefined || card === null || card === undefined || !within.contains(card)) return null
  return { card: card.dataset.card ?? '', field: line.dataset.field ?? '' }
}

const same = (a: Spot | null, b: Spot | null): boolean => a === b || (a !== null && b !== null && a.card === b.card && a.field === b.field)

/** Who is in a line, in words: one name, or two joined. */
const who = (names: readonly string[]): string =>
  `${names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`} ${names.length === 1 ? 'is' : 'are'} in this field`

export const createFieldPresence = (container: HTMLElement, host: FieldPresenceHost): FieldPresence => {
  let pressed: Spot | null = null
  let focused: Spot | null = null
  let reported: Spot | null = null
  let leaving: ReturnType<typeof setTimeout> | null = null

  const update = (): void => {
    const now = pressed ?? focused
    if (now !== null) {
      if (leaving !== null) clearTimeout(leaving)
      leaving = null
      if (same(now, reported)) return
      reported = now
      host.report(now)
      return
    }
    if (reported === null || leaving !== null) return
    leaving = setTimeout(() => {
      leaving = null
      if (pressed !== null || focused !== null) return
      reported = null
      host.report(null)
    }, LEAVE_MS)
  }

  container.addEventListener(
    'pointerdown',
    (e) => {
      pressed = spotOf(e.target, container)
      update()
    },
    true,
  )
  const release = (): void => {
    if (pressed === null) return
    pressed = null
    update()
  }
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  container.addEventListener('focusin', (e) => {
    focused = spotOf(e.target, container)
    update()
  })
  container.addEventListener('focusout', (e) => {
    focused = spotOf(e.relatedTarget, container)
    update()
  })

  /** The lines ringed now, so the next paint takes theirs off first. */
  let ringed: HTMLElement[] = []
  const cardsNamed = (card: string): HTMLElement[] => {
    const sel = `[data-card="${CSS.escape(card)}"]`
    return [...(container.matches(sel) ? [container] : []), ...container.querySelectorAll<HTMLElement>(sel)]
  }
  const repaint = (): void => {
    // A rebuild took the focused field away without a focusout: the keyboard is no longer in it.
    if (focused !== null && !container.contains(document.activeElement)) {
      focused = null
      update()
    }
    for (const line of ringed) {
      line.classList.remove('peer-in')
      line.style.removeProperty('--peer')
      line.removeAttribute('title')
    }
    ringed = []
    const byLine = new Map<HTMLElement, Ring[]>()
    for (const ring of host.rings()) {
      for (const card of cardsNamed(ring.card)) {
        for (const line of card.querySelectorAll<HTMLElement>(`[data-field="${CSS.escape(ring.field)}"]`)) {
          // The nearest card is the one it belongs to: a card inside another names its own lines.
          if (line.closest('[data-card]') !== card) continue
          byLine.set(line, [...(byLine.get(line) ?? []), ring])
        }
      }
    }
    for (const [line, rings] of byLine) {
      line.classList.add('peer-in')
      line.style.setProperty('--peer', rings[0]!.colour)
      line.title = who(rings.map((r) => r.name))
      ringed.push(line)
    }
  }

  // The object Inspector rebuilds on most edits: its new lines are ringed as they arrive.
  let queued = false
  new MutationObserver(() => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      repaint()
    })
  }).observe(container, { childList: true, subtree: true })

  return { repaint }
}
