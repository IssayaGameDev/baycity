import { MSG_INPUT, PROTOCOL_VERSION, readHeader } from './messages'

/**
 * A single client input sample, sequence-numbered for reconciliation (SEED §4).
 * `moveX`/`moveZ` are a world-space horizontal direction (the client rotates raw
 * WASD by the camera before sending), so the server is camera-agnostic.
 */
export interface InputCommand {
  seq: number // u32
  moveX: number // -1..1 (world-space)
  moveZ: number // -1..1 (world-space)
  jump: boolean
}

// wire: u8 version, u8 type, u32 seq, i8 moveX*127, i8 moveZ*127, u8 flags (bit0 jump)
const LE = true
const FLAG_JUMP = 1

const toI8 = (n: number): number => Math.max(-127, Math.min(127, Math.round(n * 127)))

export const encodeInput = (cmd: InputCommand): ArrayBuffer => {
  const buffer = new ArrayBuffer(9)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_INPUT)
  view.setUint32(2, cmd.seq >>> 0, LE)
  view.setInt8(6, toI8(cmd.moveX))
  view.setInt8(7, toI8(cmd.moveZ))
  view.setUint8(8, cmd.jump ? FLAG_JUMP : 0)
  return buffer
}

export const decodeInput = (buffer: ArrayBuffer): InputCommand => {
  readHeader(buffer, MSG_INPUT)
  const view = new DataView(buffer)
  return {
    seq: view.getUint32(2, LE),
    moveX: view.getInt8(6) / 127,
    moveZ: view.getInt8(7) / 127,
    jump: (view.getUint8(8) & FLAG_JUMP) !== 0,
  }
}
