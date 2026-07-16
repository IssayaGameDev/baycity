/**
 * @mp/net — wire protocol: schemas, binary serialization, quantization,
 * clock sync. Binary only; no JSON on the hot path (SEED §2).
 */

export { PROTOCOL_VERSION, MSG_SNAPSHOT } from './messages'
export type { Snapshot, SnapshotEntity } from './snapshot'
export { encodeSnapshot, decodeSnapshot } from './snapshot'
