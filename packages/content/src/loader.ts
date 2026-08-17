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
  rotation: Quat // fixed orientation (a mover does not spin)
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
  prevAngle: number // spin angle (rad) at the previous sim tick
  currAngle: number // spin angle (rad) at the latest sim tick
}
type BehaviorHandle = MoveHandle | RotateHandle

export interface LoadedLevel {
  config: LevelConfig
  markers: WorldMarker[]
  /** Physics-backed triggers (checkpoint/goal/hazard) — one sensor per non-spawn marker. */
  triggers: WorldTrigger[]
  visuals: VisualItem[]
  /**
   * Advance clock-driven pieces one **sim step** to their pose at `nowMs`: moves the kinematic
   * bodies and records prev/curr poses. Call once per fixed tick, before `world.step`, so physics
   * and rendering share a timeline.
   *
   * `ridingColliderHandle` is the collider a character is currently riding, if any (from
   * `CharacterState.base`). That one piece is posed with **zero derived velocity**, so Rapier's
   * character controller does not also carry the rider — the rider carries itself, exactly, and a
   * double contribution would move it at 2× the platform. Every other piece keeps its normal
   * kinematic velocity, which is what makes a moving piece *push* a character it sweeps into (a
   * spinning bar knocking you off a ledge). Freezing everything kills that push; freezing nothing
   * makes riding unreliable. Only the ridden piece needs it.
   */
  update: (nowMs: number, ridingColliderHandle?: number) => void
  /** Set the visual poses to `alpha` (0..1) between the last two sim ticks — call each
   * render frame so clock-driven meshes are smooth and match the (interpolated) player. */
  render: (alpha: number) => void
  /**
   * Current world pose of the clock-driven piece owning `colliderHandle`, or `undefined` if
   * that collider is static (nothing to ride). A character standing on the piece keeps its
   * own position in this frame and re-derives it each tick, so it tracks translation and spin
   * exactly (`stepCharacter`'s `platforms` argument). Call after `update(now)`.
   */
  basePose: (colliderHandle: number) => { position: Vec3; rotation: Quat } | undefined
}

const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)
const mul = (a: Vec3, b: Vec3): Vec3 => vec3(a.x * b.x, a.y * b.y, a.z * b.z)
const rotationOf = (t: Transform): Quat => (t.rotation !== undefined ? eulerToQuat(t.rotation) : quat())
const scaleOf = (t: Transform): Vec3 => t.scale ?? vec3(1, 1, 1)
const styleOf = (v: Visual | undefined): string | undefined => v?.style
const gltfOf = (v: Visual | undefined): string | undefined => (v?.kind === 'gltf' ? v.src : undefined)

// Bake a per-axis scale into a collider's dimensions (Unity's lossy-scale → shape bake). Ball
// and capsule can't represent non-uniform scale, so they take a uniform-ish approximation.
const scaleCollider = (c: ColliderDesc, s: Vec3): ColliderDesc => {
  switch (c.kind) {
    case 'box':
      return { kind: 'box', halfExtents: mul(c.halfExtents, s) }
    case 'ball':
      return { kind: 'ball', radius: c.radius * ((s.x + s.y + s.z) / 3) }
    case 'capsule':
      return { kind: 'capsule', halfHeight: c.halfHeight * s.y, radius: c.radius * ((s.x + s.z) / 2) }
    case 'cylinder':
      return { kind: 'cylinder', halfHeight: c.halfHeight * s.y, radius: c.radius * ((s.x + s.z) / 2) }
    case 'convex':
      // Exact under any scale, unlike ball/capsule — a scaled convex hull is still that hull.
      return { kind: 'convex', points: c.points.map((p) => mul(p, s)) }
  }
}

