import { describe, expect, it } from 'vitest'

import { clockOf, differenceOf, verdictOf } from './balanceView'

/** A moment against its target (ADR 0225): on it within 10 %, early or late outside, missed when never reached. */
describe('a moment against its target', () => {
  it('is on target within a tenth of it, either way', () => {
    expect(verdictOf(360, 360)).toBe('on')
    expect(verdictOf(360, 324)).toBe('on')
    expect(verdictOf(360, 396)).toBe('on')
  })

  it('is early or late past that', () => {
    expect(verdictOf(360, 323)).toBe('early')
    expect(verdictOf(360, 397)).toBe('late')
  })

  it('is nothing without a target, and missed when the simulator never reached it', () => {
    expect(verdictOf(null, 100)).toBe('none')
    expect(verdictOf(null, null)).toBe('none')
    expect(verdictOf(60, null)).toBe('missed')
  })

  it('says by how much, which way', () => {
    expect(differenceOf(360, 360)).toBe('on target')
    expect(differenceOf(360, 330)).toBe('on target (30s early)')
    expect(differenceOf(360, 270)).toBe('1m30 early')
    expect(differenceOf(360, 4000)).toBe('1h00 late')
    expect(differenceOf(60, null)).toBe('not reached')
    expect(differenceOf(null, 60)).toBe('')
  })

  it('shows a time in seconds, minutes, or hours', () => {
    expect(clockOf(48)).toBe('48s')
    expect(clockOf(245)).toBe('4m05')
    expect(clockOf(3900)).toBe('1h05')
  })
})
