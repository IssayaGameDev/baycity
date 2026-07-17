import { keysToMovement, type InputSource } from '../input'

export interface KeyboardInput extends InputSource {
  dispose: () => void
}

/** Keyboard/arrow-key movement source (browser). */
export const createKeyboardInput = (target: Window = window): KeyboardInput => {
  const keys = new Set<string>()
  const down = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase()
    if (k.startsWith('arrow')) e.preventDefault()
    keys.add(k)
  }
  const up = (e: KeyboardEvent): void => {
    keys.delete(e.key.toLowerCase())
  }
  target.addEventListener('keydown', down)
  target.addEventListener('keyup', up)
  return {
    movement: () => keysToMovement(keys),
    dispose: () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
    },
  }
}