const toShape = (c: ColliderDesc): ShapeDesc => {
  switch (c.kind) {
    case 'box':
      return { kind: 'cuboid', halfExtents: c.halfExtents }
    case 'capsule':
      return { kind: 'capsule', halfHeight: c.halfHeight, radius: c.radius }
    case 'ball':
      return { kind: 'ball', radius: c.radius }
    case 'convex':
      return { kind: 'convex', points: c.points }
    case 'cylinder':
      throw new Error('cylinder collider not supported yet (needs a physics-wrapper shape)')
  }
}

// Clock-driven translation: eased out-and-back from home (base). Displacement runs 0 → distance
// → 0 over one period via (1−cos)/2, so it starts and ends at rest. `base` is the home position.
const movePosition = (base: Vec3, b: Extract<Behavior, { kind: 'move' }>, nowMs: number): Vec3 => {
  const len = Math.hypot(b.axis.x, b.axis.y, b.axis.z) || 1
  const d = (b.distance * (1 - Math.cos((nowMs / b.periodMs) * Math.PI * 2))) / 2
  return vec3(base.x + (b.axis.x / len) * d, base.y + (b.axis.y / len) * d, base.z + (b.axis.z / len) * d)
}

// Clock-driven orientation: base pose spun by θ = 2π·t/T about a world axis.
const spinAngle = (b: Extract<Behavior, { kind: 'rotate' }>, nowMs: number): number => (nowMs / b.periodMs) * Math.PI * 2
const rotateOrientation = (base: Quat, b: Extract<Behavior, { kind: 'rotate' }>, nowMs: number): Quat =>
  mulQuat(axisAngleToQuat(b.axis, spinAngle(b, nowMs)), base)

