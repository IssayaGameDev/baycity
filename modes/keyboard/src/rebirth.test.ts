import { describe, expect, it } from 'vitest'

import { DEFAULT_CURVE, multiplierText, rebirthLevelAt, rebirthMultiplierAt, shortAmount } from './progression'
import { rebirthView } from './rebirthWindow'

/** Rebirth (ADR 0221, Kodjo's calls): by the curves in the games window's Settings, the cost a Level and nothing else. */
describe('rebirth', () => {
  it('asks the Level the curve gives each rebirth, and carries on past the last point', () => {
    expect(rebirthLevelAt(1)).toBe(10)
    expect(rebirthLevelAt(2)).toBe(50)
    // Ratio segments extend: ×5 a rebirth, as from 10 to 50.
    expect(rebirthLevelAt(3)).toBe(250)
  })

  it('pays the curve’s multiplier after each rebirth, the whole of it, and nothing before the first', () => {
    expect(rebirthMultiplierAt(0)).toBe(1)
    expect(rebirthMultiplierAt(1)).toBe(2)
    expect(rebirthMultiplierAt(2), 'not ×2 × ×5').toBe(5)
    expect(rebirthMultiplierAt(3)).toBeCloseTo(12.5, 9)
  })

  it('reads its curves from the game’s settings', () => {
    const curve = { ...DEFAULT_CURVE, rebirthLevel: [{ x: 1, y: 340 }], rebirthMultiplier: [{ x: 1, y: 200_000 }] }
    expect(rebirthLevelAt(1, curve)).toBe(340)
    expect(rebirthMultiplierAt(1, curve)).toBe(200_000)
  })

  it('shows the Level needed, the multiplier now and after, and opens at the Level', () => {
    const short = rebirthView(4, 0, DEFAULT_CURVE)
    expect(short).toEqual({ level: 4, need: 10, now: 1, next: 2, ready: false, fraction: 0.4 })
    expect(rebirthView(10, 0, DEFAULT_CURVE).ready).toBe(true)
    expect(rebirthView(60, 1, DEFAULT_CURVE)).toEqual({ level: 60, need: 50, now: 2, next: 5, ready: true, fraction: 1 })
  })

  it('writes a multiplier and an amount the way the genre does', () => {
    expect(multiplierText(2)).toBe('×2')
    expect(multiplierText(12.5)).toBe('×12.5')
    expect(multiplierText(15_000)).toBe('×15.00K')
    expect(shortAmount(500)).toBe('500')
    expect(shortAmount(2500)).toBe('2.50K')
  })
})
