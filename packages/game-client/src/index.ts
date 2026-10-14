/**
 * @mp/game-client — the services a browser game on this platform is built out of (ADR 0056, ADR 0065).
 *
 * **Not a framework.** There is no `startGameClient` any more and nothing here decides what a game is. These
 * are pieces you call, and a game's entry point is the thing that calls them.
 *
 * Two kinds of thing live here, and the difference is worth keeping:
 *
 * - **Must be uniform.** `createNetHost` (the room, the clock, the snapshot stream), `loadLevelInto` (the level
 *   schema), `worldFromBase` (wire semantics). Every client in a room has to agree on these or nobody sees
 *   anybody in the right place. This is the actual platform.
 * - **Merely universal.** `createScene`, `createShell`, `createStatusLine`, `loadLevel`, `localProgress`. No
 *   agreement needed; they are simply what any game rendered into a canvas wants, and writing them twice would
 *   be a waste rather than a bug.
 *
 * The third-person humanoid game that used to live in here — rigs, ragdolls, the boom camera, the walk cycle,
 * the debug pane — is `@mp/tps`, and `startTpsClient` is its ready-made assembly. Every game the stack ships
 * calls that. A game that is *not* that game composes these services instead and needs nobody's permission.
 */

export const GAME_CLIENT_VERSION = '0.0.0' as const

export type { BasedTransform } from './baseFrame'
export { worldFromBase } from './baseFrame'
export type { NetHost, NetHostOptions } from './netHost'
export { createNetHost } from './netHost'
export type { LevelHost, LevelHostOptions } from './levelHost'
export { loadLevelInto } from './levelHost'
export type { Scene } from './scene'
export { createScene } from './scene'
export type { Shell, ShellOptions } from './shell'
export type { UiOverlay } from '@mp/render-pixi'
export { createShell } from './shell'
export type { StatusLine } from './status'
export { createStatusLine } from './status'
export { levelNameFor, loadLevel, readJson, type PlayedLevel, type ReadJson } from './levels'
export { levelAssets, type LevelAssets } from './assets'
export type { DebugChoices, PersistenceAdapter, PlayerProgress } from './persistence'
export { localDebugChoices, localProgress } from './persistence'
