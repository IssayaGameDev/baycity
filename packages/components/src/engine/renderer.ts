import { RENDERER } from '@mp/content'
import { defineComponent } from '../define'

/**
 * **What** this node draws, and with what surface — shown as **Mesh Renderer** (ADR 0153): Unity's
 * `MeshRenderer` with its `MeshFilter` folded in, since nothing drew one without the other. The `Mesh` component that
 * was the `MeshFilter` is gone; the fold moved every one in.
 *
 * - `model` — an uploaded model's asset id, or a **built-in shape** (`builtin:box`, `builtin:rounded-box`,
 *   `builtin:sphere`, `builtin:capsule`, ADR 0090): a unit shape sized by the node's scale, and the editor keeps
 *   the node's colliders at the matching unit shape, so scale is the one size. **Empty draws every `Collider`**
 *   on the node, each at its own centre — the greybox case. A detailed prop still collides as the shape
 *   somebody chose (ADR 0014).
 * - `material` — `''` is unsurfaced, which the viewport greyboxes.
 *
 * No `Renderer`, nothing drawn. Still `Renderer` in the file, so what a placement overrides on one keeps its
 * id; and `Renderer` rather than `Material` (ADR 0039) — shadow-casting and a render layer are the realistic
 * next fields.
 */
export const Renderer = defineComponent({
  type: RENDERER,
  label: 'Mesh Renderer',
  params: {
    model: { kind: 'asset', of: 'model', default: '', label: 'model' },
    material: { kind: 'asset', of: 'material', default: '', label: 'material' },
  },
  singleton: true,
})
