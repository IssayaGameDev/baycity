import { eulerToQuat, lerpVec3, mulQuat, quat, rotateVec3, slerpQuat, vec3, type Quat, type Vec3 } from '@mp/core'
import type { PhysicsBody, PhysicsWorld, ShapeDesc } from '@mp/physics'

import { visualMaterial, visualModel } from './assets'
import { isAnimated, poseAt } from './track'
import { effectivePieces, resolvePrefab } from './resolve'
import type { Behavior, ColliderDesc, Level, LevelConfig, Marker, PrefabInstance, Transform, Trigger } from './types'

/**
 * Turns level data into a live world: adds Rapier colliders (fixed for static pieces,
 * kinematic for clock-driven ones), collects world-space markers, and produces a
 * renderer-agnostic visual list. `update(now)` advances clock-driven behaviors (moving
 * and rotating bodies + their visuals) — a pure function of synced time, so all clients
 * agree. Headless (no rendering); shared by the game, bots, and the viewer.
 *
 * **Being replaced.** `nodeLoader.ts` does this for a node tree (PLAN-component-system, C1); this file is
 * kept only so the equivalence tests can load the same content both ways, and goes with the legacy schema
 * in stage C1.4. The pure helpers below (`scaleCollider`, `toShape`, …) are shared, not duplicated.
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

/**
 * A gameplay trigger = a piece's own solid collider. The mode detects real contact by matching
 * `colliderHandle` against `CharacterBody.collisions()` each tick — no distance math. `position` is the
 * piece's world centre (e.g. for placing a respawn).
 *
 * An intersection with `Trigger` rather than a copy of its fields: `t.kind` still reads the same everywhere,
 * and narrowing on it gives the kind's own parameters (a bumper's `power`) with no second lookup.
 */
export type WorldTrigger = Trigger & {
  colliderHandle: number
  position: Vec3
}

/** One thing to draw. `position`/`rotation` are mutated by `update` for clock-driven pieces. */
export interface VisualItem {
  collider: ColliderDesc
  position: Vec3
  rotation: Quat
  /** Model asset id, when this piece draws a mesh instead of its collider's shape. */
  model: string | undefined
  /** Material asset id. Absent means nobody has chosen a surface, and the renderer greyboxes it. */
  material: string | undefined
}

/**
 * One animated frame in the placement tree: a placed instance, or a piece inside one.
 *
 * Both are the same shape on purpose. Both carry an optional behavior and both compose onto a parent, so
 * arbitrary nesting is one loop over a flat list rather than a special case per depth — and a piece is
 * just a leaf, which is why a piece's own `move` still works exactly as it did.
 *
 * `worldPos`/`worldRot` are recomputed every tick for animated frames. A static subtree is evaluated once
 * at load and never again, so a level with no movers costs what it always did.
 */
interface Frame {
  /**
   * The authored transform, kept rather than pre-converted: a track is evaluated against it every tick
   * (its keys may leave a channel alone, which then means "whatever was authored"), so the base pose has
   * to survive as data rather than as a starting quaternion.
   */
  base: Transform
  /** Accumulated scale of the ancestors — what scales *this* frame's own local offset. */
  parentScale: Vec3
  /** `parentScale` times this frame's own scale — what scales its children and its collider. */
  scale: Vec3
  behavior: Behavior
  parent: Frame | null
  /** This frame or any ancestor moves, so anything under it needs a kinematic body. */
  animated: boolean
  worldPos: Vec3
  worldRot: Quat
}

/**
 * A piece whose world pose changes over time. One record whatever the reason it moves — its own
 * behavior, an ancestor's, or both at once — because a child of a rotating parent translates *and*
 * spins, and the old split between a move handle and a rotate handle could not express that.
 */
interface Dynamic {
  frame: Frame
  body: PhysicsBody
  visual: VisualItem
  prevPos: Vec3 // previous sim-tick pose (for render interpolation and for taking a velocity)
  prevRot: Quat
  currPos: Vec3 // latest sim-tick pose — what physics resolved against
  currRot: Quat
  renderPos: Vec3 // what `render(alpha)` last drew — the pose a rider has to be placed against
  renderRot: Quat
}