export const instantiateLevel = (world: PhysicsWorld, level: Level): LoadedLevel => {
  const visuals: VisualItem[] = []
  const behaviors: BehaviorHandle[] = []
  const markers: WorldMarker[] = []
  const triggers: WorldTrigger[] = []
  // Clock-driven pieces by collider handle — the lookup `carryDelta` needs, since a rider
  // only knows the handle its feet reported.
  const movers = new Map<number, BehaviorHandle>()
  const table = level.prefabs ?? {}

  const pushMarker = (m: Marker, origin: Vec3, originRot: Quat, originScale: Vec3): void => {
    const position = add(origin, rotateVec3(originRot, mul(originScale, m.transform.position)))
    markers.push(m.kind === 'spawn' ? { kind: 'spawn', position } : { kind: m.kind, position, radius: m.radius })
  }

  for (const inst of level.instances) {
    const prefab = typeof inst.prefab === 'string' ? table[inst.prefab] : inst.prefab
    if (prefab === undefined) throw new Error(`prefab '${String(inst.prefab)}' not found in level.prefabs`)
    const origin = inst.transform.position
    const originRot = rotationOf(inst.transform)
    const originScale = scaleOf(inst.transform)

    for (const piece of prefab.pieces) {
      // Per-piece behavior, most-specific wins: piece → instance → prefab → static.
      const behavior = piece.behavior ?? inst.behavior ?? prefab.behavior ?? { kind: 'static' }
      // Instance scale scales the piece's local offset; total scale (instance ⊗ piece) bakes into dims.
      const totalScale = mul(originScale, scaleOf(piece.transform))
      const position = add(origin, rotateVec3(originRot, mul(originScale, piece.transform.position)))
      const rotation = mulQuat(originRot, rotationOf(piece.transform))
      const collider = scaleCollider(piece.collider, totalScale)
      const shape = toShape(collider)
      const visual: VisualItem = {
        collider,
        position: { ...position },
        rotation: { ...rotation },
        style: styleOf(piece.visual),
        gltf: gltfOf(piece.visual),
      }
      visuals.push(visual)

      let body: PhysicsBody
      if (behavior.kind === 'move') {
        body = world.addKinematicBody({ position, rotation, shape })
        const h: BehaviorHandle = { kind: 'move', body, base: position, rotation, behavior, visual, prevPos: { ...position }, currPos: { ...position } }
        behaviors.push(h)
        movers.set(body.colliderHandle, h)
      } else if (behavior.kind === 'rotate') {
        body = world.addKinematicBody({ position, rotation, shape })
        const h: BehaviorHandle = {
          kind: 'rotate',
          body,
          position,
          baseRotation: rotation,
          behavior,
          visual,
          prevRot: { ...rotation },
          currRot: { ...rotation },
          prevAngle: 0,
          currAngle: 0,
        }
        behaviors.push(h)
        movers.set(body.colliderHandle, h)
      } else {
        body = world.addFixedBody({ position, rotation, shape })
      }
      // A trigger piece exposes its collider so the mode can detect real contact with it.
      if (piece.trigger !== undefined)
        triggers.push({ kind: piece.trigger, colliderHandle: body.colliderHandle, position: { ...position } })
    }
    for (const m of prefab.markers ?? []) pushMarker(m, origin, originRot, originScale)
  }
  for (const m of level.markers ?? []) pushMarker(m, vec3(0, 0, 0), quat(), vec3(1, 1, 1))

  // Poses are seeded at the authored home, but the first `update` lands wherever the piece is in
  // its cycle at that clock time — a phase-dependent jump of up to `distance` (or a whole turn).
  // Priming makes the first step report no motion, so that jump is never interpolated as travel.
  let primed = false

  // Normal kinematic posing: Rapier derives `(next − current)/dt` as the body's velocity, which is
  // what lets it push a character the piece sweeps into.
  const pose = (body: PhysicsBody, position: Vec3, rotation: Quat): void => {
    body.setNextKinematicTranslation(position)
    body.setNextKinematicRotation(rotation)
  }

  /**
   * Pose with **zero derived velocity**: move the body outright, and target the same pose so
   * `(next − current)/dt` comes out zero. Used only for the piece a character is riding — see the
   * note on `update`. The piece still travels exactly as far; only its reported velocity differs.
   */
  const poseFrozen = (body: PhysicsBody, position: Vec3, rotation: Quat): void => {
    body.setPosition(position)
    body.setRotation(rotation)
    pose(body, position, rotation)
  }

  const update = (nowMs: number, ridingColliderHandle?: number): void => {
    for (const h of behaviors) {
      const poseIt = h.body.colliderHandle === ridingColliderHandle ? poseFrozen : pose
      if (h.kind === 'move') {
        const p = movePosition(h.base, h.behavior, nowMs)
        poseIt(h.body, p, h.rotation)
        h.prevPos = primed ? h.currPos : p
        h.currPos = p
        h.visual.position = p // latest (a consumer that doesn't interpolate still gets a live pose)
      } else {
        const q = rotateOrientation(h.baseRotation, h.behavior, nowMs)
        const angle = spinAngle(h.behavior, nowMs)
        poseIt(h.body, h.position, q)
        h.prevRot = primed ? h.currRot : q
        h.currRot = q
        h.prevAngle = primed ? h.currAngle : angle
        h.currAngle = angle
        h.visual.rotation = q
      }
    }
    primed = true
  }

  // The frame a rider keeps its position in: the pose the last `update` put this piece at. Taken
  // from the computed pose rather than read back off the body, because an unfrozen kinematic body
  // does not actually reach its target until `world.step` — reading the body would make the answer
  // depend on whether the caller had stepped yet, which is a trap. A kinematic body always reaches
  // its target, so the two agree from `world.step` onward.
  const basePose = (colliderHandle: number): { position: Vec3; rotation: Quat } | undefined => {
    const h = movers.get(colliderHandle)
    if (h === undefined) return undefined
    return h.kind === 'move' ? { position: h.currPos, rotation: h.rotation } : { position: h.position, rotation: h.currRot }
  }

  const render = (alpha: number): void => {
    for (const h of behaviors) {
      if (h.kind === 'move') h.visual.position = lerpVec3(h.prevPos, h.currPos, alpha)
      else h.visual.rotation = slerpQuat(h.prevRot, h.currRot, alpha)
    }
  }

  return { config: level.config, markers, triggers, visuals, update, render, basePose }
}
