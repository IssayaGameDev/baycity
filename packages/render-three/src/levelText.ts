import type { TextDesc, TextItem } from '@mp/content'
import * as THREE from 'three'

import { createText, type TextStyle, type WorldText } from './text'

/**
 * A `Text` component's reading as a drawing style (ADR 0189): in the world, hidden behind what is in front of it.
 * The editor builds its viewport's texts from this too, so the two cannot draw a different sign.
 */
export const textStyleOf = (desc: TextDesc): Partial<TextStyle> => ({
  text: desc.text,
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
  /** Copy each item's pose, scale, visibility and fade onto its mesh. */
  sync: () => void
  /** The meshes, for the ambient-occlusion prepass to leave out (a glyph's quad would ghost there, ADR 0082). */
  objects: () => readonly THREE.Object3D[]
  dispose: () => void
}

export const addTexts = (scene: THREE.Scene, items: readonly TextItem[]): LevelTexts => {
  const drawn: { item: TextItem; text: WorldText }[] = items.map((item) => {
    const text = createText(textStyleOf(item))
    scene.add(text.object)
    return { item, text }
  })
  const sync = (): void => {
    for (const { item, text } of drawn) {
      const o = text.object
      o.visible = item.visible && item.opacity > 0
      o.position.set(item.position.x, item.position.y, item.position.z)
      o.quaternion.set(item.rotation.x, item.rotation.y, item.rotation.z, item.rotation.w)
      o.scale.set(item.scale.x * item.drawScale.x, item.scale.y * item.drawScale.y, item.scale.z * item.drawScale.z)
      text.fade(item.opacity)
    }
  }
  sync()
  return {
    sync,
    objects: () => drawn.map((d) => d.text.object),
    dispose: () => {
      for (const { text } of drawn) {
        scene.remove(text.object)
        text.dispose()
      }
    },
  }
}
