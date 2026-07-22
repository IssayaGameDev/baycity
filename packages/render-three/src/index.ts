/**
 * @mp/render-three — Three.js world renderer on WebGL2 (SEED §2). Browser-only.
 * Re-exports THREE so games share one pinned Three.js version via the stack.
 */

export const RENDER_THREE_VERSION = '0.0.0' as const

export * as THREE from 'three'
// Orbit camera control (viewer/tools) — re-exported so consumers share the pinned three.
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
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
