import { Collider, componentOn, defineComponent } from '@mp/components'
import { TEXT, type LoadedLevel, type WorldNode } from '@mp/content'
import { vec3, yawOf, type Vec3 } from '@mp/core'

import { WinsPad } from './wins'

/** What an obstacle's required-level text says (Kodjo's wording). */
export const requiresLevelText = (level: number): string => `Requires Level ${level}`

/** How long a text takes to fade in or out, in seconds (Kodjo's call, ADR 0213). */
export const TEXT_FADE_SECONDS = 0.3

/**
 * An obstacle's checkpoint, and what there is to know about the obstacle, in one place (ADR 0211, Kodjo's design).
 * On the InterLevel prefab's root, pointing at what is inside that prefab:
 *
 * - `teleport` — where the teleport window puts you: standing on that node, facing its +Z. Empty: this node.
 * - `trigger` — a trigger collider. Walking into it reaches the checkpoint, for good. Empty: never reached.
 * - `winsPad`, `wins` — what that pad pays, over its own `wins`.
 * - `requiredLevelText`, `requiredLevel` — that Text reads "Requires Level X". The level gates nothing yet.
 * - `wins` and `requiredLevel` are the level's `World`'s to set, by the stage row naming this Obstacle (ADR 0222), and
 *   hidden here.
 * - `safeZoneText` — a Text of its own words, shown while this is the obstacle ahead (ADR 0213).
 *
 * In the game both texts start hidden, and only the obstacle ahead of the player shows one (`shownText`).
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
    // Set by the level's `World` (ADR 0222), and edited there: hidden here.
    wins: { kind: 'number', default: 1, min: 1, step: 1, label: 'wins', hidden: true },
    requiredLevelText: { kind: 'componentRef', of: TEXT, label: 'required level text' },
    requiredLevel: { kind: 'number', default: 0, min: 0, step: 1, label: 'requires level', hidden: true },
    safeZoneText: { kind: 'componentRef', of: TEXT, label: 'safe zone text' },
  },
  singleton: true,
  drives: (p) => [
    { ref: p.winsPad, type: WinsPad.type, params: { wins: p.wins } },
    { ref: p.requiredLevelText, type: TEXT, params: { text: requiresLevelText(p.requiredLevel) } },
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
  /** The node carrying the Obstacle. */
  readonly node: WorldNode
  /** Where the character's origin goes: the landing node's position, raised by the character's stand-off. */
  readonly position: Vec3
  /** The way the landing node faces, as the character's yaw (`yawOf`: forward = `(sin yaw, 0, cos yaw)`). */
  readonly yaw: number
  /** What its being reached is saved under: the node's id, numbered from the second where two share one. */
  readonly key: string
  /** Where being past it is measured from: its trigger's object, else where the teleport lands (ADR 0213). */
  readonly pivot: Vec3
  /** The nodes of its two texts, where it has them (ADR 0213). */
  readonly safeZoneText: WorldNode | undefined
  readonly requiredLevelText: WorldNode | undefined
}

/**
 * Every checkpoint in the level, in `order` — the level's `World`'s stage rows (`stageOrderOf`, ADR 0222), so an Obstacle
 * it does not list is no checkpoint — or, without one, in Hierarchy order: depth first, parents before children, the
 * order the loader walks (`allNodes`), so one inside a prefab placement is numbered where the placement sits.
 */
export const checkpointsOf = (loaded: Pick<LoadedLevel, 'allNodes' | 'findNode'>, standOffset: number, order: readonly WorldNode[] | null = null): CheckpointStop[] => {
  const seen = new Map<string, number>()
  const out: CheckpointStop[] = []
  for (const node of order ?? loaded.allNodes) {
    const obstacle = componentOn(node.components, Obstacle)
    if (obstacle === undefined) continue
    const landing = obstacle.teleport === null ? undefined : loaded.findNode(node, obstacle.teleport)
    const at = landing ?? node
    const nodeOf = (ref: { node: string } | null | undefined): WorldNode | undefined => (ref === null || ref === undefined || ref.node === '' ? undefined : loaded.findNode(node, ref.node))
    const trigger = nodeOf(obstacle.trigger)
    const twin = seen.get(node.id) ?? 0
    seen.set(node.id, twin + 1)
    out.push({
      number: out.length + 1,
      node,
      position: vec3(at.position.x, at.position.y + standOffset, at.position.z),
      yaw: yawOf(at.rotation),
      key: twin === 0 ? node.id : `${node.id}#${twin + 1}`,
      pivot: trigger === undefined ? vec3(at.position.x, at.position.y, at.position.z) : vec3(trigger.position.x, trigger.position.y, trigger.position.z),
      safeZoneText: nodeOf(obstacle.safeZoneText),
      requiredLevelText: nodeOf(obstacle.requiredLevelText),
    })
  }
  return out
}

/** Which text one obstacle shows (ADR 0213). */
export interface ShownText {
  readonly stop: CheckpointStop
  readonly which: 'safeZone' | 'requiredLevel'
}

/**
 * The one text the player sees (ADR 0213, Kodjo's calls): the obstacle ahead's Safe zone, and its "Requires Level X"
 * instead while inside its trigger. `current` is the obstacle the player is on (ADR 0212), `inside` whether they are in
 * its trigger now, `at` where they are.
 *
 * From the spawn the first obstacle is ahead. Out of the current one's trigger, past its pivot along the way its
 * teleport faces (forward, Kodjo's pick) the next one is ahead; short of it, it still is — they turned back. `null`
 * when nothing is ahead.
 */
export const shownText = (stops: readonly CheckpointStop[], current: WorldNode | null, inside: boolean, at: Vec3): ShownText | null => {
  const k = current === null ? -1 : stops.findIndex((s) => s.node === current)
  const here = stops[k]
  const obstacleFrom = (i: number): ShownText | null => {
    const stop = stops[i]
    return stop === undefined ? null : { stop, which: 'safeZone' }
  }
  if (here === undefined) return obstacleFrom(0)
  if (inside) return { stop: here, which: 'requiredLevel' }
  const past = (at.x - here.pivot.x) * Math.sin(here.yaw) + (at.z - here.pivot.z) * Math.cos(here.yaw) > 0
  return obstacleFrom(past ? k + 1 : k)
}
