import { describe, expect, it } from 'vitest'
import { buildDatabase, type AssetEntry } from '@mp/content'

import { assetRefusal } from './assetRefusal'

/** Why an asset cannot fill a reference field (ADR 0176): the rule the pickers list by (ADR 0161), as a reason. */

const entry = (path: string, kind: AssetEntry['kind']): AssetEntry => ({ id: `id-${path}`, path, kind, name: path.slice(path.lastIndexOf('/') + 1).split('.')[0]! })
const DB = buildDatabase([
  entry('assets/materials/red.mat.json', 'material'),
  entry('keyboard/assets/materials/key.mat.json', 'material'),
  entry('assets/textures/brick.png', 'texture'),
  entry('assets/fonts/pixel.ttf', 'font'),
  entry('assets/fonts/round.woff2', 'font'),
])

describe('an asset dropped on a reference field', () => {
  it('fits when it is the kind asked for and this document may use it', () => {
    expect(assetRefusal(DB, 'material', 'id-assets/materials/red.mat.json', 'keyboard')).toBeNull()
    expect(assetRefusal(DB, 'material', 'id-keyboard/assets/materials/key.mat.json', 'keyboard')).toBeNull()
  })

  it('says why when it does not', () => {
    expect(assetRefusal(DB, 'material', 'id-assets/textures/brick.png', 'keyboard')).toBe('this takes a material, not a texture')
    expect(assetRefusal(DB, 'material', 'id-keyboard/assets/materials/key.mat.json', 'obby')).toBe('key belongs to another game')
    expect(assetRefusal(DB, 'material', 'id-keyboard/assets/materials/key.mat.json', null)).toBe("key is a game's own, and this is Shared")
    expect(assetRefusal(DB, 'material', 'nothing', 'keyboard')).toBe('not in the project')
  })

  /** A Text's font (ADR 0190): any the text library reads, and a woff2 refused with what to do about it. */
  it('takes a font a text can draw with, and refuses a woff2', () => {
    expect(assetRefusal(DB, 'font', 'id-assets/fonts/pixel.ttf', 'keyboard')).toBeNull()
    expect(assetRefusal(DB, 'font', 'id-assets/fonts/round.woff2', 'keyboard')).toMatch(/convert it to woff, ttf or otf/)
  })
})
