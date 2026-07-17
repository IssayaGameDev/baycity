import { entityId } from '@mp/core'
import type { Snapshot } from '@mp/net'
import { describe, expect, it } from 'vitest'

import { createSnapshotClient } from './snapshotClient'

const snap = (t: number, x: number): Snapshot => ({
  serverTimeMs: t,
  lastProcessedInputSeq: 0,
  entities: [{ id: entityId(1), position: { x, y: 0, z: 0 } }],
})

describe('createSnapshotClient', () => {
  it('samples the past using the interpolation delay and local elapsed time', () => {
    let t = 1000
    // clockTracking 1 = track each snapshot immediately, for deterministic assertions
    const client = createSnapshotClient({ interpolationDelayMs: 100, clockTracking: 1, now: () => t })

    client.ingest(snap(0, 0))
    client.ingest(snap(100, 10)) // newest server time 100, "arrives" at local 1000

    // renderServerTime = 1000 + (100-1000) - 100 = 0 -> x = 0
    expect(client.sample()[0]!.position.x).toBeCloseTo(0)

    // advance local time 50ms -> renderServerTime = 1050 - 900 - 100 = 50 -> x = 5
    t = 1050
    expect(client.sample()[0]!.position.x).toBeCloseTo(5)
  })

  it('absorbs arrival jitter instead of snapping the render clock to each snapshot', () => {
    let t = 0
    const client = createSnapshotClient({ interpolationDelayMs: 100, clockTracking: 0.1, now: () => t })
    client.ingest(snap(0, 0)) // baseline offset = 0
    // this snapshot's server time is 100 but it arrives 100ms "late" (local 200)
    t = 200
    client.ingest(snap(100, 10))
    // a hard-reset clock would jump renderServerTime back to 0 (x=0); the smoothed
    // clock only nudges, so playback keeps advancing (x stays near the newest).
    expect(client.sample()[0]!.position.x).toBeGreaterThan(8)
  })

  it('returns empty before any snapshot arrives', () => {
    const client = createSnapshotClient({ interpolationDelayMs: 100, now: () => 0 })
    expect(client.sample()).toEqual([])
  })

  it('prunes snapshots far behind the newest', () => {
    let t = 0
    const client = createSnapshotClient({ interpolationDelayMs: 100, maxBufferMs: 200, now: () => t })
    for (let i = 0; i <= 10; i++) {
      t = i * 100
      client.ingest(snap(i * 100, i))
    }
    expect(client.bufferedCount()).toBeLessThanOrEqual(4)
  })
})
