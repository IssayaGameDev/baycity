import { defineComponent } from '../define'

/** Touching it kills. Distinct from falling past the level's `fallY`, which is config, not a component. */
export const Hazard = defineComponent({
  type: 'Hazard',
  menu: 'Gameplay',
  params: {},
  singleton: true,
  onContact: (_self, ctx) => ctx.effects.kill(),
})
