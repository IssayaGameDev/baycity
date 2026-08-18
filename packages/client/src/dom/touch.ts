import {
  createTouchControls,
  DEFAULT_TOUCH_LAYOUT,
  type JoystickState,
  type JumpButtonState,
  type TouchControls,
  type TouchLayout,
  type TouchLook,
} from '../touchControls'

export type { JoystickState, JumpButtonState, TouchLayout, TouchLook }
export { DEFAULT_TOUCH_LAYOUT }

export interface TouchInput extends TouchControls {
  /**
   * Stop or resume routing. Disabled, pointers are neither read nor suppressed, and anything held is
   * released — which is what a full-screen menu needs: its own widgets get their events untouched, a drag
   * across it does not swing the camera, and the character does not keep running while it is open.
   * `active()` is unaffected: the player is still on a touch device.
   */
  setEnabled: (on: boolean) => void
  dispose: () => void
}

export interface TouchBindOptions {
  /**
   * Elements whose pointers are none of our business — a debug pane, a DOM HUD. A pointer starting inside
   * one is ignored entirely, so that widget's own drags (a slider) still work and are not *also* read as a
   * look drag. The game's own canvases must not be listed.
   */
  ignore?: readonly HTMLElement[]
}

/**
 * Binds pointer events to `createTouchControls` (ADR 0022). All the rules live there and are tested
 * headlessly; this only translates events and suppresses what the browser would otherwise do with them.
 *
 * `target` supplies the coordinate frame — positions are its client rect offsets, matching what a HUD
 * drawn over it uses — and its size drives the zones.
 *
 * **Listens on `window`, not on `target`.** A game stacks a full-screen Pixi overlay above the 3D canvas to
 * catch UI taps, so a listener on the canvas itself never sees a touch — the overlay is on top and gets
 * them all. Window sees every event whatever the stacking order, and for touch the browser implicitly
 * captures a pointer to the element it started on, so a thumb sliding across the screen keeps reporting.
 */
export const createTouchJoystick = (
  target: HTMLElement,
  layout: TouchLayout = DEFAULT_TOUCH_LAYOUT,
  opts: TouchBindOptions = {},
): TouchInput => {
  const rectOf = (): DOMRect => target.getBoundingClientRect()
  const r0 = rectOf()
  const controls = createTouchControls(r0.width, r0.height, layout)

  /**
   * Anything that is not a mouse drives this. A mouse must not, or a desktop click in the bottom-left
   * corner steers the character while pointer-lock mouselook fights the look region. Everything else
   * counts: `touch` and `pen` are the same posture, and an empty `pointerType` — which some emulators
   * report — is far likelier to be a finger than a mouse that failed to identify itself.
   */
  const isTouch = (e: PointerEvent): boolean => e.pointerType !== 'mouse'

  /** Pointers belonging to someone else's UI are not ours to route, nor to suppress. */
  const ignored = (e: PointerEvent): boolean => {
    const node = e.target
    return node instanceof Node && (opts.ignore ?? []).some((el) => el.contains(node))
  }
  /** Ids we accepted, so a move or a release is only ours if the press was. */
  const mine = new Set<number>()
  let enabled = true

  const at = (e: PointerEvent): { x: number; y: number } => {
    const r = rectOf()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const down = (e: PointerEvent): void => {
    if (!enabled || !isTouch(e) || ignored(e)) return
    const p = at(e)
    controls.pointerDown(e.pointerId, p.x, p.y)
    mine.add(e.pointerId)
    // Only for pointers we took: stops the long-press menu, double-tap zoom and the synthetic mouse events
    // that trail a touch, while leaving the pause button and the debug pane behaving normally — which one
    // blanket preventDefault would break.
    if (e.cancelable) e.preventDefault()
  }
  const move = (e: PointerEvent): void => {
    if (!mine.has(e.pointerId)) return
    const p = at(e)
    controls.pointerMove(e.pointerId, p.x, p.y)
    if (e.cancelable) e.preventDefault()
  }
  const up = (e: PointerEvent): void => {
    if (!mine.delete(e.pointerId)) return
    controls.pointerUp(e.pointerId)
  }
  // A page hidden or blurred mid-drag never delivers the release, and the character would run forever.
  const release = (): void => {
    mine.clear()
    controls.releaseAll()
  }
  const resize = (): void => {
    const r = rectOf()
    controls.resize(r.width, r.height)
  }

  // Capture phase: we see a pointer before any widget can stop its propagation.
  window.addEventListener('pointerdown', down, { capture: true, passive: false })
  window.addEventListener('pointermove', move, { capture: true, passive: false })
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  window.addEventListener('blur', release)
  window.addEventListener('resize', resize)

  return {
    ...controls,
    setEnabled: (on) => {
      if (on === enabled) return
      enabled = on
      if (!on) release()
    },
    dispose: () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('blur', release)
      window.removeEventListener('resize', resize)
    },
  }
}
