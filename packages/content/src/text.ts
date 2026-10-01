import { boolParam, numberParam, stringParam, TEXT } from './nodes'
import type { ComponentData } from './types'

/**
 * A `Text` component, read (ADR 0189): what to write and how. One reading, for the loader and the editor alike,
 * so the game and the viewport cannot draw a different sign. Headless — the renderer turns it into a mesh.
 */
export interface TextDesc {
  readonly text: string
  /** A font asset's id (ADR 0190); `''` for the default, Roboto. */
  readonly font: string
  /** The font size in metres, at scale 1: the node's scale scales it, as Unity's does. */
  readonly size: number
  /** sRGB `#rrggbb`. */
  readonly color: string
  readonly align: 'left' | 'center' | 'right'
  /** Where lines wrap, in metres at scale 1; 0 for never. */
  readonly width: number
  /** Drawn thicker, for every font alike: each letter's edge widened in its own colour (ADR 0190). */
  readonly bold: boolean
  /** On the node's own XY plane, read from +Z, or turned to each camera. */
  readonly facing: 'object' | 'camera'
  /** From behind, on the object: mirrored (Unity's) or nothing. */
  readonly back: 'mirrored' | 'hidden'
}

/**
 * Why a font file cannot draw text, or `null` when it can (ADR 0190): the text library reads TrueType, OpenType and
 * WOFF, not WOFF2, which the Project window still takes as a font.
 */
export const textFontRefusal = (path: string): string | null =>
  /\.woff2$/i.test(path) ? 'a woff2 font cannot draw text — convert it to woff, ttf or otf' : null

const oneOf = <T extends string>(value: string, options: readonly T[], fallback: T): T => ((options as readonly string[]).includes(value) ? (value as T) : fallback)

/** The enabled `Text` component's reading, or `undefined` when the node has none. */
export const textOf = (components: readonly ComponentData[]): TextDesc | undefined => {
  const c = components.find((x) => x.type === TEXT && x.enabled !== false)
  if (c === undefined) return undefined
  return {
    text: stringParam(c, 'text', 'Text'),
    font: stringParam(c, 'font', ''),
    size: Math.max(0.001, numberParam(c, 'size', 0.5)),
    color: stringParam(c, 'color', '#ffffff'),
    align: oneOf(stringParam(c, 'align', 'center'), ['left', 'center', 'right'], 'center'),
    width: Math.max(0, numberParam(c, 'width', 0)),
    bold: boolParam(c, 'bold', false),
    facing: oneOf(stringParam(c, 'facing', 'object'), ['object', 'camera'], 'object'),
    back: oneOf(stringParam(c, 'back', 'mirrored'), ['mirrored', 'hidden'], 'mirrored'),
  }
}
