/**
 * @mp/render-pixi — PixiJS 2D HUD: a transparent canvas stacked over the Three.js
 * canvas (SEED §2). Browser-only (DOM lib).
 */

export const RENDER_PIXI_VERSION = '0.0.0' as const

export type { Hud, HudJoystick } from './hud'
export { createHud } from './hud'
