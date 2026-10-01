/**
 * The part of `troika-three-text` this package uses (ADR 0189). The library ships JavaScript only; these are its
 * documented properties, typed as it reads them.
 */
declare module 'troika-three-text' {
  import type { Color, Mesh } from 'three'

  export interface TextRenderInfo {
    /** `[minX, minY, maxX, maxY]` of the laid-out block, in the text's own units. */
    readonly blockBounds: readonly [number, number, number, number]
  }

  /** A mesh of one block of text: laid out in a worker, drawn from a shared signed-distance glyph atlas. */
  export class Text extends Mesh {
    text: string
    /** The em size, in world units. */
    fontSize: number
    /** A `.ttf`, `.otf` or `.woff` URL; `null` for the builder's default. */
    font: string | null
    fontWeight: number | 'normal' | 'bold'
    color: string | number | Color | null
    /** A stroke round each glyph, in world units or a `%` of the font size; 0 for none. */
    outlineWidth: number | string
    outlineColor: string | number | Color
    anchorX: number | 'left' | 'center' | 'right'
    anchorY: number | 'top' | 'top-baseline' | 'top-cap' | 'top-ex' | 'middle' | 'bottom-baseline' | 'bottom'
    textAlign: 'left' | 'right' | 'center' | 'justify'
    /** Wrap width in world units; `Infinity` for none. */
    maxWidth: number
    lineHeight: number | 'normal'
    whiteSpace: 'normal' | 'nowrap'
    overflowWrap: 'normal' | 'break-word'
    readonly textRenderInfo: TextRenderInfo | null
    /** Lay out (asynchronously) whatever changed; `callback` once the new geometry is in place. */
    sync(callback?: () => void): void
    dispose(): void
  }

  export function configureTextBuilder(config: {
    defaultFontURL?: string | null
    unicodeFontsURL?: string | null
    sdfGlyphSize?: number
    useWorker?: boolean
  }): void
}
