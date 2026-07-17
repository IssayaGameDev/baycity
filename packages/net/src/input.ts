import { MSG_INPUT, PROTOCOL_VERSION, readHeader } from './messages'

/** A single client input sample, sequence-numbered for reconciliation (SEED §4). */
export interface InputCommand {
  seq: number // u32
  moveX: number // -1..1 (horizontal)
  moveZ: number // -1..1 (horizontal)
}

// wire: u8 version, u8 type, u32 seq, i8 moveX*127, i8 moveZ*127  (8 bytes)
const LE = true

const toI8 = (n: number): number => Math.max(-127, Math.min(127, Math.round(n * 127)))

export const encodeInput = (cmd: InputCommand): ArrayBuffer => {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_INPUT)
  view.setUint32(2, cmd.seq >>> 0, LE)
  view.setInt8(6, toI8(cmd.moveX))
  view.setInt8(7, toI8(cmd.moveZ))
  return buffer
}

export const decodeInput = (buffer: ArrayBuffer): InputCommand => {
  readHeader(buffer, MSG_INPUT)
  const view = new DataView(buffer)
  return {
    seq: view.getUint32(2, LE),
    moveX: view.getInt8(6) / 127,
    moveZ: view.getInt8(7) / 127,
  }
}
