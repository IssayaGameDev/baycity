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

export interface PadChainOpts {
  id?: string
  pads?: number
  padSize?: number // square footprint of each pad (m)
  gap?: number // clear distance between pad edges along +x (m)
  rise?: number // height gained per pad (m); negative descends
  lateral?: number // peak-to-peak z offset, alternating each pad — a zig-zag (m)
  thickness?: number
  style?: string
}

/**
 * A run of separate pads along +x — the jump-to-jump obstacle. `gap` is the empty distance
 * between pad *edges*, which is the number the player's jump has to cover, so it maps straight
 * onto the measured envelope (docs/obstacles.md):
 *
 *   level ground   3.5 m maximum
 *   climbing       costs ≈0.35 m of reach per 1 m of `rise`
 *   descending     buys the same back
 *
 * `lateral` staggers the pads left/right, which makes the real jump the diagonal —
 * `hypot(gap, lateral)` — so a zig-zag needs a smaller `gap` than a straight run to stay
 * clearable. Nothing here validates that; the level's own test does (see gym.test.ts).
 */
export const padChain = (o: PadChainOpts = {}): Prefab => {
  const pads = o.pads ?? 5
  const padSize = o.padSize ?? 1.2
  const gap = o.gap ?? 2
  const rise = o.rise ?? 0
  const lateral = o.lateral ?? 0
  const thickness = o.thickness ?? 0.5
  const style = o.style ?? KIT_STYLE.platform
  const half = vec3(padSize / 2, thickness / 2, padSize / 2)
  const pitch = padSize + gap
  const pieces = Array.from({ length: pads }, (_, i) =>
    step(half, vec3(i * pitch, i * rise, lateral === 0 ? 0 : (i % 2 === 0 ? -lateral / 2 : lateral / 2)), style),
  )
  return { id: o.id ?? 'pad-chain', pieces }
}

export interface CurvedBeamOpts {
  id?: string
  radius?: number // radius of the beam's centre line (m) — smaller turns harder
  sweepDeg?: number // total turn; **signed**: positive curves toward +z, negative toward -z
  width?: number // beam width (m)
  segments?: number // straight pieces approximating the arc
  thickness?: number
  style?: string
}

/**
 * Two independent limits on how coarse a segment may be, because they bind at opposite ends:
 * `CURVE_SAGITTA` bounds how far the flat surface deviates from the true arc, which is what you
 * *feel* underfoot and which needs finer steps as the radius grows; `CURVE_MAX_FACET` bounds the
 * angle between neighbouring faces, which is what you *see*, and which needs finer steps as the
 * radius shrinks. Taking the smaller step satisfies both at every radius.
 */
const CURVE_SAGITTA = 0.004 // m
const CURVE_MAX_FACET = (4 * Math.PI) / 180 // rad

const curveGeometry = (o: CurvedBeamOpts) => {
  const radius = o.radius ?? 8
  const sweep = ((o.sweepDeg ?? 90) * Math.PI) / 180
  const dir = sweep >= 0 ? 1 : -1
  const total = Math.abs(sweep)
  // Step whose mid-arc deviation is CURVE_SAGITTA: sag = r(1 − cos(Δ/2)).
  const bySagitta = 2 * Math.acos(Math.max(-1, 1 - CURVE_SAGITTA / radius))
  const stepAngle = Math.min(bySagitta, CURVE_MAX_FACET)
  const segments = o.segments ?? Math.max(4, Math.ceil(total / stepAngle))
  return { radius, dir, total, segments }
}

/** Centre-line point and tangent frame at arc parameter `u`. */
const arcFrame = (radius: number, dir: number, u: number): { centre: Vec3; forward: Vec3; right: Vec3 } => ({
  centre: vec3(radius * Math.sin(u), 0, dir * radius * (1 - Math.cos(u))),
  forward: vec3(Math.cos(u), 0, dir * Math.sin(u)),
  // Horizontal normal, so the beam stays flat rather than banking into the turn.
  right: vec3(-dir * Math.sin(u), 0, Math.cos(u)),
})

/**
 * A beam that follows a circular arc, starting at the local origin heading **+x** and turning as it
 * goes. A straight beam only asks the player to hold one direction; an arc asks them to keep
 * changing it, and to bring the camera round with them, which is where the difficulty is.
 *
 * Each segment is a **convex prism through its eight exact corners** — not a box. The end faces of a
 * swept segment are perpendicular to the curve's tangent and therefore *not parallel to each other*,
 * which a box cannot represent at any subdivision: a box chain leaves notches at every join and has
 * to be fudged with overlap. Consecutive prisms here share their four end-face corners, so the
 * surface is watertight by construction, and the renderer draws the same points (ADR 0017) — the
 * mesh you see is the surface you stand on, not an approximation of it.
 *
 * Chain arcs into S-bends with `curvedBeamExit`: place the next instance at the exit point with
 * `rotation.y = -heading`.
 */
export const curvedBeam = (o: CurvedBeamOpts = {}): Prefab => {
  const { radius, dir, total, segments } = curveGeometry(o)
  const width = o.width ?? 0.8
  const thickness = o.thickness ?? 0.5
  const style = o.style ?? KIT_STYLE.platform
  const delta = total / segments
  const hw = width / 2
  const ht = thickness / 2

  // The four corners of the cross-section at arc parameter u, relative to `origin`.
  const ring = (u: number, origin: Vec3): Vec3[] => {
    const f = arcFrame(radius, dir, u)
    const c = vec3(f.centre.x - origin.x, f.centre.y - origin.y, f.centre.z - origin.z)
    return [
      vec3(c.x + f.right.x * hw, c.y + ht, c.z + f.right.z * hw),
      vec3(c.x - f.right.x * hw, c.y + ht, c.z - f.right.z * hw),
      vec3(c.x + f.right.x * hw, c.y - ht, c.z + f.right.z * hw),
      vec3(c.x - f.right.x * hw, c.y - ht, c.z - f.right.z * hw),
    ]
  }

  const pieces: Piece[] = Array.from({ length: segments }, (_, i) => {
    const u0 = i * delta
    const u1 = (i + 1) * delta
    // Piece origin is the segment's mid-arc point, so its transform carries the position and the
    // hull points stay local and small.
    const origin = arcFrame(radius, dir, (u0 + u1) / 2).centre
    return {
      collider: { kind: 'convex', points: [...ring(u0, origin), ...ring(u1, origin)] },
      transform: { position: origin },
      visual: { kind: 'primitive', style },
    }
  })
  return { id: o.id ?? 'curved-beam', pieces }
}

/** Where a `curvedBeam` ends, in its own local frame: the centre-line exit point, and how far the
 * heading has turned from the initial +x (radians, signed). */
export const curvedBeamExit = (o: CurvedBeamOpts = {}): { position: Vec3; headingRad: number } => {
  const { radius, dir, total } = curveGeometry(o)
  return { position: arcFrame(radius, dir, total).centre, headingRad: dir * total }
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
