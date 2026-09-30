import { MATERIAL_OVERRIDE } from '@mp/content'
import { defineComponent } from '../define'

/**
 * Resurfaces this node and everything below it, beating each `Renderer`'s own material.
 *
 * This is `PrefabInstance.material` (ADR 0028) as a component, kept because it is the fastest thing in the
 * editor: one click restyles a whole placement. Kodjo confirmed keeping it when the plan was approved.
 *
 * Its name only started telling the truth once `Renderer` existed to be overridden — before that it was the
 * only way an object got a material at all, named as though it were an exception (ADR 0039).
 */
export const MaterialOverride = defineComponent({
  type: MATERIAL_OVERRIDE,
  params: {
    material: { kind: 'asset', of: 'material', default: '', label: 'material' },
  },
  singleton: true,
})
