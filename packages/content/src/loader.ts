import { vec3, type Vec3 } from '@mp/core'
import type { PhysicsBody, PhysicsWorld, ShapeDesc } from '@mp/physics'

import type { Behavior, ColliderDesc, Level, LevelConfig, Marker, Visual } from './types'

/**
 * Turns level data into a live world: adds Rapier colliders (fixed for static pieces,
 * kinematic for clock-driven ones), collects world-space markers, and produces a
 * renderer-agnostic visual list. `update(now)` advances clock-driven behaviors (moving
 * bodies + their visuals) — a pure function of synced time, so all clients agree.
 * Headless (no rendering); shared by the game, bots, and the viewer.
 *
 * Rotation on transforms and `rotate` behaviors need collider-rotation support in the
 * physics wrapper — deferred to the kit phase (ramps/rotating bars). Positions only for now.
 */
export interface WorldMarker {
  kind: 'spawn' | 'checkpoint' | 'goal'
  position: Vec3
  radius?: number
}

/** One thing to draw. `position` is mutated by `update` for moving pieces. */
export interface VisualItem {
  collider: ColliderDesc
  position: Vec3
  style: string | undefined
  gltf: string | undefined
}

interface BehaviorHandle {
  body: PhysicsBody
  base: Vec3
  behavior: Extract<Behavior, { kind: 'move' }>
  visual: VisualItem
}

export interface LoadedLevel {
  config: LevelConfig
  markers: WorldMarker[]
  visuals: VisualItem[]
  /** Advance clock-driven pieces to their position at `nowMs`. */
  update: (nowMs: number) => void
}

const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)
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

// Clock-driven position: base offset along a (normalized) axis by amplitude·sin(2π·t/T).
const movePosition = (base: Vec3, b: Extract<Behavior, { kind: 'move' }>, nowMs: number): Vec3 => {
  const len = Math.hypot(b.axis.x, b.axis.y, b.axis.z) || 1
  const d = b.amplitude * Math.sin((nowMs / b.periodMs) * Math.PI * 2)
  return vec3(base.x + (b.axis.x / len) * d, base.y + (b.axis.y / len) * d, base.z + (b.axis.z / len) * d)
}

export const instantiateLevel = (world: PhysicsWorld, level: Level): LoadedLevel => {
  const visuals: VisualItem[] = []
  const behaviors: BehaviorHandle[] = []
  const markers: WorldMarker[] = []
  const table = level.prefabs ?? {}

  const pushMarker = (m: Marker, origin: Vec3): void => {
    const position = add(origin, m.transform.position)
    markers.push(m.kind === 'spawn' ? { kind: 'spawn', position } : { kind: m.kind, position, radius: m.radius })
  }

  for (const inst of level.instances) {
    const prefab = typeof inst.prefab === 'string' ? table[inst.prefab] : inst.prefab
    if (prefab === undefined) throw new Error(`prefab '${String(inst.prefab)}' not found in level.prefabs`)
    const origin = inst.transform.position
    const behavior = inst.behavior ?? prefab.behavior ?? { kind: 'static' }
    if (behavior.kind === 'rotate') throw new Error('rotate behavior not supported yet (needs kinematic rotation)')

    for (const piece of prefab.pieces) {
      const position = add(origin, piece.transform.position)
      const shape = toShape(piece.collider)
      const visual: VisualItem = { collider: piece.collider, position: { ...position }, style: styleOf(piece.visual), gltf: gltfOf(piece.visual) }
      visuals.push(visual)
      if (behavior.kind === 'move') {
        const body = world.addKinematicBody({ position, shape })
        behaviors.push({ body, base: position, behavior, visual })
      } else {
        world.addFixedBody({ position, shape })
      }
    }
    for (const m of prefab.markers ?? []) pushMarker(m, origin)
  }
  for (const m of level.markers ?? []) pushMarker(m, vec3(0, 0, 0))

  const update = (nowMs: number): void => {
    for (const h of behaviors) {
      const p = movePosition(h.base, h.behavior, nowMs)
      h.body.setNextKinematicTranslation(p)
      h.visual.position = p
    }
  }
  return { config: level.config, markers, visuals, update }
}
