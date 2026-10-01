/**
 * Which colours each key wears (ADR 0182): a Keyboard Style's rows — a cap colour with its own letter colour, and a
 * weight — picked per key, and its shade jitter. Pure, and hashed rather than random, as the letters are (`glyphAt`):
 * every client builds its own caps from the same level, so two players see the same key the same colour, and the
 * board looks the same every time it is opened. The letter seed drives both, so changing it reshuffles both.
 *
 * Colours here are `0xrrggbb` sRGB numbers; the drawing turns them into the renderer's space.
 */

/** One row of a style's key colours, as read: a letter colour of `''` is auto. */
export interface KeyColourRow {
  readonly cap: string
  readonly letter: string
  readonly weight: number
}

/** A style's colour fields, as `readData` gives them. */
export interface KeyStyleColours {
  readonly keys: readonly KeyColourRow[]
  readonly jitter: number
}

/** What one key wears. */
export interface KeyColours {
  readonly cap: number
  readonly ink: number
}

/** The letter colours auto picks between: dark on a light cap, light on a dark one. */
export const AUTO_DARK = 0x2b2b31
export const AUTO_LIGHT = 0xf2f0ea

const hex = (s: string): number | null => (/^#[0-9a-fA-F]{6}$/.test(s) ? Number.parseInt(s.slice(1), 16) : null)

/** Relative luminance of an sRGB colour, 0…1 (WCAG's). */
const luminance = (rgb: number): number => {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((rgb >> 16) & 0xff) + 0.7152 * lin((rgb >> 8) & 0xff) + 0.0722 * lin(rgb & 0xff)
}

/**
 * The letter colour that reads on `cap`: whichever of the two contrasts more. Contrast as WCAG measures it, so a
 * mid-tone cap gets whichever side is genuinely further, not whichever a 0.5 threshold guesses.
 */
export const autoInk = (cap: number): number => {
  const l = luminance(cap)
  const against = (other: number): number => {
    const o = luminance(other)
    return (Math.max(l, o) + 0.05) / (Math.min(l, o) + 0.05)
  }
  return against(AUTO_DARK) >= against(AUTO_LIGHT) ? AUTO_DARK : AUTO_LIGHT
}

/**
 * A number in 0…1 from the seed, the cell and a salt — the same mixing `glyphAt` uses, salted so a key's colour does
 * not follow its letter.
 */
export const cellHash = (seed: number, col: number, row: number, salt: number): number => {
  let h = (seed * 0x9e3779b1) ^ (col * 0x85ebca6b) ^ (row * 0xc2b2ae35) ^ Math.imul(salt, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 0x100000000
}

const PICK = 1
const SHADE = 2

/** Scale a colour's brightness by `k`, each channel clamped. */
const shade = (rgb: number, k: number): number => {
  const ch = (c: number): number => Math.max(0, Math.min(255, Math.round(c * k)))
  return (ch((rgb >> 16) & 0xff) << 16) | (ch((rgb >> 8) & 0xff) << 8) | ch(rgb & 0xff)
}

/**
 * The colours one key wears. A row is picked by weight (a weight of 0 never is); its letter colour is its own, or
 * auto's against the cap. Jitter then moves the cap's brightness by up to ±`jitter`, the letter kept as picked.
 * `fallback` for no style, no rows, or no row with any weight — the look a board has without a style.
 */
export const keyColoursAt = (style: KeyStyleColours | undefined, seed: number, col: number, row: number, fallback: KeyColours): KeyColours => {
  const rows = (style?.keys ?? []).filter((r) => r.weight > 0 && hex(r.cap) !== null)
  const total = rows.reduce((sum, r) => sum + r.weight, 0)
  if (style === undefined || rows.length === 0 || total <= 0) return fallback
  let at = cellHash(seed, col, row, PICK) * total
  let picked = rows[rows.length - 1]!
  for (const r of rows) {
    if (at < r.weight) {
      picked = r
      break
    }
    at -= r.weight
  }
  const cap = hex(picked.cap)!
  const ink = hex(picked.letter) ?? autoInk(cap)
  const jitter = Math.max(0, style.jitter)
  return { cap: jitter === 0 ? cap : shade(cap, 1 + (cellHash(seed, col, row, SHADE) * 2 - 1) * jitter), ink }
}
