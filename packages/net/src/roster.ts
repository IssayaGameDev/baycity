import { entityId, type EntityId } from '@mp/core'

import { MSG_ROSTER, PROTOCOL_VERSION, readHeader } from './messages'

/**
 * Server -> client: the room's peer roster (id -> display name), broadcast on join
 * and leave (ADR 0013). Names are set once at join (auto-random now, player-chosen
 * later) and don't stream per-tick, so a small on-change message is enough — the
 * per-tick snapshot stays position-only.
 */
export interface RosterEntry {
  id: EntityId
  name: string
}

// wire (little-endian): u8 version, u8 type, u16 count, [u16 id, u8 nameLen, utf8 name]*
const LE = true
const MAX_NAME_BYTES = 48
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encodeRoster = (entries: readonly RosterEntry[]): ArrayBuffer => {
  const names = entries.map((e) => encoder.encode(e.name).slice(0, MAX_NAME_BYTES))
  let size = 4
  for (const n of names) size += 3 + n.byteLength
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_ROSTER)
  view.setUint16(2, entries.length, LE)
  let o = 4
  for (let i = 0; i < entries.length; i++) {
    view.setUint16(o, entries[i]!.id, LE)
    o += 2
    const n = names[i]!
    view.setUint8(o, n.byteLength)
    o += 1
    bytes.set(n, o)
    o += n.byteLength
  }
  return buffer
}

export const decodeRoster = (buffer: ArrayBuffer): RosterEntry[] => {
  readHeader(buffer, MSG_ROSTER)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const count = view.getUint16(2, LE)
  let o = 4
  const out: RosterEntry[] = []
  for (let i = 0; i < count; i++) {
    const id = entityId(view.getUint16(o, LE))
    o += 2
    const len = view.getUint8(o)
    o += 1
    out.push({ id, name: decoder.decode(bytes.subarray(o, o + len)) })
    o += len
  }
  return out
}
