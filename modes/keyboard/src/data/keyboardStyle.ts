import { defineDataType } from '@mp/components'

/**
 * A Keyboard Style (ADR 0181, ADR 0182): the look boards share, named by each board's `style`. Read by the drawing
 * through `keyColoursAt`; a board with none wears the plain look.
 */
export const KeyboardStyle = defineDataType({
  type: 'KeyboardStyle',
  label: 'Keyboard Style',
  menu: 'Keyboard/Keyboard Style',
  fields: {
    /**
     * The colours a board's keys draw from: each key picks a row by weight — a cap colour with its own letter colour,
     * as a keycap set pairs them. A letter left on auto is picked to read on that cap.
     */
    keys: {
      kind: 'list',
      label: 'key colours',
      item: {
        cap: { kind: 'color', default: '#e8e6e1', label: 'cap' },
        letter: { kind: 'color', default: '', optional: true, label: 'letter' },
        weight: { kind: 'number', default: 1, min: 0, step: 0.5, label: 'weight' },
      },
      default: [{ cap: '#e8e6e1', letter: '#2b2b31', weight: 1 }],
    },
    /** How far each cap's brightness may stray from its colour, as a fraction: 0 is every key exactly its colour. */
    jitter: { kind: 'number', default: 0, min: 0, max: 0.3, step: 0.01, label: 'shade jitter' },
  },
})

/** Every data type Keyboard declares: what its library's **New data** offers. */
export const KEYBOARD_DATA_TYPES = [KeyboardStyle]
