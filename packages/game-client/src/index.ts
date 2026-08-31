/**
 * @mp/game-client — the browser client every game on the platform runs (ADR 0056).
 *
 * `startGameClient(descriptor)` is the whole surface, and it returns a `GameClient` whose `dispose` puts
 * the page back (ADR 0065). A game supplies its `ModeDescriptor` and an
 * `index.html` with a `#view` canvas and a `#status` line; the stack supplies the scene, the netcode, the
 * views, the camera, the pause screen and the render loop.
 *
 * The pieces exported alongside it are the ones a *tool* may want without a client — the level source, the
 * asset database, the save adapter. Everything that makes the shipped game a third-person humanoid game lives
 * in `@mp/tps` now (ADR 0065), which a game imports directly.
 */

export const GAME_CLIENT_VERSION = '0.0.0' as const

export type { GameClient } from './client'
export { startGameClient } from './client'
export type { LevelSource } from './levels'
export { DEFAULT_NAME, levelsFor } from './levels'
export { ASSET_DB, CLIP_SOURCE, assetUrlOf, materialOf } from './assets'
export type { PersistenceAdapter, PlayerProgress } from './persistence'
export { localProgress } from './persistence'
// The third-person game's own pieces moved to `@mp/tps` (ADR 0065). Not re-exported: a game that wants a
// character rig imports the game that has one, rather than reaching through the platform for it.
