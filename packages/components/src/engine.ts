import { COLLIDER, LIGHT, MATERIAL_OVERRIDE, RENDERER, SPAWN } from '@mp/content'
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
    /**
     * **Trigger**: detected on overlap, with no collision response (ADR 0054). Unity's `isTrigger`, Rapier's
     * sensor.
     *
     * Off by default, so every collider authored before this is unchanged. On, the shape stops being solid
     * entirely — it is not walked into, not stood on, and does not block the camera — but a rule on the same
     * node still fires when the character is inside it. That is what a kill plane wants, and what a solid
     * collider could not express: you would land on the thing meant to be empty space.
     */
    trigger: { kind: 'bool', default: false, label: 'trigger' },
  },
})

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

/**
 * A light on this node (ADR 0047). Unity's `Light`: one per object, its kind chosen by a field.
 *
 * Singleton, as in Unity — a node wanting two lights has two children. `directional` and `spot` shine along the
 * node's **forward** (`-Z` rotated by its transform); `point` ignores rotation; `ambient` and `hemisphere`
 * ignore the transform entirely, so moving one of those nodes does nothing (ADR 0048, Kodjo's call, made
 * knowing that).
 *
 * The **sun is not one of these.** It is `LevelConfig.sun`, because the sun and the sky are one input: one pair
 * of angles drives the key light, its shadow frustum and the sky's glow together (ADR 0046). A node would make
 * the sky chase something a person can drag.
 *
 * `castShadow` defaults **off**, and that is not timidity. Three renders forward, so every shadow-casting light
 * costs a whole extra scene render per frame — and a `point` light costs **six**, because its shadow is a cube
 * map. Ten shadowed point lights is sixty extra scene renders against a 16 ms budget that is still unmeasured.
 */
export const Light = defineComponent({
  type: LIGHT,
  params: {
    kind: { kind: 'enum', options: ['point', 'spot', 'directional', 'ambient', 'hemisphere'], default: 'point', label: 'kind' },
    color: { kind: 'color', default: '#ffffff', label: 'colour' },
    /**
     * The light coming *up*, for `hemisphere` only — the ground bounce a sky with a dark underside does not
     * provide. `color` is the half coming down (ADR 0048).
     */
    groundColor: { kind: 'color', default: '#808080', label: 'from below', when: { param: 'kind', is: ['hemisphere'] } },
    intensity: { kind: 'number', default: 4, min: 0, max: 50, step: 0.1, label: 'intensity' },
    /** Three's `distance`: where the falloff reaches zero. 0 is unbounded, which is also unbounded cost. */
    range: { kind: 'number', default: 12, min: 0, max: 200, step: 0.5, label: 'range', when: { param: 'kind', is: ['point', 'spot'] } },
    decay: { kind: 'number', default: 2, min: 0, max: 4, step: 0.05, label: 'falloff', when: { param: 'kind', is: ['point', 'spot'] } },
    angle: { kind: 'number', default: 40, min: 1, max: 89, step: 1, label: 'cone °', when: { param: 'kind', is: ['spot'] } },
    penumbra: { kind: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'edge soften', when: { param: 'kind', is: ['spot'] } },
    // Neither `ambient` nor `hemisphere` has a direction, so there is nothing for either to cast.
    castShadow: { kind: 'bool', default: false, label: 'shadows', when: { param: 'kind', is: ['point', 'spot', 'directional'] } },
  },
  singleton: true,
})

export const ENGINE_COMPONENTS = [Collider, Renderer, MaterialOverride, Spawn, Light]
