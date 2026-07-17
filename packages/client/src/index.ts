/**
 * @mp/client — client-side netcode: prediction/reconciliation, snapshot
 * interpolation, input abstraction. Headless-capable (no DOM lib) so the same
 * logic drives bots (SEED §6, law 2).
 */

export const CLIENT_VERSION = '0.0.0' as const

export { createWebSocketClientTransport } from './transport-ws'
export { interpolateAt } from './interpolation'
export type { SnapshotClient, SnapshotClientOptions } from './snapshotClient'
export { createSnapshotClient } from './snapshotClient'
export type { Predictor, PredictorOptions, PredictedWorld } from './predictor'
export { createPredictor } from './predictor'
