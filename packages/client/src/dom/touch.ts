import type { InputSource } from '../input'

/** Visual state of the virtual joystick, for a HUD to draw. */
export interface JoystickState {
  active: boolean
  baseX: number
  baseY: number
  knobX: number
  knobY: number
  radius: number
}

export interface TouchInput extends InputSource {
  state: () => JoystickState
  dispose: () => void
}

/**
 * Virtual joystick over an element (touch or mouse drag). Movement is the knob
 * offset normalised by `radius`; screen-down maps to +z (matches the top-down demo).
 */
export const createTouchJoystick = (target: HTMLElement, radius = 60): TouchInput => {
  let active = false
  let baseX = 0
  let baseY = 0
  let knobX = 0
  let knobY = 0
  let pointerId = -1

  const local = (e: PointerEvent): { x: number; y: number } => {
    const r = target.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const down = (e: PointerEvent): void => {
    if (active) return
    active = true
    pointerId = e.pointerId
    const p = local(e)
    baseX = p.x
    baseY = p.y
    knobX = p.x
    knobY = p.y
    target.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent): void => {
    if (!active || e.pointerId !== pointerId) return
    const p = local(e)
    const dx = p.x - baseX
    const dy = p.y - baseY
    const len = Math.hypot(dx, dy)
    const scale = len > radius ? radius / len : 1
    knobX = baseX + dx * scale
    knobY = baseY + dy * scale
  }
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    active = false
    pointerId = -1
  }

  target.addEventListener('pointerdown', down)
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', end)
  target.addEventListener('pointercancel', end)

  return {
    movement: () => (active ? { x: (knobX - baseX) / radius, z: (knobY - baseY) / radius } : { x: 0, z: 0 }),
    state: () => ({ active, baseX, baseY, knobX, knobY, radius }),
    dispose: () => {
      target.removeEventListener('pointerdown', down)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
    },
  }
}
