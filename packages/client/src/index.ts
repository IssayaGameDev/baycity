/**
 * @mp/client — client-side netcode (client-authoritative, ADR 0011): a local
 * authoritative sim for the owned entity, snapshot interpolation for peers, clock
 * sync, input abstraction. Headless-capable (no DOM lib) so the same logic drives
 * bots (SEED §6, law 2).
 */

export const CLIENT_VERSION = '0.0.0' as const

export { createWebSocketClientTransport } from './transport-ws'
export { interpolateAt } from './interpolation'
export type { SnapshotClient, SnapshotClientOptions } from './snapshotClient'
export { createSnapshotClient } from './snapshotClient'
export type { LocalController, LocalControllerOptions, LocalWorld } from './localController'
export { createLocalController } from './localController'
export type { ClockSync, ClockSyncOptions } from './clockSync'
export { createClockSync } from './clockSync'
export type { SnapshotReassembler } from './reassembler'
export { createSnapshotReassembler } from './reassembler'
export type { InputState, InputSource, ManualInputSource } from './input'
export { createManualInputSource, keysToMovement } from './input'
