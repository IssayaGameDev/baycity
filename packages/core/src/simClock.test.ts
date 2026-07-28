import { describe, expect, it } from 'vitest'

import { createSimClock } from './simClock'

const TICK = 1000 / 30

describe('createSimClock', () => {
  it('advances a full step per tick even when the reference does not move', () => {
    // The failure this exists to prevent: several ticks inside one loop wake, where the wall clock
    // is effectively frozen. Every tick must still hand out a step — near `tickMs`, and never the
    // ~0 that reading the wall clock directly would give.
    const ref = 10_000
    const slew = TICK * 0.05
    const clock = createSimClock({ tickMs: TICK, reference: () => ref })
    let prev = clock.tick()
    for (let i = 0; i < 4; i++) {
      const t = clock.tick()
      const d = t - prev
      expect(d).toBeGreaterThan(TICK - slew - 1e-9) // a real step, not a stalled one
      expect(d).toBeLessThan(TICK + slew + 1e-9)
      prev = t
    }
  })

  it('anchors to the reference on the first tick', () => {
    const clock = createSimClock({ tickMs: TICK, reference: () => 4242 })
    expect(clock.tick()).toBe(4242)
  })

  it('tracks a reference running 5% fast by slewing, never by jumping', () => {
    // A sustained rate mismatch is the realistic case (a throttled loop running fewer ticks than
    // real time). The default slew cap is sized to absorb 5%, so the clock must converge without
    // ever hard-resyncing — a resync would teleport every moving platform at once.
    let ref = 0
    const clock = createSimClock({ tickMs: TICK, reference: () => ref })
    const cap = TICK * 0.05 + 1e-9
    let prev = clock.tick()
    for (let i = 0; i < 600; i++) {
      ref += TICK * 1.05
      const t = clock.tick()
      expect(Math.abs(t - prev - TICK)).toBeLessThanOrEqual(cap) // no step out of proportion
      prev = t
    }
    expect(Math.abs(ref - prev)).toBeLessThan(TICK) // and it kept up
  })

  it('snaps when the gap is too large to slew away (tab stall)', () => {
    let ref = 0
    const clock = createSimClock({ tickMs: TICK, reference: () => ref, resyncThresholdMs: 500 })
    clock.tick()
    ref += 60_000 // gone for a minute
    expect(clock.tick()).toBeCloseTo(60_000, 6)
  })

  it('now() reports the current time without advancing it', () => {
    let ref = 500
    const clock = createSimClock({ tickMs: TICK, reference: () => ref })
    const t = clock.tick()
    expect(clock.now()).toBe(t)
    expect(clock.now()).toBe(t)
  })
})
