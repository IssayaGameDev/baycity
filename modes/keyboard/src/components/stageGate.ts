import { defineComponent } from '@mp/components'

/**
 * A stage gate (ADR 0202): a place the teleport window sends a player to, standing where the node stands and
 * facing the way it faces (its +Z). Replaced by the `Obstacle` (ADR 0211), and kept only until the levels on the box
 * have swapped theirs: a level naming a component the game does not know does not load. Listed by `checkpointsOf`,
 * always open.
 */
export const StageGate = defineComponent({
  type: 'StageGate',
  label: 'Stage gate',
  params: {},
  singleton: true,
})
