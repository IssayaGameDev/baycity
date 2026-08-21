import { describe, expect, it } from 'vitest'

import { CAMERA_TUNABLES, DEFAULT_CAMERA_PARAMS } from './index'

/**
 * The tunables are data so this package never learns what a Tweakpane is, and the price of that is a list
 * that can drift from the parameters it names. This is the guard.
 */
describe('the tunables', () => {
  it('names only real parameters', () => {
    for (const t of CAMERA_TUNABLES) {
      expect(DEFAULT_CAMERA_PARAMS, t.key).toHaveProperty(t.key)
      expect(typeof DEFAULT_CAMERA_PARAMS[t.key], t.key).toBe('number')
    }
  })

  it('names each one once', () => {
    const keys = CAMERA_TUNABLES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('brackets every default inside its own range', () => {
    for (const t of CAMERA_TUNABLES) {
      const value = DEFAULT_CAMERA_PARAMS[t.key]
      expect(value, `${t.key} starts outside its slider`).toBeGreaterThanOrEqual(t.min)
      expect(value, `${t.key} starts outside its slider`).toBeLessThanOrEqual(t.max)
    }
  })

  // `camZoom` is the live value, moved by the wheel rather than by a slider, and its range is two other
  // tunables. A slider for it would fight the wheel.
  it('leaves the zoom itself off the list', () => {
    expect(CAMERA_TUNABLES.map((t) => t.key)).not.toContain('camZoom')
  })
})
