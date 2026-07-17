/**
 * @mp/net — wire protocol: schemas, binary serialization, quantization,
 * clock sync. Binary only; no JSON on the hot path (SEED §2).
 */

export {
  PROTOCOL_VERSION,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  MSG_INPUT,
  MSG_PING,
  MSG_PONG,
  MSG_FIRE,
  MSG_HIT,
  readMessageType,
  readHeader,
} from './messages'
export type { Snapshot, SnapshotEntity } from './snapshot'
export { encodeSnapshot, decodeSnapshot } from './snapshot'
export type { InputCommand } from './input'
export { encodeInput, decodeInput } from './input'
export type { Welcome } from './welcome'
export { encodeWelcome, decodeWelcome } from './welcome'
export type { Ping, Pong } from './timesync'
export { encodePing, decodePing, encodePong, decodePong } from './timesync'
export type { Fire, Hit } from './combat'
export { encodeFire, decodeFire, encodeHit, decodeHit } from './combat'
