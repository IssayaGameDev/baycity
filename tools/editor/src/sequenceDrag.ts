import type { StepPlace } from './sequenceEdit'

/**
 * Dragging steps and stages (ADR 0147), on pointer events rather than the browser's drag and drop, which only
 * lands on the element under the pointer: a thin gap between two boxes had to be hit exactly.
 *
 * A press anywhere on a step's line or a stage's header starts it once the pointer has moved a few pixels, so
 * a click still opens the step. A copy follows the pointer, the original's place closes up, and a placeholder
 * opens where it would land — the **nearest** place, from the pointer's height alone, so nothing has to be hit.
 * The rows around it slide rather than jump, and the panel scrolls when the pointer reaches its edge. Escape
 * puts everything back.
 *
 * The decision is `placeFor`, pure, over measured boxes; the rest measures and moves elements.
 */

export interface DragSource {
  readonly kind: 'step' | 'stage'
  readonly id: string
  readonly node: number
  readonly componentId: string
}

/** Where a drop lands: a step into a stage or as a new stage of its own, or a stage before another. */
export type DropPlace = { readonly kind: 'step'; readonly place: StepPlace } | { readonly kind: 'stage'; readonly before?: string }

/** One editor's boxes, measured: each stage's span and its steps' middles, and the rail links between them. */
export interface DropLayout {
  readonly stages: readonly { readonly id: string; readonly top: number; readonly bottom: number; readonly steps: readonly { readonly id: string; readonly mid: number }[] }[]
  /** Between boxes, above the first and below the last: `before` is the stage after it, absent for the end. */
  readonly links: readonly { readonly before?: string; readonly top: number; readonly bottom: number }[]
}

const into = (stage: string, before: string | undefined): DropPlace => ({
  kind: 'step',
  place: before === undefined ? { kind: 'into', stage } : { kind: 'into', stage, before },
})
const newStage = (before: string | undefined): DropPlace => ({ kind: 'step', place: before === undefined ? { kind: 'new-stage' } : { kind: 'new-stage', before } })

/**
 * Where a pointer at height `y` drops what is being dragged. The layout leaves the dragged thing out.
 *
 * A **stage** goes before the first stage whose middle is below the pointer. A **step** joins the stage the
 * pointer is over, before the first of its steps whose middle is below; on a link between stages, or past the
 * ends, it becomes a stage of its own there. Never `null` while there is anywhere at all to go.
 */
export const placeFor = (kind: 'step' | 'stage', y: number, layout: DropLayout): DropPlace | null => {
  if (kind === 'stage') {
    const next = layout.stages.find((s) => (s.top + s.bottom) / 2 > y)
    return next === undefined ? { kind: 'stage' } : { kind: 'stage', before: next.id }
  }
  const link = layout.links.find((l) => y >= l.top && y <= l.bottom)
  if (link !== undefined) return newStage(link.before)
  const over = layout.stages.find((s) => y >= s.top && y <= s.bottom)
  if (over !== undefined) return into(over.id, over.steps.find((s) => s.mid > y)?.id)
  // Outside every box and link: a new stage at whichever end is nearer.
  const first = layout.stages[0]
  if (first === undefined) return newStage(undefined)
  return y < first.top ? newStage(first.id) : newStage(undefined)
}

// --- on screen ----------------------------------------------------------------------------------------

/** What an editor on screen offers a drag: where it is, whose it is, and what a drop there does. */
export interface DropTarget {
  readonly root: HTMLElement
  readonly node: number
  readonly componentId: string
  readonly drop: (source: DragSource, place: DropPlace) => void
}

const targets = new Map<HTMLElement, DropTarget>()

/** An editor offers itself as somewhere to drop. Forgotten once its element has left the page. */
export const registerDropTarget = (t: DropTarget): void => {
  for (const root of targets.keys()) if (!root.isConnected) targets.delete(root)
  targets.set(t.root, t)
}

/** The drop target an editor's element registered, for a test to drop onto directly. */
export const dropTargetOf = (root: HTMLElement): DropTarget | undefined => targets.get(root)

let clickSuppressedUntil = 0
/** A drag just ended on this press, so the click the browser sends after it is not a click. */
export const justDragged = (): boolean => performance.now() < clickSuppressedUntil

const THRESHOLD = 4
const EDGE = 36
const SLIDE_MS = 140

const measure = (root: HTMLElement, moving: HTMLElement): DropLayout => {
  const stages = [...root.querySelectorAll<HTMLElement>(':scope > .seq-card')]
    .filter((c) => c !== moving)
    .map((c) => {
      const r = c.getBoundingClientRect()
      const steps = [...c.querySelectorAll<HTMLElement>('.seq-step-w')]
        .filter((s) => s !== moving)
        .map((s) => {
          const sr = s.getBoundingClientRect()
          return { id: s.dataset.step ?? '', mid: (sr.top + sr.bottom) / 2 }
        })
      return { id: c.dataset.stage ?? '', top: r.top, bottom: r.bottom, steps }
    })
  const links = [...root.querySelectorAll<HTMLElement>(':scope > .seq-link')].map((l) => {
    const r = l.getBoundingClientRect()
    return { ...(l.dataset.before === undefined ? {} : { before: l.dataset.before }), top: r.top - 2, bottom: r.bottom + 2 }
  })
  return { stages, links }
}

