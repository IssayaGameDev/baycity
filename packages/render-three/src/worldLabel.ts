import * as THREE from 'three'

import { createText, faceCamera, type WorldText } from './text'
import { OVERLAY_LAYER } from './stage'

/**
 * A label standing in the world (ADR 0082, ADR 0189): lines of text facing the camera, sized in metres. Roblox's
 * BillboardGui — a nametag, a sign over a pad.
 *
 * Drawn by `text.ts` like every other text: one `createText` per line, each turning to the camera about the
 * label's origin so the lines stay stacked whichever way it is seen. A line's `size` is relative to the others;
 * the whole label is `heightM` tall.
 *
 * **Sized by the world, not the screen.** It shrinks with distance like any other thing in the scene; that is what
 * makes it a sign rather than a HUD. Screen-space text pinned to a point (`TpsClient.toScreen`, ADR 0072) is the
 * other tool, for numbers that must stay readable at any range.
 */

export interface LabelLine {
  text: string
  /** Type size, relative to the other lines: the whole label is scaled to `heightM`. */
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
   * must be readable through the crowd. `'world'`: the world pass, depth-tested against the level, hidden behind a
   * wall like a sign is. A `'world'` label writes no depth, so it never shades anything, but the AO prepass draws
   * with an override material that ignores that — the caller **must** keep it out of the AO prepass
   * (`TpsClient.excludeFromAO`), or it ghosts as a dark quad.
   */
  depth?: 'over' | 'world'
  /** Behind the text, as CSS colour (`rgba()` for a translucent one). `null` for none. */
  background?: string | null
  /** Around the text, in the same units as a line's `size`. */
  padding?: number
}

/** Between two lines, in a line's `size` units. */
const GAP = 4

/**
 * Each line's height in the label's units, and where its middle sits from the label's centre: the stack,
 * centred, `padding` above and below. Pure, so it is tested without a renderer.
 */
export const stackLines = (lines: readonly LabelLine[], padding: number): { total: number; rows: { line: LabelLine; y: number }[] } => {
  const total = lines.reduce((sum, l) => sum + l.size, 0) + GAP * Math.max(0, lines.length - 1) + padding * 2
  let top = total / 2 - padding
  const rows = lines.map((line) => {
    const y = top - line.size / 2
    top -= line.size + GAP
    return { line, y }
  })
  return { total, rows }
}

/** A CSS colour as three's colour and an opacity: `rgba(r,g,b,a)` carries its alpha, anything else is opaque. */
const parseFill = (css: string): { color: THREE.Color; opacity: number } => {
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(css.trim())
  if (rgba === null) return { color: new THREE.Color(css), opacity: 1 }
  const [r, g, b, a] = rgba.slice(1).map(Number) as [number, number, number, number]
  return { color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), opacity: a }
}

/** What a label owns, by the label, for `disposeWorldLabel`. */
const owned = new WeakMap<THREE.Object3D, () => void>()

export const worldLabel = (lines: readonly LabelLine[], opts: WorldLabelOptions = {}): THREE.Group => {
  const padding = opts.padding ?? 12
  const depth = opts.depth ?? 'over'
  const { total, rows } = stackLines(lines, padding)
  const metre = (opts.heightM ?? 0.5) / total
  const group = new THREE.Group()
  const texts: WorldText[] = rows.map(({ line, y }) => {
    const text = createText(
      { text: line.text, size: line.size * metre, color: line.color ?? '#e5e7eb', weight: line.weight ?? 'bold', facing: 'camera', depth },
      { around: group },
    )
    text.object.position.set(0, y * metre, 0)
    group.add(text.object)
    return text
  })

  let backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null
  const background = opts.background === undefined ? 'rgba(11,16,32,0.6)' : opts.background
  if (background !== null) {
    const fill = parseFill(background)
    const material = new THREE.MeshBasicMaterial({ color: fill.color, transparent: true, opacity: fill.opacity, depthWrite: false, toneMapped: false })
    backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    if (depth === 'over') {
      backdrop.layers.set(OVERLAY_LAYER)
      backdrop.renderOrder = 999
      material.depthTest = false
    }
    // Hidden until the lines are laid out, which is what says how wide it is.
    backdrop.visible = false
    faceCamera(backdrop, { around: group })
    group.add(backdrop)
    let widest = 0
    let pending = texts.length
    for (const text of texts)
      text.laidOut(([minX, , maxX]) => {
        widest = Math.max(widest, maxX - minX)
        pending -= 1
        if (pending > 0 || backdrop === null) return
        backdrop.scale.set(widest + padding * 2 * metre, total * metre, 1)
        backdrop.visible = true
      })
  }

  owned.set(group, () => {
    for (const text of texts) text.dispose()
    if (backdrop !== null) {
      backdrop.geometry.dispose()
      backdrop.material.dispose()
    }
  })
  return group
}

/** Free what a label owns: its texts and its backdrop. The caller removes it from the scene. */
export const disposeWorldLabel = (label: THREE.Object3D): void => {
  owned.get(label)?.()
  owned.delete(label)
}
