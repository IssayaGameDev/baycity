import { entityId } from '@mp/core'
import type { SnapshotMessage } from '@mp/net'
import { describe, expect, it } from 'vitest'

import { createSnapshotReassembler } from './reassembler'

const A = entityId(1)
const B = entityId(1000)

describe('createSnapshotReassembler', () => {
  it('reconstructs full state from a full then applies deltas', () => {
    const r = createSnapshotReassembler()

    const full: SnapshotMessage = {
      isFull: true,
      serverTimeMs: 0,
      changed: [
        { id: A, position: { x: 1, y: 0, z: 0 }, flags: 0 , yaw: 0, speed: 0},
        { id: B, position: { x: 5, y: 0, z: 0 }, flags: 0 , yaw: 0, speed: 0},
      ],
      removed: [],
    }
    expect(r.apply(full).entities).toHaveLength(2)

    // delta: A moves, B leaves
    const delta: SnapshotMessage = {
      isFull: false,
      serverTimeMs: 50,
      changed: [{ id: A, position: { x: 2, y: 0, z: 0 }, flags: 0 , yaw: 0, speed: 0}],
      removed: [B],
    }
    const snap = r.apply(delta)
    expect(snap.serverTimeMs).toBe(50)
    expect(snap.entities).toHaveLength(1)
    expect(snap.entities[0]!.id).toBe(A)
    expect(snap.entities[0]!.position.x).toBe(2)
  })

  it('a full resets prior state', () => {
    const r = createSnapshotReassembler()
    r.apply({ isFull: true, serverTimeMs: 0, changed: [{ id: A, position: { x: 1, y: 0, z: 0 }, flags: 0 , yaw: 0, speed: 0}], removed: [] })
    const snap = r.apply({ isFull: true, serverTimeMs: 1, changed: [{ id: B, position: { x: 9, y: 0, z: 0 }, flags: 0 , yaw: 0, speed: 0}], removed: [] })
    expect(snap.entities).toHaveLength(1)
    expect(snap.entities[0]!.id).toBe(B)
  })
})

