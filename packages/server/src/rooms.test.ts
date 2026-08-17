import { entityId } from '@mp/core'
import { STATE_GROUNDED, STATE_RISING, type SnapshotEntity } from '@mp/net'
import { describe, expect, it } from 'vitest'

import { deltaSnapshot, type DeltaBaseline } from './rooms'

const A = entityId(1000)
const B = entityId(1001)
const at = (id: typeof A, x: number, flags = STATE_GROUNDED): SnapshotEntity => ({ id, position: { x, y: 0, z: 0 }, flags })

// The Colyseus room + live handshake are exercised by the tsx load harness (a full
// Colyseus server can't boot under vitest's fork pool — @pm2/io hijacks its IPC). Here
// we unit-test the pure per-client delta logic that the relay is built on.
describe('deltaSnapshot (per-client relay delta)', () => {
  it('sends a full snapshot first, then deltas of only quantized-changed peers', () => {
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }

    const full = deltaSnapshot(s, [at(A, 1), at(B, 5)], 0)
    expect(full.isFull).toBe(true)
    expect(full.changed).toHaveLength(2)
    expect(full.removed).toEqual([])

    // A moves a lot, B unchanged → delta carries only A.
    const delta = deltaSnapshot(s, [at(A, 2), at(B, 5)], 50)
    expect(delta.isFull).toBe(false)
    expect(delta.changed).toHaveLength(1)
    expect(delta.changed[0]!.id).toBe(A)
    expect(delta.removed).toEqual([])
  })

  it('relays a peer whose flags changed even though it did not move', () => {
    // Leaving the ground need not move you a whole quantization step, and the flags are exactly
    // what the viewer cannot reconstruct — so they have to force a relay on their own.
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [at(A, 1, STATE_GROUNDED)], 0) // full
    const delta = deltaSnapshot(s, [at(A, 1, STATE_RISING)], 50)
    expect(delta.changed).toHaveLength(1)
    expect(delta.changed[0]!.flags).toBe(STATE_RISING)
  })

  it('sends nothing for a peer that is both still and in the same state', () => {
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [at(A, 1)], 0) // full
    expect(deltaSnapshot(s, [at(A, 1)], 50).changed).toEqual([])
  })

  it('reports a peer that disappeared as removed', () => {
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [at(A, 1), at(B, 5)], 0) // full
    const delta = deltaSnapshot(s, [at(A, 1)], 50) // B gone
    expect(delta.changed).toEqual([]) // A unchanged (same quantized position, same flags)
    expect(delta.removed).toEqual([B])
  })
})
