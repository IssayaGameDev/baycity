/**
 * @mp/render-three — Three.js world renderer on WebGL2 (SEED §2). Browser-only.
 * Re-exports THREE so games share one pinned Three.js version via the stack.
 */

export const RENDER_THREE_VERSION = '0.0.0' as const

export * as THREE from 'three'
// Orbit + transform gizmo (viewer/editor tools) — re-exported so consumers share the pinned three.
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
export { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
export type { ThreeStage, ThreeStageOptions } from './stage'
export { createThreeStage } from './stage'

// Polished greybox pipeline (content pipeline C3) — shared by the game and the viewer.
export { STYLE_PALETTE, colorForStyle, createStyleMaterial, geometryForCollider } from './materials'
export type { GreyboxEnvironment, GreyboxEnvironmentOptions } from './environment'
export { applyGreyboxEnvironment } from './environment'
export type { PostFX, PostFXOptions } from './postfx'
export { createPostFX } from './postfx'
export type { LevelView, LevelViewOptions, MarkersView } from './levelView'
export { addLevel, addMarkers } from './levelView'

// Blocky character rig (10 parts, no skinning) — shape and motion come from @mp/character.
export type { CharacterRig, CharacterRigOptions, RigStyle } from './characterRig'
export { createCharacterRig } from './characterRig'
