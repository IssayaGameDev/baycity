import { Collider, componentOn, defineComponent } from '@mp/components'
import type { WorldNode } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

/**
 * Wins: the second currency, and the pad that pays it (ADR 0073).
 *
 * A **stage** is nothing the level declares. It is whatever platforms the editor puts between the spawn and a
 * `WinsPad`, and the pad is the whole of the stage's identity: touch it, bank its `wins`, and you are back at
 * the level's spawn to run it again. Falling anywhere is back to the same spawn — there are no checkpoints and
 * nothing locks a stage, both Kodjo's call.
 *
 * Headless, like every rule: the pad reports the touch through the one effect that already carries a node,
 * and the game's session (`rules.ts`) is what turns that into Wins and a teleport.
 */

/** The end of a stage. Stand on it: bank `wins`, go back to spawn. */
export const WinsPad = defineComponent({
  type: 'WinsPad',
  label: 'Wins pad',
  params: {
    /** What a touch pays — unless an Obstacle points at the pad: then its stage's, from the level's `World` (ADR 0222). */
    wins: { kind: 'number', default: 1, min: 1, step: 1, label: 'wins' },
  },
  singleton: true,
  onContact: (_self, ctx, hit) => ctx.effects.progress(hit.node),
})

/**
 * The top face of a pad, for a popup to leave from.
 *
 * A node's `position` is its centre, and a label born inside a slab is born clipped (ADR 0072). Reads the pad's
 * own box collider for the half-height; a pad with some other shape gets its centre, which is still on screen.
 */
export const padTop = (node: WorldNode): Vec3 => {
  const collider = componentOn(node.components, Collider)
  const lift = collider?.shape.kind === 'box' ? collider.shape.halfExtents.y : 0
  return vec3(node.position.x, node.position.y + lift, node.position.z)
}