/** Which of a clock-driven piece's three known poses to read — see `LoadedLevel.basePoseOf`. */
export type BasePhase = 'render' | 'tick' | 'prev'

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
  /**
   * Stable index of the clock-driven piece owning `colliderHandle`, or `undefined` if that collider is
   * static. **Stable across clients**, because every one instantiates the same level JSON in the same
   * order — which is what makes it safe to put on the wire as a rider's movement base (ADR 0021). A
   * Rapier collider handle would happen to match today and is not a promise.
   */
  baseIndex: (colliderHandle: number) => number | undefined
  /**
   * Pose of the clock-driven piece with that index, or `undefined` if there is none.
   *
   * Which pose matters, and that is why they are named: `render` is the interpolated pose the last
   * `render(alpha)` drew, so it is where the deck visibly is and where a rider must be placed to sit still
   * on it; `tick` is the latest sim tick's, which is what physics resolved against and what a collision
   * proxy wants; `prev` is the tick before that, which exists so a velocity can be taken across a known
   * interval.
   */
  basePoseOf: (index: number, phase: BasePhase) => { position: Vec3; rotation: Quat } | undefined
  /**
   * World velocity (m/s) of a point held **fixed in the piece's frame** — a rider's own `localPos`.
   *
   * This is the platform's contribution to that rider's motion, which is exactly what an animator's
   * inertial layer means by `carry`: motion applied to a character that its own locomotion did not ask
   * for. Taken across the last two sim ticks, so translation and rotation are covered without either being
   * special-cased — a point on a turntable picks up its tangential velocity for free.
   *
   * Zero on the first update, when there is no earlier tick to difference against.
   */
  baseCarry: (index: number, localPos: Vec3) => Vec3 | undefined
}

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)
export const mul = (a: Vec3, b: Vec3): Vec3 => vec3(a.x * b.x, a.y * b.y, a.z * b.z)
export const scaleOf = (t: Transform): Vec3 => t.scale ?? vec3(1, 1, 1)

