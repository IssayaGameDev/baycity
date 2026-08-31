import type { OrbitCamera } from '@mp/camera'
import { keysToMovement } from '@mp/client'
import { createTouchJoystick, DEFAULT_TOUCH_LAYOUT, type TouchInput, type TouchLayout } from '@mp/client/dom'
import { actionsHeld, type ActionBindings } from '@mp/mode'

/**
 * Everything the player presses: keyboard, mouse with pointer lock, wheel, and the touch controls of
 * ADR 0022.
 *
 * It sits between the DOM and the rest of the client so the camera can stay DOM-free (ADR 0056) — a mouse
 * delta becomes `camera.lookMouse`, a wheel tick becomes `camera.zoomNotch`, and nothing downstream learns
 * what a `PointerEvent` is. `worldMove` is here for the same reason: it is the one input that needs the
 * camera's yaw, and putting it anywhere else would mean exporting orbit state further than the one accessor.
 */
export interface Inputs {
  /** The touch controls. The render loop drains look and taps from these once per frame. */
  touch: TouchInput
  /** Live layout, so the debug pane and the safe-area pass both take effect without a rebuild. */
  layout: TouchLayout
  /** Held keys, by physical `code` — layout-independent, so WASD is WASD on AZERTY. */
  keys: Set<string>
  /**
   * Was a jump *pressed* since the last call, and clear it.
   *
   * A level read (`keys.has('Space')`) is not enough: at 30 Hz a tap pressed and released inside one 33 ms
   * tick never appears in it, and the press was silently thrown away. Auto-repeat is excluded, since holding
   * is already covered by the level read.
   */
  takeJump: () => boolean
  /** Camera-relative world-space move direction from WASD/arrows, or the stick. */
  worldMove: () => { x: number; z: number }
  /**
   * The game's own actions that are held right now, by name (ADR 0061).
   *
   * Built from the bindings the game declared (`ModeDescriptor.actions`), so this module maps keys to names
   * and never learns what a name means. Empty for a game that declared none.
   */
  actions: () => ReadonlySet<string>
  /** UI that owns its own pointers, so dragging a slider is not also a camera swing. */
  ignore: (el: HTMLElement) => void
  /**
   * Release every listener this took on `window`, `document` and the canvas.
   *
   * There are seven, and they are part of why a client could not be torn down: they outlive the canvas they
   * were bound for, so a second `createInputs` on the same page would have the first one's handlers still
   * moving the first one's camera (ADR 0065).
   */
  dispose: () => void
}

export interface InputsOptions {
  canvas: HTMLCanvasElement
  camera: OrbitCamera
  /** Whether the player is dead — a click respawns, and only during locked play. */
  isDead: () => boolean
  onRespawn: () => void
  /**
   * The game's action bindings: action name → the physical `code`s that hold it (ADR 0061).
   *
   * Physical codes, like `keys`, so a binding means the same key on any layout. Absent means this game has no
   * actions of its own beyond move and jump, which is every game the stack ships.
   */
  actions?: ActionBindings
}

/** A CSS custom property as a number, for the safe-area insets the page publishes. */
const px = (name: string): number =>
  Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0