/** Slide what moved from where it was: the FLIP trick, so a placeholder opening does not make rows jump. */
const slide = (root: HTMLElement, change: () => void): void => {
  const items = [...root.querySelectorAll<HTMLElement>('.seq-card, .seq-step-w, .seq-link')]
  const before = new Map(items.map((e) => [e, e.getBoundingClientRect().top]))
  change()
  for (const e of items) {
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
 * A press on a step's line or a stage's header: a drag if it moves, nothing if it does not. `element` is what
 * is carried — the step's wrapper, or the stage's box.
 */
export const pressToDrag = (e: PointerEvent, source: DragSource, element: HTMLElement): void => {
  if (e.button !== 0) return
  const home = element.closest<HTMLElement>('.seq')
  if (home === null) return
  const startX = e.clientX
  const startY = e.clientY
  let x = startX
  let y = startY
  let ghost: HTMLElement | null = null
  let placeholder: HTMLElement | null = null
  let offset = { x: 0, y: 0 }
  let last: { target: DropTarget; place: DropPlace } | null = null
  let lastKey = ''
  let frame = 0

  const begin = (): void => {
    const r = element.getBoundingClientRect()
    offset = { x: startX - r.left, y: startY - r.top }
    ghost = element.cloneNode(true) as HTMLElement
    ghost.classList.add('seq-ghost')
    ghost.style.width = `${r.width}px`
    document.body.append(ghost)
    placeholder = document.createElement('div')
    placeholder.className = source.kind === 'step' ? 'seq-ph' : 'seq-ph seq-ph-stage'
    placeholder.style.height = `${r.height}px`
    slide(home, () => {
      element.after(placeholder!)
      element.style.display = 'none'
    })
    document.body.classList.add('seq-dragging')
    frame = requestAnimationFrame(tick)
  }

  /** Put the placeholder where `place` says, in `root`. */
  const show = (root: HTMLElement, place: DropPlace): void => {
    const ph = placeholder
    if (ph === null) return
    const stageEl = (id: string | undefined): HTMLElement | null => (id === undefined ? null : root.querySelector<HTMLElement>(`:scope > .seq-card[data-stage="${CSS.escape(id)}"]`))
    const endLink = root.querySelector<HTMLElement>(':scope > .seq-link[data-end]')
    slide(root, () => {
      if (place.kind === 'stage') {
        ph.className = 'seq-ph seq-ph-stage'
        const next = stageEl(place.before)
        const link = next?.previousElementSibling
        ;(link instanceof HTMLElement && link.classList.contains('seq-link') ? link : (next ?? endLink))?.before(ph)
        return
      }
      if (place.place.kind === 'new-stage') {
        ph.className = 'seq-ph seq-ph-stage'
        const next = stageEl(place.place.before)
        ;(next ?? endLink)?.before(ph)
        return
      }
      ph.className = 'seq-ph'
      const card = stageEl(place.place.stage)
      const list = card?.querySelector<HTMLElement>('.seq-steps')
      if (list === null || list === undefined) return
      const before = place.place.before === undefined ? null : list.querySelector<HTMLElement>(`:scope > .seq-step-w[data-step="${CSS.escape(place.place.before)}"]`)
      if (before !== null) before.before(ph)
      else list.append(ph)
    })
  }

  const locate = (): void => {
    const under = document.elementFromPoint(x, y)?.closest<HTMLElement>('.seq') ?? null
    const target = under === null ? undefined : targets.get(under)
    if (target === undefined || target.node !== source.node) return
    const place = placeFor(source.kind, y, measure(target.root, element))
    if (place === null) return
    const key = `${target.componentId}|${JSON.stringify(place)}`
    last = { target, place }
    if (key === lastKey) return
    lastKey = key
    show(target.root, place)
  }

  const tick = (): void => {
    if (ghost === null) return
    ghost.style.transform = `translate(${x - offset.x}px, ${y - offset.y}px)`
    const scroller = scrollerOf(home)
    if (scroller !== null) {
      const r = scroller.getBoundingClientRect()
      const speed = y < r.top + EDGE ? -(r.top + EDGE - y) : y > r.bottom - EDGE ? y - (r.bottom - EDGE) : 0
      if (speed !== 0) scroller.scrollTop += Math.round(speed / 3)
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
    placeholder?.remove()
    element.style.display = ''
    document.body.classList.remove('seq-dragging')
    clickSuppressedUntil = performance.now() + 250
    const landed = last
    ghost = null
    if (drop && landed !== null && home.isConnected) landed.target.drop(source, landed.place)
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