// Bake a per-axis scale into a collider's dimensions (Unity's lossy-scale → shape bake). Ball
// and capsule can't represent non-uniform scale, so they take a uniform-ish approximation.
export const scaleCollider = (c: ColliderDesc, s: Vec3): ColliderDesc => {
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

export const toShape = (c: ColliderDesc): ShapeDesc => {
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

export const instantiateLegacyLevel = (world: PhysicsWorld, level: Level): LoadedLevel => {
  const visuals: VisualItem[] = []
  const markers: WorldMarker[] = []
  const triggers: WorldTrigger[] = []
  /**
   * Every frame, in creation order — which is depth-first, so a single forward pass always evaluates a
   * parent before its children. That ordering is the whole reason nesting needs no recursion at runtime.
   */
  const frames: Frame[] = []
  /**
   * Moving pieces, in creation order. The index into this list is what a rider puts on the wire as its
   * movement base (ADR 0021): it means the same thing on every client because each one instantiates the
   * same level JSON in the same order. A Rapier collider handle would happen to match today and is not
   * a promise.
   */
  const dynamics: Dynamic[] = []
  const dynamicByCollider = new Map<number, number>()

  /**
   * Resolve a frame's pose at `nowMs`: apply its own behavior in its *local* frame, then compose onto the
   * parent's already-resolved world pose.
   *
   * Local, not world, is what makes motion compose — a child's `move` axis and a child's spin axis are
   * both read in the parent's frame, so a bar rotating about +y on a deck that has itself turned rotates
   * about the deck's +y. For a top-level instance the parent is the world and this is identical to the
   * flat behaviour it replaces.
   */
  const evaluate = (f: Frame, nowMs: number): void => {
    const pose = poseAt(f.behavior, f.base, nowMs)
    const localPos = pose.position
    const localRot = eulerToQuat(pose.rotation)
    if (f.parent === null) {
      f.worldPos = localPos
      f.worldRot = localRot
      return
    }
    f.worldPos = add(f.parent.worldPos, rotateVec3(f.parent.worldRot, mul(f.parentScale, localPos)))
    f.worldRot = mulQuat(f.parent.worldRot, localRot)
  }

  const makeFrame = (t: Transform, behavior: Behavior, parent: Frame | null): Frame => {
    const parentScale = parent?.scale ?? vec3(1, 1, 1)
    const f: Frame = {
      base: t,
      parentScale,
      scale: mul(parentScale, scaleOf(t)),
      behavior,
      parent,
      animated: isAnimated(behavior) || (parent?.animated ?? false),
      worldPos: vec3(0, 0, 0),
      worldRot: quat(),
    }
    frames.push(f)
    // Evaluated at t = 0 rather than copied from the transform, so there is no separate code path for
    // "where was this placed": a static frame's pose at 0 *is* its authored transform, and an animated
    // one's is its first key, which is where the level genuinely starts.
    evaluate(f, 0)
    return f
  }

  const pushMarker = (m: Marker, node: Frame): void => {
    const position = add(node.worldPos, rotateVec3(node.worldRot, mul(node.scale, m.transform.position)))
    markers.push(m.kind === 'spawn' ? { kind: 'spawn', position } : { kind: m.kind, position, radius: m.radius })
  }

  const buildInstance = (inst: PrefabInstance, parent: Frame | null): void => {
    const prefab = resolvePrefab(level, inst)
    // The *instance* carries the prefab's default motion, so a multi-piece prefab moves rigidly rather
    // than each piece animating on its own path. A piece's own behavior composes on top of it.
    const node = makeFrame(inst.transform, inst.behavior ?? prefab.behavior ?? { kind: 'static' }, parent)

    // The placement's view of the prefab: its own pieces with this instance's overrides applied (ADR 0033).
    for (const piece of effectivePieces(level, inst)) {
      const pf = makeFrame(piece.transform, piece.behavior ?? { kind: 'static' }, node)
      const collider = scaleCollider(piece.collider, pf.scale)
      const shape = toShape(collider)
      const visual: VisualItem = {
        collider,
        position: { ...pf.worldPos },
        rotation: { ...pf.worldRot },
        model: visualModel(piece.visual),
        // Already resolved: `effectivePieces` applied the per-piece override and then the instance-wide
        // `material`, which is the coarser statement and wins. Neither cascades to children — a child is its
        // own placement with its own overrides.
        material: visualMaterial(piece.visual),
      }
      visuals.push(visual)

      // Kinematic if anything above it moves, not just if *it* moves: a static piece parented to a
      // moving platform travels through the world and a fixed body would leave it behind.
      const body = pf.animated
        ? world.addKinematicBody({ position: pf.worldPos, rotation: pf.worldRot, shape })
        : world.addFixedBody({ position: pf.worldPos, rotation: pf.worldRot, shape })

      if (pf.animated) {
        dynamicByCollider.set(body.colliderHandle, dynamics.length)
        dynamics.push({
          frame: pf,
          body,
          visual,
          prevPos: { ...pf.worldPos },
          prevRot: { ...pf.worldRot },
          currPos: { ...pf.worldPos },
          currRot: { ...pf.worldRot },
          renderPos: { ...pf.worldPos },
          renderRot: { ...pf.worldRot },
        })
      }

      // A trigger piece exposes its collider so the mode can detect real contact with it.
      if (piece.trigger !== undefined)
        triggers.push({ ...piece.trigger, colliderHandle: body.colliderHandle, position: { ...pf.worldPos } })
    }

    for (const m of prefab.markers ?? []) pushMarker(m, node)
    // Depth-first, after this instance's own pieces: children are placed relative to the node above.
    for (const child of inst.children ?? []) buildInstance(child, node)
  }

  for (const inst of level.instances) buildInstance(inst, null)
  for (const m of level.markers ?? []) {
    markers.push(
      m.kind === 'spawn'
        ? { kind: 'spawn', position: m.transform.position }
        : { kind: m.kind, position: m.transform.position, radius: m.radius },
    )
  }

  // Poses are seeded at the authored home, but the first `update` lands wherever a piece is in its
  // cycle at that clock time — a phase-dependent jump of up to `distance` (or a whole turn). Priming
  // makes the first step report no motion, so that jump is never interpolated as travel.
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

  // The last two update times, so a velocity can be divided by the interval it was actually measured over
  // rather than by an assumed tick length.
  let prevMs = 0
  let currMs = 0

  const update = (nowMs: number, ridingColliderHandle?: number): void => {
    prevMs = primed ? currMs : nowMs
    currMs = nowMs
    // One forward pass: `frames` is depth-first, so a parent's world pose is always already resolved
    // when its children are reached. Static subtrees are skipped — they were resolved at load.
    for (const f of frames) if (f.animated) evaluate(f, nowMs)

    for (const d of dynamics) {
      const poseIt = d.body.colliderHandle === ridingColliderHandle ? poseFrozen : pose
      poseIt(d.body, d.frame.worldPos, d.frame.worldRot)
      d.prevPos = primed ? d.currPos : d.frame.worldPos
      d.prevRot = primed ? d.currRot : d.frame.worldRot
      d.currPos = d.frame.worldPos
      d.currRot = d.frame.worldRot
      // Latest, so a consumer that doesn't interpolate still gets a live pose.
      d.visual.position = d.currPos
      d.visual.rotation = d.currRot
    }
    primed = true
  }

  const render = (alpha: number): void => {
    for (const d of dynamics) {
      d.renderPos = lerpVec3(d.prevPos, d.currPos, alpha)
      d.renderRot = slerpQuat(d.prevRot, d.currRot, alpha)
      d.visual.position = d.renderPos
      d.visual.rotation = d.renderRot
    }
  }

  // The frame a rider keeps its position in: the pose the last `update` put this piece at. Taken
  // from the computed pose rather than read back off the body, because an unfrozen kinematic body
  // does not actually reach its target until `world.step` — reading the body would make the answer
  // depend on whether the caller had stepped yet, which is a trap. A kinematic body always reaches
  // its target, so the two agree from `world.step` onward.
  const basePose = (colliderHandle: number): { position: Vec3; rotation: Quat } | undefined => {
    const i = dynamicByCollider.get(colliderHandle)
    if (i === undefined) return undefined
    const d = dynamics[i]!
    return { position: d.currPos, rotation: d.currRot }
  }

  const baseIndex = (colliderHandle: number): number | undefined => dynamicByCollider.get(colliderHandle)

  const basePoseOf = (index: number, phase: BasePhase): { position: Vec3; rotation: Quat } | undefined => {
    const d = dynamics[index]
    if (d === undefined) return undefined
    if (phase === 'render') return { position: d.renderPos, rotation: d.renderRot }
    if (phase === 'tick') return { position: d.currPos, rotation: d.currRot }
    return { position: d.prevPos, rotation: d.prevRot }
  }

  const baseCarry = (index: number, localPos: Vec3): Vec3 | undefined => {
    const now = basePoseOf(index, 'tick')
    const before = basePoseOf(index, 'prev')
    if (now === undefined || before === undefined) return undefined
    const dt = (currMs - prevMs) / 1000
    if (dt <= 0) return vec3(0, 0, 0)
    // The same point, in the frame as it was and as it is. The difference is everything the piece did to
    // whoever is standing on it, whether it slid, spun, or both — including motion inherited from a parent.
    const a = add(before.position, rotateVec3(before.rotation, localPos))
    const b = add(now.position, rotateVec3(now.rotation, localPos))
    return vec3((b.x - a.x) / dt, (b.y - a.y) / dt, (b.z - a.z) / dt)
  }

  return {
    config: level.config,
    markers,
    triggers,
    visuals,
    update,
    render,
    basePose,
    baseIndex,
    basePoseOf,
    baseCarry,
  }
}
