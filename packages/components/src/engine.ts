import { COLLIDER, MATERIAL_OVERRIDE, MESH, RENDERER, SPAWN } from '@mp/content'
import { defineComponent } from './define'

/**
 * The engine's own components — the ones the **loader** reads to build a world. Gameplay rules live in
 * `gameplay.ts` and are read by a mode instead.
 *
 * Unity draws the same line: `Collider` and `MeshRenderer` are engine types, not user scripts, and no
 * amount of component system makes them optional.
 *
 * The type names come from `@mp/content`, which is where the loader reads them: one spelling, so a rename
 * cannot leave the engine looking for a component nobody registers.
 */

/**
 * One collision shape, at an offset from the node's transform.
 *
 * **Repeatable**, which is the whole reason a node holds a list: a ramp with a lip, or a bumper pad with a
 * separate rim, was two `Piece`s before and is one node with two colliders now.
 *
 * `center` is what makes that worth having. Without an offset, a second collider sits exactly on the first and
 * is the same collider twice — so repeatability would be a claim rather than a feature. It is Unity's
 * `BoxCollider.center`, it defaults to the origin, and every migrated piece leaves it there.
 */
export const Collider = defineComponent({
  type: COLLIDER,
  params: {
    shape: { kind: 'collider', default: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } },
    center: { kind: 'vec3', default: { x: 0, y: 0, z: 0 }, label: 'center' },
  },
})

/**
 * **What** shape this node draws, when it is not its colliders. Unity's `MeshFilter`.
 *
 * Geometry only: a mesh with no `Renderer` beside it shows nothing, exactly as in Unity. The collider stays
 * authored, so a detailed prop still collides as the box somebody chose (ADR 0014).
 *
 * Its absence is meaningful, which is why this replaced a `source` enum on the old combined `Visual`: having a
 * `Mesh` *is* the answer to "does this draw a model or its colliders", so the enum — and the conditional field
 * that hid `model` when the answer was "colliders" — both went away (ADR 0039).
 */
export const Mesh = defineComponent({
  type: MESH,
  params: {
    model: { kind: 'asset', of: 'model', default: '', label: 'model' },
  },
  singleton: true,
})

/**
 * **That** this node draws, and with what surface. Unity's `MeshRenderer`.
 *
 * `Renderer` rather than `Material`, even though a material is its only parameter today: it is the *role* that
 * is being declared, and naming a component after one of its fields is the mistake `MaterialOverride` was
 * already making. Shadow-casting and a render layer are the realistic next fields, and neither belongs to
 * something called `Material`.
 *
 * - `Renderer`, no `Mesh` — draws **every** `Collider` on this node, each at its own centre. The greybox case,
 *   and most of the authored content.
 * - `Renderer` + `Mesh` — draws the mesh.
 * - `Mesh`, no `Renderer` — draws nothing. Unity's `MeshFilter` without a `MeshRenderer`.
 * - neither — draws nothing.
 *
 * `material: ''` means unsurfaced, which the viewport greyboxes.
 */
export const Renderer = defineComponent({
  type: RENDERER,
  params: {
    material: { kind: 'asset', of: 'material', default: '', label: 'material' },
  },
  singleton: true,
})

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

/** Where players enter the level. Replaces the `spawn` marker, which had a transform and nothing else. */
export const Spawn = defineComponent({
  type: SPAWN,
  params: {},
  singleton: true,
})

export const ENGINE_COMPONENTS = [Collider, Mesh, Renderer, MaterialOverride, Spawn]
