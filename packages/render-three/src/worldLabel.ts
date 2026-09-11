import * as THREE from 'three'

import { OVERLAY_LAYER } from './stage'

/**
 * Text standing in the world (ADR 0082): a canvas drawn once to a texture on a billboard sprite, on the overlay
 * layer so post-FX never touches it, drawn over everything. Roblox's BillboardGui.
 *
 * It was the nametag (`@mp/tps`), which is one line at head height. A sign over a pad wants two lines in two
 * sizes and no rig to hang from, and nothing about the drawing is the humanoid's — so the drawing lives here,
 * beside the layer it draws on, and the nametag calls it.
 *
 * **Sized by the world, not the screen.** The sprite has a height in metres and shrinks with distance like any
 * other thing in the scene; that is what makes it a sign rather than a HUD. Screen-space text pinned to a
 * point (`TpsClient.toScreen`, ADR 0072) is the other tool, for numbers that must stay readable at any range.
 */

export interface LabelLine {
  text: string
  /** Type size in canvas pixels. The whole label is scaled to `heightM`, so this is relative to the other lines. */
  size: number
  color?: string
  weight?: 'normal' | 'bold'
}

export interface WorldLabelOptions {
  /** How tall the whole label stands in the world, in metres. Width follows the text. */
  heightM?: number
  /**
   * Where it sits in the picture (ADR 0082).
   *
   * `'over'` (default): the overlay layer, drawn after post-FX over everything, never hidden — a nametag, which
   * must be readable through the crowd. `'world'`: the world pass, depth-tested against the level, hidden
   * behind a wall like a sign is, tone mapping and bloom left off the text. A `'world'` label writes no depth,
   * so it never shades anything, but the AO prepass draws with an override material that ignores that — the
   * caller **must** keep it out of the AO prepass (`TpsClient.excludeFromAO`), or it ghosts as a dark quad.
   */
  depth?: 'over' | 'world'
  /** Behind the text. `null` for none. */
  background?: string | null
  /** Canvas pixels around the text. */
  padding?: number
}

/** Rows and canvas size for `lines`: what the drawing needs, computed with a caller-supplied measurer so it can be tested without a canvas. */
export const layoutLabel = (
  lines: readonly LabelLine[],
  padding: number,
  measure: (line: LabelLine) => number,
): { width: number; height: number; rows: { y: number; line: LabelLine }[] } => {
  const gap = 4
  let width = 0
  let y = padding
  const rows: { y: number; line: LabelLine }[] = []
  for (const line of lines) {
    width = Math.max(width, measure(line))
    rows.push({ y: y + line.size / 2, line })
    y += line.size + gap
  }
  // Even sizes: some GPUs want it, and it costs nothing.
  const even = (n: number): number => Math.ceil(n / 2) * 2
  return { width: even(width + padding * 2), height: even(y - gap + padding), rows }
}

const fontOf = (line: LabelLine): string => `${line.weight ?? 'bold'} ${line.size}px sans-serif`

export const worldLabel = (lines: readonly LabelLine[], opts: WorldLabelOptions = {}): THREE.Sprite => {
  const padding = opts.padding ?? 12
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const { width, height, rows } = layoutLabel(lines, padding, (line) => {
    ctx.font = fontOf(line)
    return ctx.measureText(line.text).width
  })
  canvas.width = width
  canvas.height = height
  // Resizing the canvas resets its state.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const background = opts.background === undefined ? 'rgba(11,16,32,0.6)' : opts.background
  if (background !== null) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)
  }
  for (const { y, line } of rows) {
    ctx.font = fontOf(line)
    ctx.fillStyle = line.color ?? '#e5e7eb'
    ctx.fillText(line.text, width / 2, y)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace // canvas pixels are sRGB — decode them correctly
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // draw over the world
      depthWrite: false, // ...and stay out of the depth buffer GTAO reads
      toneMapped: false, // in-world UI, not a lit surface
    }),
  )
  const heightM = opts.heightM ?? 0.5
  sprite.scale.set((heightM * width) / height, heightM, 1)
  if ((opts.depth ?? 'over') === 'world') {
    // In the world: tested against the level's depth, sorted with the other transparent things.
    sprite.material.depthTest = true
  } else {
    sprite.renderOrder = 999
    sprite.layers.set(OVERLAY_LAYER)
  }
  return sprite
}

/** Free what a label owns: its texture and material. The caller removes it from the scene. */
export const disposeWorldLabel = (sprite: THREE.Sprite): void => {
  sprite.material.map?.dispose()
  sprite.material.dispose()
}
