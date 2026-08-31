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
export {
  quantizeAxis,
  dequantizeAxis,
  QUANT_BOUND,
  quantizeYaw,
  dequantizeYaw,
  quantizeSpeed,
  dequantizeSpeed,
  SPEED_BOUND,
} from './quantize'
// `InputCommand` moved to `@mp/core` (ADR 0061). It was never sent on the wire — a client-authoritative
// client sends its resulting position, not its input (ADR 0011) — so it was only ever here because an earlier
// design was going to transmit it. Keeping it here made the component system unable to name the type without
// depending on the netcode.
export type { PlayerState } from './state'
export { encodeState, decodeState, STATE_GROUNDED, STATE_RISING, STATE_DEAD } from './state'
export type { Welcome } from './welcome'
export { encodeWelcome, decodeWelcome } from './welcome'
export type { Ping, Pong } from './timesync'
export { encodePing, decodePing, encodePong, decodePong } from './timesync'
