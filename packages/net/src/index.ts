/**
 * @mp/net — wire protocol: schemas, binary serialization, quantization,
 * clock sync. Binary only; no JSON on the hot path (SEED §2).
 */

export { PROTOCOL_VERSION, MSG_SNAPSHOT, MSG_WELCOME, MSG_INPUT, readMessageType, readHeader } from './messages'
export type { Snapshot, SnapshotEntity } from './snapshot'
export { encodeSnapshot, decodeSnapshot } from './snapshot'
export type { InputCommand } from './input'
export { encodeInput, decodeInput } from './input'
export type { Welcome } from './welcome'
export { encodeWelcome, decodeWelcome } from './welcome'
