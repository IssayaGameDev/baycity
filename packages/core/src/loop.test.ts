import { describe, expect, it } from 'vitest'

import { createStepper, startFixedLoop } from './loop'

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

/**
 * Drawing by the loop's own schedule (ADR 0140). A clock that only moves when told stands in for the wall
 * clock, and the timer never gets to fire: every tick here comes from `pump`, as it does from a drawn frame.
 */
describe('startFixedLoop, pumped by frames', () => {
  const at100ms = (): { t: { now: number }; ticks: number[]; loop: ReturnType<typeof startFixedLoop> } => {
    const t = { now: 0 }
    const ticks: number[] = []
    const loop = startFixedLoop({ tickRateHz: 10, onTick: (_, i) => ticks.push(i), now: () => t.now })
    return { t, ticks, loop }
  }

  it('runs the ticks that are due when pumped, and no more', () => {
    const { t, ticks, loop } = at100ms()
    t.now = 250
    loop.pump()
    expect(ticks).toEqual([0, 1])
    loop.pump()
    expect(ticks, 'nothing new is due').toEqual([0, 1])
    loop.stop()
  })

  /** The bug: a tick that ran late used to restart the fraction at 0, putting the frame behind by the lateness. */
  it('gives the fraction into the next tick by the schedule, however late the tick ran', () => {
    const { t, loop } = at100ms()
    t.now = 130 // the tick due at 100 runs 30 ms late
    loop.pump()
    expect(loop.alpha()).toBeCloseTo(0.3, 9)
    t.now = 175
    expect(loop.alpha(), 'still counting between frames').toBeCloseTo(0.75, 9)
    loop.stop()
  })

  it('holds at a whole tick rather than running ahead of one that is overdue', () => {
    const { t, loop } = at100ms()
    t.now = 180
    expect(loop.alpha()).toBe(1)
    loop.stop()
  })

  it('does nothing once stopped', () => {
    const { t, ticks, loop } = at100ms()
    loop.stop()
    t.now = 500
    loop.pump()
    expect(ticks).toEqual([])
  })
})
