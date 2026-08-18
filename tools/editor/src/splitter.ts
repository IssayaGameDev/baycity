/**
 * Draggable panel dividers for the editor shell.
 *
 * A panel's size is one CSS custom property on the grid container (`--left`, `--right`, `--bottom`),
 * so a drag writes one style value and the browser re-lays out. Nothing measures or positions in JS,
 * which is why this is 40 lines instead of a docking library.
 */

/** A panel size after moving its divider, kept inside its own limits. */
export const clampSize = (current: number, delta: number, min: number, max: number): number =>
  Math.max(min, Math.min(Math.max(min, max), current + delta))

export interface SplitterOptions {
  /** The divider element. */
  handle: HTMLElement
  /** Which pointer axis moves it. */
  axis: 'x' | 'y'
  /**
   * `1` when dragging in the axis's positive direction *grows* the panel (a left panel), `-1` when it
   * shrinks it (a right or bottom panel, whose divider is on the side away from its own edge).
   */
  sign: 1 | -1
  read: () => number
  write: (px: number) => void
  min: number
  /** Evaluated per drag, since it depends on the window's current size. */
  max: () => number
  /** After a size change — the canvas needs to hear about it; the grid does not. */
  onChange?: () => void
}

export const createSplitter = (o: SplitterOptions): void => {
  let startPointer = 0
  let startSize = 0

  const move = (e: PointerEvent): void => {
    const now = o.axis === 'x' ? e.clientX : e.clientY
    o.write(clampSize(startSize, o.sign * (now - startPointer), o.min, o.max()))
    o.onChange?.()
  }

  const up = (e: PointerEvent): void => {
    o.handle.releasePointerCapture(e.pointerId)
    o.handle.removeEventListener('pointermove', move)
    o.handle.removeEventListener('pointerup', up)
    o.handle.classList.remove('dragging')
  }

  o.handle.addEventListener('pointerdown', (e) => {
    startPointer = o.axis === 'x' ? e.clientX : e.clientY
    startSize = o.read()
    // Capture on the handle: the pointer will leave a 5 px divider immediately, and without capture
    // the drag would end the moment it crossed into the canvas.
    o.handle.setPointerCapture(e.pointerId)
    o.handle.addEventListener('pointermove', move)
    o.handle.addEventListener('pointerup', up)
    o.handle.classList.add('dragging')
    e.preventDefault()
  })
}

/** Read a `--name` pixel custom property off an element. */
export const readPx = (el: HTMLElement, name: string): number =>
  Number.parseFloat(getComputedStyle(el).getPropertyValue(name)) || 0

/** Write a `--name` pixel custom property. */
export const writePx = (el: HTMLElement, name: string, px: number): void => {
  el.style.setProperty(name, `${Math.round(px)}px`)
}
