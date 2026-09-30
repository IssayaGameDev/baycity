import { defineComponent } from '@mp/components'

/**
 * The component a level author places: a platform's top face, tiled with keycaps (ADR 0069). Data only — nothing
 * here draws or collides; `keycaps.ts` draws the caps and finds the one under a foot.
 */
export const Keyboard = defineComponent({
  type: 'Keyboard',
  label: 'Keyboard surface',
  /**
   * **The key geometry is not here.** Pitch, fill and height are game settings (`KEY_SETTINGS`, ADR 0115):
   * a level is a succession of platforms — thousands of them — and a pitch per platform means a pitch to
   * change per platform, and any two that disagree cannot align however the grid is anchored.
   *
   * What is left is per-surface because it genuinely differs per surface: which letters this board draws
   * from, and the seed that scatters them.
   */
  params: {
    /**
     * Which letters get used, and in what order — hashed per cell, so the same level always reads the same.
     *
     * Not a real QWERTY layout: Kodjo's call was individual caps with letters scattered over them, so the
     * layout is deliberately meaningless.
     */
    glyphs: { kind: 'string', default: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', label: 'glyphs' },
    /** Change it and every cap re-letters. Same seed, same board, on every machine. */
    seed: { kind: 'number', default: 1, min: 0, max: 9999, step: 1, label: 'letter seed' },
  },
  singleton: true,
})
