/**
 * @mp/tps — the third-person game the platform ships, as a package a game imports (ADR 0065).
 *
 * Every one of these was inside `@mp/game-client`, which made it the *platform's* opinion that a game is a
 * blocky humanoid seen over its own shoulder. It is not: it is one game, and the reason `ModeDescriptor` grew
 * a field per humanoid feature (`gait`, `animator`, `standOffset`, `player`, `playerDefs`, …) is that there
 * was no way for a game to simply *import* it and pass arguments.
 *
 * The line against `@mp/humanoid` is **math on one side, pixels on the other**. `@mp/humanoid` has no Three.js
 * at all, which is why nine things import it cheaply including two headless tools. Everything here is Three
 * or the DOM.
 *
 * A game wanting something else takes none of this, and needs no hook to do so.
 */

export const TPS_VERSION = '0.0.0' as const

/**
 * The whole game, started — what every game the stack ships calls from its `main.ts`.
 *
 * It is here rather than in `@mp/game-client` because it is not the platform: it is one game, and its options
 * are its own parameters rather than fields punched through a shared contract (ADR 0065). The pieces below are
 * exported beside it so a game can take some of it and not the rest, and `@mp/game-client`'s services are what
 * a game composes when it wants none of it.
 */
export type { Peer, TpsClient, TpsClientOptions } from './client'
export { startTpsClient } from './client'
export type { FrameHooks } from './frameHooks'
export { createFrameHooks } from './frameHooks'

export type { Avatars, AvatarsOptions, PeerFrame, SelfFrame } from './avatars'
export { createAvatars } from './avatars'
export type { CharacterPlacement, CharacterViews } from './characterView'
export { createCharacterViews, PEER_COLORS, SELF_COLORS } from './characterView'
export { makeNameLabel } from './nametag'
export type { Ragdoll, RagdollOptions } from './ragdoll'
export { createRagdoll } from './ragdoll'
export type { Assembly, AssemblyTiming } from './assemble'
export { createAssembly } from './assemble'
export { BODY_LAYERS, CORPSE_LAYERS } from './layers'
export type { Inputs, InputsOptions } from './inputs'
export { createInputs } from './inputs'
export type { DebugPane, DebugPaneOptions } from './pane'
export { installDebugPane } from './pane'
