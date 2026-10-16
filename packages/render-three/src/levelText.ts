import type { TextDesc, TextItem } from '@mp/content'
import * as THREE from 'three'

import { createText, type TextStyle, type WorldText } from './text'

/** A font asset's file, by id (ADR 0190); `null` for none or one the text library cannot read — Roboto then. */
export type FontUrlOf = (assetId: string) => string | null

/**
 * A `Text` component's reading as a drawing style (ADR 0189): in the world, hidden behind what is in front of it.
 * The editor builds its viewport's texts from this too, so the two cannot draw a different sign.
 */
export const textStyleOf = (desc: TextDesc, fontUrl: FontUrlOf = () => null): Partial<TextStyle> => ({
  text: desc.text,
  font: desc.font === '' ? null : fontUrl(desc.font),
  size: desc.size,
  color: desc.color,
  align: desc.align,
  width: desc.width,
  weight: desc.bold ? 'bold' : 'normal',
  facing: desc.facing,
  back: desc.back,
  depth: 'world',
})

/** The level's texts, drawn: posed from the loader's items every frame, as `addLights` poses its lights. */
export interface LevelTexts {
  /** Copy each item's pose, scale, visibility and fade onto its mesh, and its words when they changed (a countdown, ADR 0228). */
  sync: () => void
  /**
   * How much of an item the game lets show, 0 to 1, on top of its own fade (ADR 0213) — a sign a game fades in and
   * out at runtime. 1 until set; drawn from the next `sync`.
   */
  setShown: (item: TextItem, shown: number) => void
  /** The meshes, for the ambient-occlusion prepass to leave out (a glyph's quad would ghost there, ADR 0082). */
  objects: () => readonly THREE.Object3D[]
  dispose: () => void
}

export const addTexts = (scene: THREE.Scene, items: readonly TextItem[], fontUrl: FontUrlOf = () => null): LevelTexts => {
  const drawn: { item: TextItem; text: WorldText; said: string }[] = items.map((item) => {
    const text = createText(textStyleOf(item, fontUrl))
    scene.add(text.object)
    return { item, text, said: item.text }
  })
  const shown = new Map<TextItem, number>()
  const byItem = new Map(drawn.map((d) => [d.item, d]))
  /** Visibility and fade: the item's own, times what the game lets show. */
  const fadeOf = ({ item, text }: { item: TextItem; text: WorldText }): void => {
    const opacity = item.opacity * (shown.get(item) ?? 1)
    text.object.visible = item.visible && opacity > 0
    text.fade(opacity)
  }
  const sync = (): void => {
    for (const d of drawn) {
      const { item, text } = d
      // Laid out again only when the words change — a countdown's, ten times a second at most.
      if (item.text !== d.said) {
        d.said = item.text
        text.set({ text: item.text })
      }
      const o = text.object
      o.position.set(item.position.x, item.position.y, item.position.z)
      o.quaternion.set(item.rotation.x, item.rotation.y, item.rotation.z, item.rotation.w)
      o.scale.set(item.scale.x * item.drawScale.x, item.scale.y * item.drawScale.y, item.scale.z * item.drawScale.z)
      fadeOf(d)
    }
  }
  sync()
  return {
    sync,
    setShown: (item, k) => {
      shown.set(item, Math.min(1, Math.max(0, k)))
      // At once, not at the next `sync`: a game sets it after this frame's sync, and the frame is drawn after both —
      // so a text hidden from the start is never drawn for one frame first.
      const d = byItem.get(item)
      if (d !== undefined) fadeOf(d)
    },
    objects: () => drawn.map((d) => d.text.object),
    dispose: () => {
      for (const { text } of drawn) {
        scene.remove(text.object)
        text.dispose()
      }
    },
  }
}
