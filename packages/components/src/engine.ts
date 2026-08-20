import { COLLIDER, MATERIAL_OVERRIDE, SPAWN, VISUAL } from '@mp/content'
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
 * What this node draws.
 *
 * `source: 'collider'` draws **every** `Collider` on this node — the generalisation of today's one-piece,
 * one-mesh pairing. `source: 'model'` draws the mesh asset instead, and the colliders stay authored, so a
 * detailed prop still collides as the box somebody chose (ADR 0014).
 *
 * `material: ''` means unsurfaced, which the renderer greyboxes.
 *
 * **A node with no `Visual` draws nothing.** Today an omitted `Piece.visual` still greyboxes the collider;
 * as a component, absent has to mean absent, the way a GameObject with no renderer is invisible. Migration
 * therefore writes an explicit `Visual` onto every piece that relied on the old default, so nothing that
 * exists changes appearance.
 */
export const Visual = defineComponent({
  type: VISUAL,
  params: {
    source: { kind: 'enum', options: ['collider', 'model'], default: 'collider' },
    model: { kind: 'asset', of: 'model', default: '', label: 'model' },
    material: { kind: 'asset', of: 'material', default: '', label: 'material' },
  },
  singleton: true,
})

/**
 * Resurfaces this node and everything below it, beating each `Visual`'s own material.
 *
 * This is `PrefabInstance.material` (ADR 0028) as a component, kept because it is the fastest thing in the
 * editor: one click restyles a whole placement. Kodjo confirmed keeping it when the plan was approved.
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

export const ENGINE_COMPONENTS = [Collider, Visual, MaterialOverride, Spawn]
