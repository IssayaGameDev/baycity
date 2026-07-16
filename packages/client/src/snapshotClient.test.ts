import { entityId } from '@mp/core'
import type { Snapshot } from '@mp/net'
import { describe, expect, it } from 'vitest'

import { createSnapshotClient } from './snapshotClient'

const snap = (t: number, x: number): Snapshot => ({
  serverTimeMs: t,
  entities: [{ id: entityId(1), position: { x, y: 0, z: 0 } }],
})

describe('createSnapshotClient', () => {
  it('samples the past using the interpolation delay and local elapsed time', () => {
    let t = 1000
    const client = createSnapshotClient({ interpolationDelayMs: 100, now: () => t })

    client.ingest(snap(0, 0))
    client.ingest(snap(100, 10)) // newest server time 100, "arrives" at local 1000

    // renderServerTime = 100 + (1000-1000) - 100 = 0  -> x = 0
    expect(client.sample()[0]!.position.x).toBeCloseTo(0)

    // advance local time 50ms: renderServerTime = 100 + 50 - 100 = 50 -> x = 5
    t = 1050
    expect(client.sample()[0]!.position.x).toBeCloseTo(5)
  })

  it('returns empty before any snapshot arrives', () => {
    const client = createSnapshotClient({ interpolationDelayMs: 100, now: () => 0 })
    expect(client.sample()).toEqual([])
  })

  it('prunes snapshots far behind the newest', () => {
    let t = 0
    const client = createSnapshotClient({
      interpolationDelayMs: 100,
      maxBufferMs: 200,
      now: () => t,
    })
    for (let i = 0; i <= 10; i++) {
      t = i * 100
      client.ingest(snap(i * 100, i))
    }
    // newest = 1000, cutoff = 800; only snapshots >= 800 kept (plus the >2 floor)
    expect(client.bufferedCount()).toBeLessThanOrEqual(4)
  })
})
