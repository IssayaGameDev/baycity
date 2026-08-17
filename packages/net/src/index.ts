/**
 * @mp/net — wire protocol: schemas, binary serialization, quantization,
 * clock sync. Binary only; no JSON on the hot path (SEED §2).
 */

export {
  PROTOCOL_VERSION,
  NET_CHANNEL,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  MSG_STATE,
  MSG_PING,
  MSG_PONG,
  MSG_ROSTER,
  readMessageType,
  readHeader,
} from './messages'
export type { RosterEntry } from './roster'
export { encodeRoster, decodeRoster } from './roster'
export type { Snapshot, SnapshotEntity, SnapshotMessage } from './snapshot'
export { encodeSnapshot, decodeSnapshot, fullSnapshotMessage } from './snapshot'
export { quantizeAxis, dequantizeAxis, QUANT_BOUND } from './quantize'
export type { InputCommand } from './input'
export type { PlayerState } from './state'
export { encodeState, decodeState, STATE_GROUNDED, STATE_RISING } from './state'
export type { Welcome } from './welcome'
export { encodeWelcome, decodeWelcome } from './welcome'
export type { Ping, Pong } from './timesync'
export { encodePing, decodePing, encodePong, decodePong } from './timesync'
