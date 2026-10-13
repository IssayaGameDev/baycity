// @vitest-environment happy-dom
import type { TextItem } from '@mp/content'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { addTexts } from './levelText'

/** What a game lets a level text show (ADR 0213): on top of its own fade, and at once. */
describe('a level text a game fades', () => {
  it('hides at once when set to none, and shows again as set', () => {
    const item: TextItem = {
      ...{ text: 'Safe Zone', font: '', size: 1, color: '#ffffff', align: 'center', width: 0, bold: false, facing: 'object', back: 'mirrored' },
      node: 'safe',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      drawScale: { x: 1, y: 1, z: 1 },
      visible: true,
      opacity: 1,
    }
    const texts = addTexts(new THREE.Scene(), [item])
    const drawn = texts.objects()[0]!
    expect(drawn.visible, 'shown until a game says otherwise').toBe(true)
    texts.setShown(item, 0)
    expect(drawn.visible, 'hidden at once, before the next sync').toBe(false)
    texts.sync()
    expect(drawn.visible, 'and stays hidden through one').toBe(false)
    texts.setShown(item, 0.5)
    expect(drawn.visible).toBe(true)
    texts.dispose()
  })
})
