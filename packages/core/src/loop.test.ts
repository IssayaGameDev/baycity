import { describe, expect, it } from 'vitest'

import { createStepper } from './loop'

describe('createStepper', () => {
  it('accumulates fractional time into whole fixed steps', () => {
    const s = createStepper(10)
    expect(s.push(5)).toBe(0)
    expect(s.push(4)).toBe(0)
    expect(s.push(2)).toBe(1) // 11ms -> 1 step
    expect(s.pending()).toBeCloseTo(1)
  })

  it('returns multiple steps when behind', () => {
    const s = createStepper(10)
    expect(s.push(35)).toBe(3)
    expect(s.pending()).toBeCloseTo(5)
  })

  it('clamps to maxSteps and drops the backlog (no spiral of death)', () => {
    const s = createStepper(10, 3)
    expect(s.push(1000)).toBe(3)
    expect(s.pending()).toBe(0)
  })

  it('rejects a non-positive fixed dt', () => {
    expect(() => createStepper(0)).toThrow()
  })
})
