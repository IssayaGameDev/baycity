/**
 * @mp/game-client — the browser client every game on the platform runs (ADR 0056).
 *
 * `startGameClient(descriptor)` is the whole surface, and it returns a `GameClient` whose `dispose` puts
 * the page back (ADR 0065). A game supplies its `ModeDescriptor` and an
 * `index.html` with a `#view` canvas and a `#status` line; the stack supplies the scene, the netcode, the
 * views, the camera, the pause screen and the render loop.
 *
 * The pieces are exported alongside it because a tool may want one without the client: the editor already
 * draws rig-coloured characters and could use the level source.
 */

export const GAME_CLIENT_VERSION = '0.0.0' as const

export type { GameClient } from './client'
export { startGameClient } from './client'
export type { LevelSource } from './levels'
export { DEFAULT_NAME, levelsFor } from './levels'
export { ASSET_DB, CLIP_SOURCE, assetUrlOf, materialOf } from './assets'
export type { PersistenceAdapter, PlayerProgress } from './persistence'
export { localProgress } from './persistence'
export { BODY_LAYERS, CORPSE_LAYERS } from './layers'
export type { CharacterPlacement, CharacterViews } from './characterView'
export { createCharacterViews, PEER_COLORS, SELF_COLORS } from './characterView'
