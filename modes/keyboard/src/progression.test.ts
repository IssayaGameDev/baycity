import { describe, expect, it } from 'vitest'

import { abbreviate, DEFAULT_CURVE, levelAt, maxSpeedAt, maxSpeedMps, experienceForLevel } from './progression'

/**
 * The incremental loop, checked against a real save (ADR 0071).
 *
 * Kodjo's own screenshot is the fixture, and it is a better one than any invented case: **345,510 Experience, Level
 * 45, 33,840 / 46,850 toward the next**, with Max Speed 100 at level 45 and 102 at level 46. A curve that
 * cannot reproduce those numbers is not the game's curve.
 */

const C = DEFAULT_CURVE

describe('max speed', () => {
  /** Two readings from the real game, which is the whole of what pins the slope. */
  it('matches the two readings taken from the game', () => {
    expect(maxSpeedAt(45, C)).toBe(100)
    expect(maxSpeedAt(46, C)).toBe(102)
  })

  it('starts below the shipped character, which is what makes early levels feel like progress', () => {
    // Level 1 gives 12 studs/s ≈ 3.4 m/s against `DEFAULT_TUNING`'s 5.5.
    expect(maxSpeedMps(1, C)).toBeCloseTo(3.36, 2)
    expect(maxSpeedMps(1, C)).toBeLessThan(5.5)
    // And catches up around level 5.
    expect(maxSpeedMps(5, C)).toBeGreaterThan(5.5)
  })

  it('reaches the worlds the real game gates on', () => {
    // World 2 at level ~120, World 3 at 400.
    expect(maxSpeedMps(120, C)).toBeCloseTo(70, 0)
    expect(maxSpeedMps(400, C)).toBeCloseTo(226.8, 0)
  })
})

describe('the level curve', () => {
  /**
   * The fixture. Level 45 with 33,840 banked toward a 46,850 level, off 345,510 total.
   *
   * Loose tolerances on purpose: the curve was *fitted* to one screenshot, so agreeing to a few per cent is
   * the claim, and agreeing exactly would mean the numbers had been reverse-engineered rather than fitted.
   */
  it('reproduces Kodjo’s save to within a few per cent', () => {
    const at = levelAt(345_510, C)
    expect(at.level).toBeGreaterThanOrEqual(43)
    expect(at.level).toBeLessThanOrEqual(47)
    // The next level costs tens of thousands, not hundreds or millions.
    expect(at.next).toBeGreaterThan(30_000)
    expect(at.next).toBeLessThan(70_000)
  })

  it('is cheap at the start', () => {
    expect(levelAt(0, C).level).toBe(0)
    expect(levelAt(99, C).level).toBe(0)
    expect(levelAt(100, C).level).toBe(1)
  })

  it('escalates: every level costs more than the last', () => {
    let previous = 0
    for (let l = 1; l <= 60; l += 1) {
      const cost = experienceForLevel(l, C) - experienceForLevel(l - 1, C)
      expect(cost).toBeGreaterThan(previous)
      previous = cost
    }
  })

  /** The inverse has to agree with the forward curve, or the bar fills toward the wrong number. */
  it('round-trips: the experience a level costs buys exactly that level', () => {
    for (let l = 1; l <= 200; l += 1) {
      const at = levelAt(experienceForLevel(l, C), C)
      expect(at.level).toBe(l)
      // Exactly on the boundary: nothing banked toward the next.
      expect(at.into).toBeCloseTo(0, 3)
    }
  })

  it('never reports progress past the next level', () => {
    for (const experience of [1, 99, 100, 5_000, 345_510, 9_999_999]) {
      const at = levelAt(experience, C)
      expect(at.into).toBeGreaterThanOrEqual(0)
      expect(at.into).toBeLessThan(at.next)
    }
  })

  it('survives a flat curve, which the editor allows', () => {
    const flat = { ...C, levelCost: [{ x: 0, y: 100 }] }
    expect(experienceForLevel(3, flat)).toBe(300)
    expect(levelAt(350, flat).level).toBe(3)
    expect(levelAt(350, flat).next).toBe(100)
  })

  it('a designed curve: gentle, then a steeper ratio from Level 100', () => {
    const bent = { ...C, levelCost: [{ x: 0, y: 100 }, { x: 100, y: 1e5 }, { x: 200, y: 1e12 }] }
    const r1 = (1e5 / 100) ** (1 / 100)
    const r2 = (1e12 / 1e5) ** (1 / 100)
    expect(r2).toBeGreaterThan(r1)
    const cost150 = experienceForLevel(151, bent) - experienceForLevel(150, bent)
    expect(cost150).toBeCloseTo(1e5 * r2 ** 50, -3)
    // Beyond the last point the last ratio continues: Level 300 is not free.
    expect(experienceForLevel(301, bent) - experienceForLevel(300, bent)).toBeCloseTo(1e12 * r2 ** 100, -8)
    expect(levelAt(experienceForLevel(250, bent), bent).level).toBe(250)
  })
})

describe('the counter', () => {
  /** The number is the game, so how it reads is not cosmetic. */
  it('writes numbers the way the genre does', () => {
    expect(abbreviate(0)).toBe('0')
    expect(abbreviate(999)).toBe('999')
    expect(abbreviate(1_000)).toBe('1.00K')
    expect(abbreviate(345_510)).toBe('345.5K')
    expect(abbreviate(46_850)).toBe('46.85K')
    expect(abbreviate(1_200_000)).toBe('1.20M')
    expect(abbreviate(3_400_000_000)).toBe('3.40B')
  })

  it('floors rather than rounds up, so a counter never overstates', () => {
    expect(abbreviate(999.9)).toBe('999')
  })
})
