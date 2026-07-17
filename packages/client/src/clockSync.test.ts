import { describe, expect, it } from 'vitest'

import { createClockSync } from './clockSync'

describe('createClockSync', () => {
  it('estimates server-time offset and RTT from a round-trip', () => {
    let t = 1100
    const sync = createClockSync({ now: () => t })
    // sent at 1000 (local), server reported 5000, received at 1100 (local)
    // rtt = 100; offset = 5000 - (1000 + 50) = 3950
    sync.recordSample(1000, 5000, 1100)
    expect(sync.ready()).toBe(true)
    expect(sync.rttMs()).toBeCloseTo(100)
    expect(sync.serverNow()).toBeCloseTo(1100 + 3950) // now + offset
    t = 1600
    expect(sync.serverNow()).toBeCloseTo(1600 + 3950)
  })

  it('is not ready and reads local time before any sample', () => {
    const sync = createClockSync({ now: () => 42 })
    expect(sync.ready()).toBe(false)
    expect(sync.serverNow()).toBe(42) // offset 0
  })

  it('smooths successive samples (EMA) rather than jumping', () => {
    let t = 0
    const sync = createClockSync({ now: () => t, smoothing: 0.5 })
    sync.recordSample(0, 1000, 0) // rtt 0, offset 1000 -> offset=1000
    sync.recordSample(0, 2000, 0) // sample offset 2000; EMA 0.5 -> 1500
    expect(sync.serverNow()).toBeCloseTo(1500)
  })
})
