import { defineComponent } from '../define'

/** Touching it saves this as the respawn point. Ordered by tree walk, which is what indexes them. */
export const Checkpoint = defineComponent({
  type: 'Checkpoint',
  menu: 'Gameplay',
  params: {},
  singleton: true,
  // The node, not an index: what counts as progress is the mode's business, and it is the mode that holds the
  // ordered list a saved index means anything against.
  onContact: (_self, ctx, hit) => ctx.effects.progress(hit.node),
})
