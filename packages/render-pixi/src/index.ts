/**
 * @mp/render-pixi — PixiJS 2D HUD: a transparent canvas stacked over the Three.js
 * canvas (SEED §2). Browser-only (DOM lib).
 */

export const RENDER_PIXI_VERSION = '0.0.0' as const

// On-screen touch controls (ADR 0022) — view only; the rules live in `@mp/client`.
export type { TouchHud, TouchHudStick, TouchHudButton, TouchHudStyle } from './touchHud'
export { createTouchHud, DEFAULT_TOUCH_HUD_STYLE } from './touchHud'

// Reusable Pixi UI widgets (ADR 0015 — PixiJS is the game-UI layer).
export type { UiOverlay, LabelStyle, PanelOpts, ButtonOpts, UiButton, SliderOpts, UiSlider, ListItem, ListOpts, UiList } from './ui'
export { createUiOverlay, uiGroup, uiLabel, uiPanel, uiButton, uiSlider, uiList } from './ui'
