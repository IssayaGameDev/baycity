import { entityId, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { deltaSnapshot, type DeltaBaseline } from './rooms'

const A = entityId(1000)
const B = entityId(1001)
const at = (x: number): Vec3 => ({ x, y: 0, z: 0 })

// The Colyseus room + live handshake are exercised by the tsx load harness (a full
// Colyseus server can't boot under vitest's fork pool — @pm2/io hijacks its IPC). Here
// we unit-test the pure per-client delta logic that the relay is built on.
describe('deltaSnapshot (per-client relay delta)', () => {
  it('sends a full snapshot first, then deltas of only quantized-changed peers', () => {
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }

    const full = deltaSnapshot(s, [{ id: A, position: at(1) }, { id: B, position: at(5) }], 0)
    expect(full.isFull).toBe(true)
    expect(full.changed).toHaveLength(2)
    expect(full.removed).toEqual([])

    // A moves a lot, B unchanged → delta carries only A.
    const delta = deltaSnapshot(s, [{ id: A, position: at(2) }, { id: B, position: at(5) }], 50)
    expect(delta.isFull).toBe(false)
    expect(delta.changed).toHaveLength(1)
    expect(delta.changed[0]!.id).toBe(A)
    expect(delta.removed).toEqual([])
  })

  it('reports a peer that disappeared as removed', () => {
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [{ id: A, position: at(1) }, { id: B, position: at(5) }], 0) // full
    const delta = deltaSnapshot(s, [{ id: A, position: at(1) }], 50) // B gone
    expect(delta.changed).toEqual([]) // A unchanged (same quantized position)
    expect(delta.removed).toEqual([B])
  })
})
