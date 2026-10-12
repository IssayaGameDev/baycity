import { componentOn, defineComponent } from '@mp/components'
import type { LoadedLevel } from '@mp/content'
import { vec3, yawOf, type Vec3 } from '@mp/core'

/**
 * A stage gate (ADR 0202): a place the teleport window sends a player to, standing where the node stands and
 * facing the way it faces (its +Z). Kodjo's calls: this game's own component, not the shared `Checkpoint`, whose
 * meaning — and later settings — are another game's.
 *
 * Numbered in Hierarchy order. No settings yet: being reached by passing through, and a Wins price to unlock,
 * are a later pass — every gate is open for now.
 */
export const StageGate = defineComponent({
  type: 'StageGate',
  label: 'Stage gate',
  params: {},
  singleton: true,
})

/** One gate as the teleport window lists it: its number, where a player stands, and which way they face. */
export interface StageGateStop {
  /** 1-based, in Hierarchy order. */
  readonly number: number
  /** Where the character's origin goes: the node's position, raised by the character's stand-off. */
  readonly position: Vec3
  /** The way the node faces, as the character's yaw (`yawOf`: forward = `(sin yaw, 0, cos yaw)`). */
  readonly yaw: number
}

/**
 * Every gate in the level, in Hierarchy order — depth first, parents before children, which is the order the
 * loader walks (`allNodes`), so a gate inside a prefab placement is numbered where the placement sits. A gate
 * needs no collider to be one.
 */
export const stageGatesOf = (loaded: Pick<LoadedLevel, 'allNodes'>, standOffset: number): StageGateStop[] =>
  loaded.allNodes
    .filter((n) => componentOn(n.components, StageGate) !== undefined)
    .map((n, i) => ({ number: i + 1, position: vec3(n.position.x, n.position.y + standOffset, n.position.z), yaw: yawOf(n.rotation) }))
