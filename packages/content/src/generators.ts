import { vec3, type Vec3 } from '@mp/core'

import { KIT_STYLE } from './kit'
import type { Piece, Prefab } from './types'

/**
 * Procedural level-data generators — pure functions that emit a composite `Prefab` (one
 * placeable structure of many step pieces). Build large repetitive structures without
 * hand-placing every box. Geometry only, like the kit.
 */

const step = (halfExtents: Vec3, position: Vec3, style: string, rotation?: Vec3): Piece => ({
  collider: { kind: 'box', halfExtents },
  transform: rotation !== undefined ? { position, rotation } : { position },
  visual: { kind: 'primitive', style },
})

export interface StaircaseOpts {
  id?: string
  steps?: number
  stepRun?: number // horizontal depth of each step along +x (m)
  stepRise?: number // height gained per step (m) — default kept under the controller's 0.4 m auto-step so it's walkable
  width?: number // z extent of each step (m)
  thickness?: number
  style?: string
}

/** A straight flight of steps ascending along +x. Default rise is walkable (auto-stepped,
 * no jump); pass a larger `stepRise` for a hop-per-step obstacle. */
export const staircase = (o: StaircaseOpts = {}): Prefab => {
  const steps = o.steps ?? 8
  const run = o.stepRun ?? 1.2
  const rise = o.stepRise ?? 0.3
  const width = o.width ?? 3
  const thickness = o.thickness ?? 0.5
  const style = o.style ?? KIT_STYLE.platform
  const half = vec3(run / 2, thickness / 2, width / 2)
  const pieces = Array.from({ length: steps }, (_, i) => step(half, vec3(i * run, i * rise, 0), style))
  return { id: o.id ?? 'staircase', pieces }
}

export interface SpiralStaircaseOpts {
  id?: string
  steps?: number
  radius?: number // radius of the step centres from the axis (m)
  stepRise?: number // height gained per step (m)
  stepAngleDeg?: number // angle turned per step (deg)
  length?: number // radial extent of each step (m)
  width?: number // tangential extent of each step (m)
  thickness?: number
  style?: string
}

/** A helical flight winding around the +y axis, each step rotated to lie radially. Default
 * rise is walkable (auto-stepped); pass a larger `stepRise` for a hop-per-step climb. */
export const spiralStaircase = (o: SpiralStaircaseOpts = {}): Prefab => {
  const steps = o.steps ?? 12
  const radius = o.radius ?? 5
  const rise = o.stepRise ?? 0.3
  const angleStep = ((o.stepAngleDeg ?? 30) * Math.PI) / 180
  const length = o.length ?? 3
  const width = o.width ?? 2
  const thickness = o.thickness ?? 0.4
  const style = o.style ?? KIT_STYLE.platform
  const half = vec3(length / 2, thickness / 2, width / 2)
  const pieces = Array.from({ length: steps }, (_, i) => {
    const a = i * angleStep
    // Position on the circle; rotate -a about +y so the step's long (local x) axis lies radial.
    return step(half, vec3(Math.cos(a) * radius, i * rise, Math.sin(a) * radius), style, vec3(0, -a, 0))
  })
  return { id: o.id ?? 'spiral-staircase', pieces }
}
