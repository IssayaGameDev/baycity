/**
 * @mp/render-three — Three.js world renderer on WebGL2 (SEED §2). Browser-only.
 * Re-exports THREE so games share one pinned Three.js version via the stack.
 */

export const RENDER_THREE_VERSION = '0.0.0' as const

export * as THREE from 'three'
export type { ThreeStage, ThreeStageOptions } from './stage'
export { createThreeStage } from './stage'
