import { rotateVec3, vec3, yawOf, type Vec3 } from '@mp/core'
import type { LoadedLevel } from '@mp/content'

/** The half of a snapshot entity that says where it is, and in whose frame. */
export interface BasedTransform {
  position: Vec3
  yaw: number
  /** The clock-driven piece being ridden (`baseIndex + 1`), or 0 for none. */
  base: number
}

/**
 * A peer's world transform from what the wire carried (v10, ADR 0021).
 *
 * Platform, because it is wire semantics: while `base` is non-zero the position and facing are expressed in
 * that clock-driven piece's frame, and undoing that is the only way the number means anything. Every game
 * reading a snapshot needs this and none of them should re-derive it.
 *
 * **Which pose matters.** `rendered` for anything drawn, so a rider sits still on the deck the eye can see;
 * the sim tick's pose for a collision proxy, which has to resolve against where physics has the deck. Getting
 * this wrong is the bug it was written for: a rider drawn 100 ms behind the platform they are standing on, up
 * to a metre out on a fast mover and visibly sliding as it turns.
 *
 * Falls back to treating the values as world-space when the piece is unknown, which is what a client that
 * somehow lacks it should do: slightly wrong beats nowhere.
 */
export const worldFromBase = (
  loaded: Pick<LoadedLevel, 'basePoseOf'> | null,
  e: BasedTransform,
  rendered: boolean,
): { position: Vec3; yaw: number } => {
  const pose = e.base === 0 ? undefined : loaded?.basePoseOf(e.base - 1, rendered ? 'render' : 'tick')
  if (pose === undefined) return { position: e.position, yaw: e.yaw }
  const p = rotateVec3(pose.rotation, e.position)
  return {
    position: vec3(pose.position.x + p.x, pose.position.y + p.y, pose.position.z + p.z),
    yaw: e.yaw + yawOf(pose.rotation),
  }
}
