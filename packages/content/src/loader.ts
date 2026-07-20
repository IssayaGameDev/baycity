import { axisAngleToQuat, eulerToQuat, mulQuat, quat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import type { PhysicsBody, PhysicsWorld, ShapeDesc } from '@mp/physics'

import type { Behavior, ColliderDesc, Level, LevelConfig, Marker, Transform, Visual } from './types'

/**
 * Turns level data into a live world: adds Rapier colliders (fixed for static pieces,
 * kinematic for clock-driven ones), collects world-space markers, and produces a
 * renderer-agnostic visual list. `update(now)` advances clock-driven behaviors (moving
 * and rotating bodies + their visuals) — a pure function of synced time, so all clients
 * agree. Headless (no rendering); shared by the game, bots, and the viewer.
 *
 * Transforms carry rotation (euler radians, XYZ): an instance's rotation composes with
 * each piece's, so a whole prefab can be placed rotated and a ramp is a tilted box. The
 * `rotate` behavior spins a kinematic body about a world axis.
 */
export interface WorldMarker {
  kind: 'spawn' | 'checkpoint' | 'goal' | 'hazard'
  position: Vec3
  radius?: number
}

/** One thing to draw. `position`/`rotation` are mutated by `update` for clock-driven pieces. */
export interface VisualItem {
  collider: ColliderDesc
  position: Vec3
  rotation: Quat
  style: string | undefined
  gltf: string | undefined
}

interface MoveHandle {
  kind: 'move'
  body: PhysicsBody
  base: Vec3
  behavior: Extract<Behavior, { kind: 'move' }>
  visual: VisualItem
}
interface RotateHandle {
  kind: 'rotate'
  body: PhysicsBody
  position: Vec3
  baseRotation: Quat
  behavior: Extract<Behavior, { kind: 'rotate' }>
  visual: VisualItem
}
type BehaviorHandle = MoveHandle | RotateHandle

export interface LoadedLevel {
  config: LevelConfig
  markers: WorldMarker[]
  visuals: VisualItem[]
  /** Advance clock-driven pieces to their pose at `nowMs`. */
  update: (nowMs: number) => void
}

const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)
const rotationOf = (t: Transform): Quat => (t.rotation !== undefined ? eulerToQuat(t.rotation) : quat())
const styleOf = (v: Visual | undefined): string | undefined => v?.style
const gltfOf = (v: Visual | undefined): string | undefined => (v?.kind === 'gltf' ? v.src : undefined)

const toShape = (c: ColliderDesc): ShapeDesc => {
  switch (c.kind) {
    case 'box':
      return { kind: 'cuboid', halfExtents: c.halfExtents }
    case 'capsule':
      return { kind: 'capsule', halfHeight: c.halfHeight, radius: c.radius }
    case 'ball':
      return { kind: 'ball', radius: c.radius }
    case 'cylinder':
      throw new Error('cylinder collider not supported yet (needs a physics-wrapper shape)')
  }
}

// Clock-driven translation: base offset along a (normalized) axis by amplitude·sin(2π·t/T).
const movePosition = (base: Vec3, b: Extract<Behavior, { kind: 'move' }>, nowMs: number): Vec3 => {
  const len = Math.hypot(b.axis.x, b.axis.y, b.axis.z) || 1
  const d = b.amplitude * Math.sin((nowMs / b.periodMs) * Math.PI * 2)
  return vec3(base.x + (b.axis.x / len) * d, base.y + (b.axis.y / len) * d, base.z + (b.axis.z / len) * d)
}

// Clock-driven orientation: base pose spun by θ = 2π·t/T about a world axis.
const rotateOrientation = (base: Quat, b: Extract<Behavior, { kind: 'rotate' }>, nowMs: number): Quat =>
  mulQuat(axisAngleToQuat(b.axis, (nowMs / b.periodMs) * Math.PI * 2), base)

export const instantiateLevel = (world: PhysicsWorld, level: Level): LoadedLevel => {
  const visuals: VisualItem[] = []
  const behaviors: BehaviorHandle[] = []
  const markers: WorldMarker[] = []
  const table = level.prefabs ?? {}

  const pushMarker = (m: Marker, origin: Vec3, originRot: Quat): void => {
    const position = add(origin, rotateVec3(originRot, m.transform.position))
    markers.push(m.kind === 'spawn' ? { kind: 'spawn', position } : { kind: m.kind, position, radius: m.radius })
  }

  for (const inst of level.instances) {
    const prefab = typeof inst.prefab === 'string' ? table[inst.prefab] : inst.prefab
    if (prefab === undefined) throw new Error(`prefab '${String(inst.prefab)}' not found in level.prefabs`)
    const origin = inst.transform.position
    const originRot = rotationOf(inst.transform)
    const behavior = inst.behavior ?? prefab.behavior ?? { kind: 'static' }

    for (const piece of prefab.pieces) {
      const position = add(origin, rotateVec3(originRot, piece.transform.position))
      const rotation = mulQuat(originRot, rotationOf(piece.transform))
      const shape = toShape(piece.collider)
      const visual: VisualItem = {
        collider: piece.collider,
        position: { ...position },
        rotation: { ...rotation },
        style: styleOf(piece.visual),
        gltf: gltfOf(piece.visual),
      }
      visuals.push(visual)

      if (behavior.kind === 'move') {
        const body = world.addKinematicBody({ position, rotation, shape })
        behaviors.push({ kind: 'move', body, base: position, behavior, visual })
      } else if (behavior.kind === 'rotate') {
        const body = world.addKinematicBody({ position, rotation, shape })
        behaviors.push({ kind: 'rotate', body, position, baseRotation: rotation, behavior, visual })
      } else {
        world.addFixedBody({ position, rotation, shape })
      }
    }
    for (const m of prefab.markers ?? []) pushMarker(m, origin, originRot)
  }
  for (const m of level.markers ?? []) pushMarker(m, vec3(0, 0, 0), quat())

  const update = (nowMs: number): void => {
    for (const h of behaviors) {
      if (h.kind === 'move') {
        const p = movePosition(h.base, h.behavior, nowMs)
        h.body.setNextKinematicTranslation(p)
        h.visual.position = p
      } else {
        const q = rotateOrientation(h.baseRotation, h.behavior, nowMs)
        h.body.setNextKinematicTranslation(h.position)
        h.body.setNextKinematicRotation(q)
        h.visual.rotation = q
      }
    }
  }
  return { config: level.config, markers, visuals, update }
}
