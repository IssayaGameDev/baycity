import { keysToMovement, type InputSource } from '../input'

export interface KeyboardInput extends InputSource {
  dispose: () => void
}

/**
 * Keyboard/arrow-key movement source (browser). Tracks **physical key codes**
 * (`KeyboardEvent.code`), so it works regardless of layout (QWERTY/AZERTY/…).
 */
export const createKeyboardInput = (target: Window = window): KeyboardInput => {
  const codes = new Set<string>()
  const down = (e: KeyboardEvent): void => {
    if (e.code.startsWith('Arrow')) e.preventDefault()
    codes.add(e.code)
  }
  const up = (e: KeyboardEvent): void => {
    codes.delete(e.code)
  }
  target.addEventListener('keydown', down)
  target.addEventListener('keyup', up)
  return {
    movement: () => keysToMovement(codes),
    dispose: () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
    },
  }
}
