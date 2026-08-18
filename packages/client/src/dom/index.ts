import type { InputSource } from '../input'

import { createKeyboardInput } from './keyboard'
import { createTouchJoystick, type TouchInput } from './touch'

export { createKeyboardInput, type KeyboardInput } from './keyboard'
export {
  createTouchJoystick,
  DEFAULT_TOUCH_LAYOUT,
  type TouchInput,
  type TouchLayout,
  type TouchLook,
  type JoystickState,
  type JumpButtonState,
} from './touch'

export interface BrowserInput extends InputSource {
  /** The touch side, for the look/jump/pinch channels and the HUD state. `active()` is false until a
   * touch is actually seen, which is how a mode decides whether to draw controls at all (ADR 0022). */
  touch: TouchInput
  dispose: () => void
}

/**
 * Combined browser input: keyboard when a key is held, otherwise the touch stick. One `InputSource` for
 * movement, with the touch-only channels reachable through `touch`.
 *
 * Keyboard wins while a key is down so a hybrid device (a touch laptop, a tablet with a keyboard) never
 * has the two fight; releasing the key hands control straight back.
 */
export const createBrowserInput = (zone: HTMLElement): BrowserInput => {
  const keyboard = createKeyboardInput()
  const touch = createTouchJoystick(zone)
  return {
    movement: () => {
      const k = keyboard.movement()
      return k.x !== 0 || k.z !== 0 ? k : touch.movement()
    },
    touch,
    dispose: () => {
      keyboard.dispose()
      touch.dispose()
    },
  }
}
