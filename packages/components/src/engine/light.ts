import { LIGHT } from '@mp/content'
import { defineComponent } from '../define'

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
  menu: 'Rendering',
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
