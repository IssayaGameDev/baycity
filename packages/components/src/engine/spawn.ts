import { SPAWN } from '@mp/content'
import { defineComponent } from '../define'

/** Where players enter the level. Replaces the `spawn` marker, which had a transform and nothing else. */
export const Spawn = defineComponent({
  type: SPAWN,
  menu: 'Gameplay',
  params: {},
  singleton: true,
})