export const createInputs = ({ canvas, camera, isDead, onRespawn, actions: bindings }: InputsOptions): Inputs => {
  /**
   * Touch controls (ADR 0022): stick bottom-left, jump bottom-right, look everywhere else. Bound to the
   * canvas, so its rect is the coordinate frame the HUD draws in. `active()` stays false until a real touch
   * arrives, which is what keeps a mouse user from ever seeing a joystick.
   *
   * Deep-copied, not spread: `stickInset`/`jumpInset` are objects, and a shallow copy would share them with
   * the exported default — mutating one here would then move every future game's controls.
   */
  const layout: TouchLayout = {
    ...DEFAULT_TOUCH_LAYOUT,
    stickInset: { ...DEFAULT_TOUCH_LAYOUT.stickInset },
    jumpInset: { ...DEFAULT_TOUCH_LAYOUT.jumpInset },
    stickZone: { ...DEFAULT_TOUCH_LAYOUT.stickZone },
  }
  /** Read per event, so pushing to it after the fact is enough. */
  const ignored: HTMLElement[] = []
  const touch = createTouchJoystick(canvas, layout, { ignore: ignored })

  /**
   * Push the controls clear of a notch and the home indicator. `viewport-fit=cover` lets the canvas reach
   * under both, so the insets have to come back here — in landscape, which is how this is held, the big ones
   * are left and right. Re-read on resize because an orientation change changes which edge they are on.
   */
  const applySafeArea = (): void => {
    layout.stickInset.x = DEFAULT_TOUCH_LAYOUT.stickInset.x + px('--safe-left')
    layout.jumpInset.x = DEFAULT_TOUCH_LAYOUT.jumpInset.x + px('--safe-right')
    const bottom = px('--safe-bottom')
    layout.stickInset.y = DEFAULT_TOUCH_LAYOUT.stickInset.y + bottom
    layout.jumpInset.y = DEFAULT_TOUCH_LAYOUT.jumpInset.y + bottom
  }
  applySafeArea()

  /**
   * Every listener, paired with the call that removes it.
   *
   * Collected at the point of adding rather than removed one by one at the end, because
   * `removeEventListener` matches on (type, function, options) — a re-declared inline arrow silently fails to
   * match and the listener stays for ever.
   */
  const bound: (() => void)[] = []
  const on = <K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement,
    type: K,
    handler: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void => {
    const listener = handler as EventListener
    target.addEventListener(type, listener, opts)
    bound.push(() => target.removeEventListener(type, listener, opts))
  }

  on(window, 'resize', applySafeArea)

  on(canvas, 'click', () => {
    // Never on touch: there is no pointer lock on mobile, and asking for it on every tap throws.
    if (!touch.active() && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
  })
  // Left click respawns while dead — but only during locked play, so the click that *re-captures* the mouse
  // after the pause menu does not also cut a death short. The touch equivalent is a tap in the look region,
  // drained in the render loop (ADR 0022).
  on(canvas, 'mousedown', (e) => {
    if (e.button === 0 && isDead() && document.pointerLockElement === canvas) onRespawn()
  })
  on(window, 'mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return
    camera.lookMouse(e.movementX, e.movementY)
  })
  // Wheel zoom, gated on pointer lock: scrolling the debug pane with the mouse free must not move the camera.
  on(
    window,
    'wheel',
    (e) => {
      if (document.pointerLockElement !== canvas) return
      e.preventDefault()
      camera.zoomNotch(Math.sign(e.deltaY))
    },
    { passive: false },
  )

  const keys = new Set<string>()
  let jumpLatch = false
  on(window, 'keydown', (e) => {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
    if (e.code === 'Space' && !e.repeat) jumpLatch = true
    keys.add(e.code)
  })
  on(window, 'keyup', (e) => {
    keys.delete(e.code)
  })

  return {
    touch,
    layout,
    keys,
    takeJump: () => {
      const pressed = jumpLatch
      jumpLatch = false
      return pressed
    },
    worldMove: () => {
      // Keyboard first, stick otherwise: on a hybrid device the two must never fight, and releasing the key
      // hands control straight back. Both produce the same `{x, z}` in −1..1, so the camera-relative rotation
      // below is shared — a stick pushed left strafes left and the character turns to face it, exactly like A.
      const k = keysToMovement(keys)
      const stick = touch.movement()
      const { x: rawX, z: rawZ } = k.x !== 0 || k.z !== 0 ? k : stick
      if (rawX === 0 && rawZ === 0) return { x: 0, z: 0 }
      const facing = camera.yaw()
      const fwdX = -Math.sin(facing)
      const fwdZ = -Math.cos(facing)
      const rightX = -fwdZ
      const rightZ = fwdX
      let x = fwdX * -rawZ + rightX * rawX
      let z = fwdZ * -rawZ + rightZ * rawX
      const len = Math.hypot(x, z)
      if (len > 1) {
        x /= len
        z /= len
      }
      return { x, z }
    },
    // Shared with the editor's play-test (`@mp/mode`), so one game's controls mean one thing in both.
    actions: () => actionsHeld(bindings, keys),
    ignore: (el) => {
      ignored.push(el)
    },
    dispose: () => {
      for (const off of bound) off()
      bound.length = 0
      touch.dispose()
      // Held keys go too. A client torn down mid-stride left `keys` populated, and anything still holding the
      // set would read a key that can never be released now the listener that clears it is gone.
      keys.clear()
    },
  }
}
