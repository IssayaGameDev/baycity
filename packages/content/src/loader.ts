import { axisAngleToQuat, eulerToQuat, lerpVec3, mulQuat, quat, rotateVec3, slerpQuat, vec3, type Quat, type Vec3 } from '@mp/core'
import type { PhysicsBody, PhysicsWorld, ShapeDesc } from '@mp/physics'

import type { Behavior, ColliderDesc, Level, LevelConfig, Marker, Transform, TriggerKind, Visual } from './types'

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

/** A gameplay trigger = a piece's own solid collider. The mode detects real contact by
 * matching `colliderHandle` against `CharacterBody.collisions()` each tick — no distance math.
 * `position` is the piece's world centre (e.g. for placing a respawn). */
export interface WorldTrigger {
  kind: TriggerKind
  colliderHandle: number
  position: Vec3
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
  prevPos: Vec3 // previous sim-tick position (for render interpolation)
  currPos: Vec3 // latest sim-tick position
}
interface RotateHandle {
  kind: 'rotate'
  body: PhysicsBody
  position: Vec3
  baseRotation: Quat
  behavior: Extract<Behavior, { kind: 'rotate' }>
  visual: VisualItem
  prevRot: Quat // previous sim-tick orientation
  currRot: Quat // latest sim-tick orientation
}
type BehaviorHandle = MoveHandle | RotateHandle

export interface LoadedLevel {
  config: LevelConfig
  markers: WorldMarker[]
  /** Physics-backed triggers (checkpoint/goal/hazard) — one sensor per non-spawn marker. */
  triggers: WorldTrigger[]
  visuals: VisualItem[]
  /** Advance clock-driven pieces one **sim step** to their pose at `nowMs`: moves the
   * kinematic bodies and records prev/curr poses. Call once per fixed tick, before
   * `world.step`, so physics and rendering share a timeline. */
  update: (nowMs: number) => void
  /** Set the visual poses to `alpha` (0..1) between the last two sim ticks — call each
   * render frame so clock-driven meshes are smooth and match the (interpolated) player. */
  render: (alpha: number) => void
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
  const triggers: WorldTrigger[] = []
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

      let body: PhysicsBody
      if (behavior.kind === 'move') {
        body = world.addKinematicBody({ position, rotation, shape })
        behaviors.push({ kind: 'move', body, base: position, behavior, visual, prevPos: { ...position }, currPos: { ...position } })
      } else if (behavior.kind === 'rotate') {
        body = world.addKinematicBody({ position, rotation, shape })
        behaviors.push({ kind: 'rotate', body, position, baseRotation: rotation, behavior, visual, prevRot: { ...rotation }, currRot: { ...rotation } })
      } else {
        body = world.addFixedBody({ position, rotation, shape })
      }
      // A trigger piece exposes its collider so the mode can detect real contact with it.
      if (piece.trigger !== undefined)
        triggers.push({ kind: piece.trigger, colliderHandle: body.colliderHandle, position: { ...position } })
    }
    for (const m of prefab.markers ?? []) pushMarker(m, origin, originRot)
  }
  for (const m of level.markers ?? []) pushMarker(m, vec3(0, 0, 0), quat())

  const update = (nowMs: number): void => {
    for (const h of behaviors) {
      if (h.kind === 'move') {
        const p = movePosition(h.base, h.behavior, nowMs)
        h.body.setNextKinematicTranslation(p)
        h.prevPos = h.currPos
        h.currPos = p
        h.visual.position = p // latest (a consumer that doesn't interpolate still gets a live pose)
      } else {
        const q = rotateOrientation(h.baseRotation, h.behavior, nowMs)
        h.body.setNextKinematicTranslation(h.position)
        h.body.setNextKinematicRotation(q)
        h.prevRot = h.currRot
        h.currRot = q
        h.visual.rotation = q
      }
    }
  }

  const render = (alpha: number): void => {
    for (const h of behaviors) {
      if (h.kind === 'move') h.visual.position = lerpVec3(h.prevPos, h.currPos, alpha)
      else h.visual.rotation = slerpQuat(h.prevRot, h.currRot, alpha)
    }
  }

  return { config: level.config, markers, triggers, visuals, update, render }
}
