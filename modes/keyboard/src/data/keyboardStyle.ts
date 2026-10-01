import { defineDataType } from '@mp/components'

/**
 * A Keyboard Style (ADR 0181): Keyboard's first data type, the look a board will take its keys from. A placeholder
 * for now — one field, nothing reads it yet — standing in the menu and the pipeline until the style's real fields
 * are decided.
 */
export const KeyboardStyle = defineDataType({
  type: 'KeyboardStyle',
  label: 'Keyboard Style',
  menu: 'Keyboard/Keyboard Style',
  fields: {
    placeholder: { kind: 'color', default: '#ffffff', label: 'placeholder' },
  },
})

/** Every data type Keyboard declares: what its library's **New data** offers. */
export const KEYBOARD_DATA_TYPES = [KeyboardStyle]
