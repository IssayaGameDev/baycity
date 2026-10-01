import { describe, expect, it } from 'vitest'

import { dataMenuPath, defineDataType, newDataAsset, readData } from './data'

/** Data types (ADR 0181): Unity's ScriptableObject classes, declared with a component's parameter kinds. */

const Style = defineDataType({
  type: 'KeyboardStyle',
  label: 'Keyboard Style',
  menu: 'Keyboard/Keyboard Style',
  fields: {
    tint: { kind: 'color', default: '#ffffff' },
    gloss: { kind: 'number', default: 0.5, min: 0, max: 1 },
  },
})

describe('a data type', () => {
  it('makes a new asset at its defaults', () => {
    expect(newDataAsset(Style)).toEqual({ type: 'KeyboardStyle', fields: { tint: '#ffffff', gloss: 0.5 } })
  })

  it('reads an asset of its type, typed, with fields added since it was written at their defaults', () => {
    const read = readData(Style, { type: 'KeyboardStyle', fields: { tint: '#ff0000' } }, 'red.data.json')
    expect(read).toEqual({ tint: '#ff0000', gloss: 0.5 })
  })

  it('reads nothing of another type, and refuses a value its field does not take', () => {
    expect(readData(Style, { type: 'Other', fields: {} }, 'x')).toBeUndefined()
    expect(readData(Style, undefined, 'x')).toBeUndefined()
    expect(() => readData(Style, { type: 'KeyboardStyle', fields: { tint: 'reddish' } }, 'x')).toThrow(/tint/)
  })

  it('sits in New data at its menu path, or by its label when it has none', () => {
    expect(dataMenuPath(Style)).toEqual(['Keyboard', 'Keyboard Style'])
    expect(dataMenuPath(defineDataType({ type: 'Plain', fields: {} }))).toEqual(['Plain'])
  })
})
