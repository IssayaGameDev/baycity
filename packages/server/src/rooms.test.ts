import { entityId } from '@mp/core'
import { STATE_GROUNDED, STATE_RISING, type SnapshotEntity } from '@mp/net'
import { describe, expect, it } from 'vitest'

import { deltaSnapshot, type DeltaBaseline } from './rooms'

const A = entityId(1000)
const B = entityId(1001)
const at = (id: typeof A, x: number, flags = STATE_GROUNDED, yaw = 0, speed = 0, base = 0): SnapshotEntity => ({
  id,
  position: { x, y: 0, z: 0 },
  flags,
  yaw,
  speed,
  base,
})

// The Colyseus room + live handshake are exercised by the tsx load harness (a full
// Colyseus server can't boot under vitest's fork pool — @pm2/io hijacks its IPC). Here
// we unit-test the pure per-client delta logic that the relay is built on.
describe('the room quantization bound (ADR 0093)', () => {
  it('decides what counts as a move', () => {
    // The change check compares *quantized* positions, so the bound decides the smallest move a viewer can
    // be told about. 2 cm is inside one step at a 1000 m bound (3.05 cm) and dozens of steps at 10 m.
    const coarse: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(coarse, [at(A, 0)], 0, 1000)
    expect(deltaSnapshot(coarse, [at(A, 0.02)], 50, 1000).changed).toEqual([])

    const fine: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(fine, [at(A, 0)], 0, 10)
    expect(deltaSnapshot(fine, [at(A, 0.02)], 50, 10).changed).toHaveLength(1)
  })

  it('stops relaying a peer who has left it, which is the bug it exists to make visible', () => {
    // Past the bound both frames quantize identically, so the delta concludes nobody moved — the peer is not
    // merely clamped, they go silent (ADR 0092). A level that reaches further has to say so.
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [at(A, 60)], 0, 40)
    expect(deltaSnapshot(s, [at(A, 95)], 50, 40).changed).toEqual([])
    // Told the level's real size, the same move is relayed.
    const wide: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(wide, [at(A, 60)], 0, 1000)
    expect(deltaSnapshot(wide, [at(A, 95)], 50, 1000).changed).toHaveLength(1)
  })
})

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

  it('relays a peer that turned on the spot, or changed speed, without moving', () => {
    // Both are things a viewer cannot reconstruct from the position curve: facing follows the input,
    // and locomotion speed is what is left once a platform's carry is taken out. Turning in place moves
    // nothing at all, so nothing else would force the relay.
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 0, 0)], 0) // full
    expect(deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 1.5, 0)], 50).changed).toHaveLength(1)
    expect(deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 1.5, 4)], 100).changed).toHaveLength(1)
    expect(deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 1.5, 4)], 150).changed).toEqual([])
  })

  it('does not relay a facing change too small to survive quantization', () => {
    // The comparison is on the quantized byte, not the float: relaying a change the recipient could
    // never receive is exactly what the delta exists to avoid.
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 1, 3)], 0) // full
    expect(deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 1.001, 3.001)], 50).changed).toEqual([])
  })

  it('relays a peer that stepped onto or off a moving platform', () => {
    // The base is the frame the position is expressed in (v10, ADR 0021), so a change of base changes the
    // meaning of bytes that may themselves be identical: a rider stepping onto a platform at the moment it
    // passes through its own origin reports the same numbers with a different frame. Nothing else here
    // would force that relay, and a viewer left on the old base would put them somewhere else entirely.
    const s: DeltaBaseline = { sentFull: false, baseline: new Map() }
    deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 0, 0, 0)], 0) // full
    expect(deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 0, 0, 4)], 50).changed).toHaveLength(1)
    expect(deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 0, 0, 4)], 100).changed).toEqual([])
    expect(deltaSnapshot(s, [at(A, 1, STATE_GROUNDED, 0, 0, 0)], 150).changed).toHaveLength(1)
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
