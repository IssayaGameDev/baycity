import type { InputSource } from '../input'

import { createKeyboardInput } from './keyboard'
import { createTouchJoystick, type JoystickState } from './touch'

export { createKeyboardInput, type KeyboardInput } from './keyboard'
export { createTouchJoystick, type TouchInput, type JoystickState } from './touch'

export interface BrowserInput extends InputSource {
  joystick: () => JoystickState
  dispose: () => void
}

/**
 * Combined browser input: keyboard when a key is held, otherwise the virtual
 * joystick over `joystickZone`. One `InputSource` for the game to consume.
 */
export const createBrowserInput = (joystickZone: HTMLElement): BrowserInput => {
  const keyboard = createKeyboardInput()
  const touch = createTouchJoystick(joystickZone)
  return {
    movement: () => {
      const k = keyboard.movement()
      return k.x !== 0 || k.z !== 0 ? k : touch.movement()
    },
    joystick: () => touch.state(),
    dispose: () => {
      keyboard.dispose()
      touch.dispose()
    },
  }
}
