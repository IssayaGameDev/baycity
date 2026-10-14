/**
 * The buttons down the left edge — Kodjo's call: where every button of this game goes. One column of squares,
 * 84 px × the HUD scale, 18 px in: the first, Teleport (ADR 0203), vertically centred; each next one under it.
 */
export const SIDE_BUTTON = { size: 84, margin: 18, gap: 12 } as const

/** The top of the button in `slot` (0 the first), in overlay pixels, for an overlay `overlayH` tall at scale `k`. */
export const sideButtonY = (slot: number, overlayH: number, k: number): number =>
  overlayH / 2 - (SIDE_BUTTON.size * k) / 2 + slot * (SIDE_BUTTON.size + SIDE_BUTTON.gap) * k
