import { Collider, componentOn, defineComponent } from '@mp/components'
import { TEXT, type LoadedLevel, type WorldNode } from '@mp/content'
import { vec3, yawOf, type Vec3 } from '@mp/core'

import { StageGate } from './stageGate'
import { WinsPad } from './wins'

/** What an obstacle's sign says (Kodjo's wording). */
export const requiresLevelText = (level: number): string => `Requires Level ${level}`

/**
 * An obstacle's checkpoint, and what there is to know about the obstacle, in one place (ADR 0211, Kodjo's design).
 * On the InterLevel prefab's root, where the stage gate was, pointing at what is inside that prefab:
 *
 * - `teleport` — where the teleport window puts you: standing on that node, facing its +Z. Empty: this node.
 * - `trigger` — a trigger collider. Walking into it reaches the checkpoint, for good. Empty: never reached.
 * - `winsPad`, `wins` — what that pad pays, over its own `wins`.
 * - `sign`, `requiredLevel` — that Text reads "Requires Level X". The level gates nothing yet.
 *
 * The trigger is heard here (`contacts`, ADR 0210) and reported through `effects.progress`; the session tells the
 * game, which saves it. The pad's and the sign's values are set as the level loads (`drives`), so the game, its
 * rules and the editor all read the same ones.
 */
export const Obstacle = defineComponent({
  type: 'Obstacle',
  label: 'Obstacle',
  params: {
    teleport: { kind: 'nodeRef', label: 'teleport to' },
    trigger: { kind: 'componentRef', of: Collider.type, contacts: true, label: 'reached by' },
    winsPad: { kind: 'componentRef', of: WinsPad.type, label: 'wins pad' },
    wins: { kind: 'number', default: 1, min: 1, step: 1, label: 'wins' },
    sign: { kind: 'componentRef', of: TEXT, label: 'sign' },
    requiredLevel: { kind: 'number', default: 0, min: 0, step: 1, label: 'requires level' },
  },
  singleton: true,
  drives: (p) => [
    { ref: p.winsPad, type: WinsPad.type, params: { wins: p.wins } },
    { ref: p.sign, type: TEXT, params: { text: requiresLevelText(p.requiredLevel) } },
  ],
  onContact: (self, ctx, hit) => {
    // The trigger only: a collider of this node's own, if it has one, is not the way in.
    if (self.findComponent(self.params.trigger, Collider)?.colliderHandle === hit.colliderHandle) ctx.effects.progress(self.node)
  },
})

/** One checkpoint as the teleport window lists it. */
export interface CheckpointStop {
  /** 1-based, in Hierarchy order. */
  readonly number: number
  /** The node carrying the Obstacle, or the stage gate. */
  readonly node: WorldNode
  /** Where the character's origin goes: the landing node's position, raised by the character's stand-off. */
  readonly position: Vec3
  /** The way the landing node faces, as the character's yaw (`yawOf`: forward = `(sin yaw, 0, cos yaw)`). */
  readonly yaw: number
  /** What its being reached is saved under: the node's id, numbered from the second where two share one. */
  readonly key: string
  /** A stage gate is open without being reached, as every gate was (ADR 0202); an obstacle opens once reached. */
  readonly alwaysOpen: boolean
}

/**
 * Every checkpoint in the level, in Hierarchy order — depth first, parents before children, the order the loader
 * walks (`allNodes`), so one inside a prefab placement is numbered where the placement sits. An Obstacle, or a stage
 * gate until they are all replaced; a node with both is its Obstacle.
 */
export const checkpointsOf = (loaded: Pick<LoadedLevel, 'allNodes' | 'findNode'>, standOffset: number): CheckpointStop[] => {
  const seen = new Map<string, number>()
  const out: CheckpointStop[] = []
  for (const node of loaded.allNodes) {
    const obstacle = componentOn(node.components, Obstacle)
    const gate = obstacle === undefined && componentOn(node.components, StageGate) !== undefined
    if (obstacle === undefined && !gate) continue
    const landing = obstacle === undefined || obstacle.teleport === null ? undefined : loaded.findNode(node, obstacle.teleport)
    const at = landing ?? node
    const twin = seen.get(node.id) ?? 0
    seen.set(node.id, twin + 1)
    out.push({
      number: out.length + 1,
      node,
      position: vec3(at.position.x, at.position.y + standOffset, at.position.z),
      yaw: yawOf(at.rotation),
      key: twin === 0 ? node.id : `${node.id}#${twin + 1}`,
      alwaysOpen: gate,
    })
  }
  return out
}
