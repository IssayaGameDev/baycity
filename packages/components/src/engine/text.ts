import { TEXT } from '@mp/content'
import { defineComponent } from '../define'

/**
 * Text in the world (ADR 0189). Unity's TextMeshPro: written on the object, in its own XY plane and read from its
 * +Z — the blue axis toward the reader — so it turns and scales with the node; or, with `facing` on `camera`,
 * turned to each player's view like a nametag. Hidden behind what is in front of it, as any object is.
 *
 * Read by `textOf` in `@mp/content`, for the game and the editor alike; drawn by `createText` in
 * `@mp/render-three`. No collider: a sign that should be stood on has one beside it.
 */
export const Text = defineComponent({
  type: TEXT,
  menu: 'Rendering',
  params: {
    text: { kind: 'string', default: 'Text', multiline: true, label: 'text' },
    /** The em, in metres at scale 1 — a little more than a capital's height. The node's scale scales it. */
    size: { kind: 'number', default: 0.5, min: 0.01, max: 50, step: 0.05, label: 'font size' },
    color: { kind: 'color', default: '#ffffff', label: 'colour' },
    align: { kind: 'enum', options: ['left', 'center', 'right'], default: 'center', label: 'alignment' },
    /** Where lines wrap, in metres at scale 1. 0 never wraps: only the text's own line breaks. */
    width: { kind: 'number', default: 0, min: 0, max: 500, step: 0.1, label: 'wrap width' },
    bold: { kind: 'bool', default: false, label: 'bold' },
    facing: { kind: 'enum', options: ['object', 'camera'], default: 'object', label: 'facing' },
    /** From behind: mirrored, as Unity draws it, or not at all. A text facing the camera has no behind. */
    back: { kind: 'enum', options: ['mirrored', 'hidden'], default: 'mirrored', label: 'from behind', when: { param: 'facing', is: ['object'] } },
  },
  singleton: true,
})
