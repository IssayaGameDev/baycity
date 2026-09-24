import { eulerToQuat, lerpVec3, mulQuat, quat, rotateVec3, slerpQuat, vec3, type Quat, type Vec3 } from '@mp/core'
import type { PhysicsBody, PhysicsWorld, ShapeDesc } from '@mp/physics'

import { MOTIONLESS, motionOffset, motionsOf, movesAtAll, travelOffset, type Motion, type MotionFrame } from './motion'
import { scaleCollider } from './primitives'
import {
  AT_REST_POSE,
  SELF,
  UNMOVED,
  channelsOf,
  combineSequences,
  compileSequence,
  sampleSequence,
  type CompiledSequence,
  type SequenceClocks,
  type SequenceOffset,
  type SequencePose,
} from './sequence'
import { SEQUENCE, sequenceOf } from './sequenceData'
import {
  COLLIDER,
  LIGHT,
  MATERIAL_OVERRIDE,
  SPAWN,
  MESH,
  RENDERER,
  boolParam,
  componentsOfType,
  effectiveNode,
  firstOfType,
  numberParam,
  stringParam,
  vec3Param,
  type TypeInfo,
} from './nodes'
import type { ColliderDesc, ComponentData, LevelConfig, Node, Level, Transform } from './types'

/**
 * Turns a **node tree** into a live world (PLAN-component-system, stage C1): Rapier colliders from every
 * `Collider`, a renderer-agnostic draw list from `Renderer`/`Mesh`, a light list from every `Light`, and the
 * clock-driven `update`/`render` that carries all of them.
 *
 * It reads seven component types, all of them the engine's own, and **no gameplay names at all**. What a
 * checkpoint or a bumper means is the mode's business: this hands out every component on the node that owns
 * a collider and lets the mode recognise what it knows. Adding a rule therefore never touches this file,
 * which is the difference between a component system and a switch statement.
 */

/**
 * A place players enter. Only `spawn` exists: the other marker kinds were dead data with no readers, and they
 * became inert nodes when the schema did (ADR 0035).
 */
export interface WorldMarker {
  kind: 'spawn'
  position: Vec3
}

/** One thing to draw. `position`/`rotation` are mutated by `update` for clock-driven nodes. */
export interface VisualItem {
  collider: ColliderDesc
  position: Vec3
  rotation: Quat
  /** Model asset id, or a built-in shape id (`builtin:…`, ADR 0090), when this node draws a mesh instead of its colliders' shapes. */
  model: string | undefined
  /** The node's world scale — what a built-in shape is sized by. Colliders already carry theirs baked in. */
  scale: Vec3
  /** Material asset id. Absent means nobody has chosen a surface, and the renderer greyboxes it. */
  material: string | undefined
  /**
   * The colliders this drawing stands for — the link from a query's answer back to the thing on screen.
   *
   * Usually one, since a greybox visual is one collider's shape. A node drawing a **model** gets a single
   * visual for the whole node, so it lists every collider the node owns: a cast that hits any of them has
   * hit that mesh.
   *
   * Exists for the camera, which needs to know *which surface* is in the way and not merely that something
   * is (ADR 0055). Written during the build and read-only afterwards.
   */
  colliderHandles: number[]
  /** Drawn at all (ADR 0137): `false` while a sequence has this node, or one above it, disabled. Mutated by `update`. */
  visible: boolean
  /** A factor of the material's opacity — a sequence's fade, 1 unless one fades it. Mutated by `update`/`render`. */
  opacity: number
  /**
   * `true` when a sequence can fade this, decided at load: the renderer gives it its **own** copy of its
   * material, transparent from the start, so fading one piece does not fade every piece sharing the material,
   * and nothing recompiles a shader mid-fade.
   */
  fades: boolean
  /**
   * The node's world scale now, over `scale` — how far the geometry built at load is stretched while a
   * sequence scales the node. `(1,1,1)` otherwise. Mutated by `update`/`render`.
   */
  drawScale: Vec3
}

/**
 * One light to realize (ADR 0047). Headless data: which kind, how it looks, and where it is — the renderer
 * turns it into a `THREE.Light`, and this package never learns what one is.
 *
 * `position`/`rotation` are mutated by `render`, like `VisualItem`, so a lamp parented to a moving platform
 * travels with it.
 */
export interface WorldLight {
  /** The node that owns it, so the editor can map a gizmo back to a selection. */
  readonly node: string
  readonly kind: 'point' | 'spot' | 'directional' | 'ambient' | 'hemisphere'
  /** sRGB `#rrggbb`. */
  readonly color: string
  /** The upward half of a `hemisphere` light; ignored by every other kind. */
  readonly groundColor: string
  readonly intensity: number
  /** Falloff distance for `point`/`spot`. 0 is unbounded. */
  readonly range: number
  readonly decay: number
  /** Spot cone half-angle, degrees. */
  readonly angleDeg: number
  readonly penumbra: number
  readonly castShadow: boolean
  position: Vec3
  /** `directional` and `spot` shine along the node's forward; the others ignore this. */
  rotation: Quat
  /** Off while a sequence has its node, or one above it, disabled (ADR 0137). Mutated by `update`. */
  visible: boolean
}

/** Which of a clock-driven node's three known poses to read — see `LoadedLevel.basePoseOf`. */
export type BasePhase = 'render' | 'tick' | 'prev'

const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)
const mul = (a: Vec3, b: Vec3): Vec3 => vec3(a.x * b.x, a.y * b.y, a.z * b.z)
const scaleOf = (t: Transform): Vec3 => t.scale ?? vec3(1, 1, 1)

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
      // Unreachable through the editor, which does not offer cylinder for exactly this reason (ADR 0038).
      throw new Error('cylinder collider not supported yet (needs a physics-wrapper shape)')
  }
}

/** A node that owns at least one collider, and everything a mode needs to act on contact with it. */
export interface WorldNode {
  readonly id: string
  readonly name: string | undefined
  /** Every resolved component on the node, overrides applied. The mode filters for the ones it knows. */
  readonly components: readonly ComponentData[]
  /** World centre at load — what a respawn point wants. */
  readonly position: Vec3
  /**
   * World rotation at load (ADR 0095). Pairs with `position`, and is how a node says which way it *faces* —
   * `rotateVec3(node.rotation, {x:0, y:0, z:1})` is its forward, the convention every transform gizmo draws.
   *
   * At load, like `position`: the nodes that are asked this are volumes and markers, which do not move. A
   * node a `Track` or a component drives reports where it started.
   */
  readonly rotation: Quat
  /**
   * This node's colliders as **world-scaled shapes**, in the same order as `colliderHandles` (ADR 0095).
   *
   * The handles are opaque to everything above the physics world, so this is the only way a rule can ask how
   * big a thing is — which a volume test needs and a contact does not. World-scaled, so a box already has
   * ADR 0090's unit-collider-times-node-scale applied and a reader never repeats that arithmetic.
   */
  readonly colliders: readonly ColliderDesc[]
  /**
   * The colliders this node owns, in order. The inverse of `nodeOf`.
   *
   * Opaque numbers: Rapier packs a generation into a handle, so they are **not** small sequential integers
   * (the second fixed body in a world reads as `5e-324`). Only ever compare them or use them as keys — which
   * is also why the wire uses `baseIndex` and not a handle (ADR 0021).
   */
  readonly colliderHandles: readonly number[]
  /**
   * Which **reference scope** this node belongs to: `0` for the level itself, and one per placement for the
   * nodes a placement inherited from its prefab (stage C4).
   *
   * A `nodeRef` authored inside a prefab names a node in that prefab, and two placements of it must resolve
   * the same authored id to *their own* copy. That is what a scope is for; `findNode` is where it is used.
   */
  readonly scope: number
}

/** A sequence moving a frame, and which of its targets that frame is (ADR 0137). */
interface FrameSequence {
  readonly compiled: CompiledSequence
  /** `SELF` for a sequence on this node; this node's id for its parent's, which aim steps at it. */
  readonly key: string
}

interface Frame {
  base: Transform
  /** The parent's world scale — live, since a sequence above may be scaling this whole branch. */
  parentScale: Vec3
  /** World scale, live. */
  scale: Vec3
  /** The world scale its shapes and geometry were built at. */
  loadScale: Vec3
  /** Every `Mover`/`Spinner` on this node (ADR 0103). Empty on a node with none, which is the common case. */
  motions: readonly Motion[]
  /** Every sequence moving this node: its own, and its parent's that aim at it. Empty is the common case. */
  sequences: readonly FrameSequence[]
  /** What they added at the last evaluation (`UNMOVED` when there are none). */
  seq: SequenceOffset
  /** Not disabled by a sequence — this node's, or one above it: switching a node off takes its branch. */
  shown: boolean
  /** Its colliders on: `false` while one of its sequences has switched them off. Does not cascade. */
  solid: boolean
  /** Its world scale can change: a sequence scales it, or something above it. Its colliders are re-shaped. */
  scaling: boolean
  /** A sequence can fade it. Its visuals get their own material copies. Does not cascade: a fade is a material's. */
  fading: boolean
  /**
   * Moved by a sequence on this browser's own clock, or under something that is (ADR 0137). Another screen has
   * it somewhere else, so it is never a base on the wire: a rider on it is sent in world coordinates.
   */
  localOnly: boolean
  parent: Frame | null
  animated: boolean
  worldPos: Vec3
  worldRot: Quat
  /** What a component has moved this node by, or `null` on a node no component can move. See `NodeDrive`. */
  drive: NodeDrive | null
}

/**
 * Something whose world pose changes over time: a body to pose, a visual to move, or both.
 *
 * Both optional, unlike the piece-shaped version this replaces, because a node no longer pairs one collider
 * with one mesh. A node drawing a model still needs its visual carried while its colliders are posed, and a
 * node with two colliders needs two bodies against one frame. A single-collider node — every piece that
 * exists today — still produces exactly one of these, with both fields set, so the index a rider puts on
 * the wire (ADR 0021) is unchanged by the migration.
 */
interface Dynamic {
  frame: Frame
  body: PhysicsBody | undefined
  visual: VisualItem | undefined
  /** A light riding this frame. Its own entry, since a node's light is independent of its collider count. */
  light: WorldLight | undefined
  /**
   * The collider's own offset from the frame, **before** scale — `undefined` when it sits on the origin, which
   * is every migrated piece. Scaled and re-applied each tick, since the frame's pose and scale are what move.
   */
  centre: Vec3 | undefined
  /** The collider's authored shape, before scale, for re-shaping it while its frame is `scaling`. */
  shape: ColliderDesc | undefined
  /** The world scale the body's shape was last built for. */
  shapeScale: Vec3
  prevScale: Vec3
  currScale: Vec3
  prevOpacity: number
  currOpacity: number
  prevPos: Vec3
  prevRot: Quat
  currPos: Vec3
  currRot: Quat
  renderPos: Vec3
  renderRot: Quat
}

/**
 * How much a component has moved its own node, in the node's **local** space (ADR 0058).
 *
 * An **offset from the authored transform**, not a replacement for it — the same choice ADR 0050 made for
 * keyframes, and for the same reasons: zero means "as authored", a driven node can be duplicated or
 * reparented without rewriting anything, and a component can nudge a node that a `Track` is already moving
 * because the two offsets simply add.
 *
 * Local space, so it composes with the parent chain. A component writing world space would fight every
 * ancestor's rotation and scale.
 *
 * **Mutated in place.** A component writes into this object and the frame tree reads it on the next
 * `update`, so there is no allocation per tick and no setter to forget to call.
 *
 * `rotation` is Euler **radians**, matching `Transform.rotation` — which the editor shows in degrees and
 * stores in radians, so a component writing `Math.PI / 2` turns a quarter turn.
 */
export interface NodeDrive {
  position: Vec3
  rotation: Vec3
}

export interface LoadedLevel {
  config: LevelConfig
  markers: WorldMarker[]
  /**
   * Every node that owns an enabled collider, in creation order (depth-first, parents before children) —
   * the **touchable** ones. What a mode indexes: a checkpoint nothing can touch is not a checkpoint in a
   * progression, and putting one in this list would shift every saved index after it.
   */
  nodes: WorldNode[]
  /**
   * Every node, touchable or not, in the same order. What a component runner needs: a component with an
   * `onFixedUpdate` and no collider still has to run.
   */
  allNodes: WorldNode[]
  /** The node owning a collider handle — how contact becomes a gameplay rule. */
  nodeOf: (colliderHandle: number) => WorldNode | undefined
  visuals: VisualItem[]
  /** Every `Light` component in the tree, in creation order (ADR 0047). Visual only, nothing on the wire. */
  lights: WorldLight[]
  /**
   * The node a `nodeRef` on `from` points at, or `undefined`.
   *
   * Resolved in `from`'s own scope first, then in the level. Both steps are needed: a reference authored
   * inside a prefab means "my copy of that node", and one authored as an override on a placement is written
   * in the level and may name a level node.
   */
  findNode: (from: WorldNode, id: string) => WorldNode | undefined
  /**
   * The live offset a component may write to move this node, or `undefined` when nothing can move it.
   *
   * Present only for a node carrying a component whose definition declares `moves` (`TypeInfo`). That
   * declaration is load-bearing and cannot be decided later: a node nothing moves gets a **fixed** body and
   * sits outside the per-tick pose pass, and neither can be changed after instantiation. So a component that
   * moves things has to say so, exactly as one that may appear only once says `singleton`.
   */
  driveOf: (node: WorldNode) => NodeDrive | undefined
  update: (nowMs: number, ridingColliderHandle?: number) => void
  /**
   * How many equal slices this tick has to be posed in so nothing moves more than `maxStep` metres
   * between two of them (ADR 0104). `1` when the level is still or slow, which is every level without a
   * fast mover, so the common path is unchanged.
   *
   * Free to ask, because motion is a pure function of time (ADR 0103): the pose at any instant is
   * computable without stepping anything, so the largest move this tick is two evaluations and a
   * subtraction, over animated frames only.
   *
   * It exists because a kinematic body is **teleported** into place, and a teleport is not swept: a deck
   * that jumps more than the distance from the rider's centre to its soles lands above them, and the
   * character controller will not sweep a capsule out of a collider it is already inside. Measured, at
   * 30 Hz: the carry is exact to 0.02 m up to 1.18 m of deck travel in a step and fails completely at
   * 1.27 m. Slicing the tick is the only thing that fixes it — sweeping the platform instead of
   * teleporting it does not, and slicing only the character makes it worse, because by then the overlap
   * already exists.
   */
  motionSlices: (fromMs: number, toMs: number, maxStep: number) => number
  render: (alpha: number) => void
  basePose: (colliderHandle: number) => { position: Vec3; rotation: Quat } | undefined
  baseIndex: (colliderHandle: number) => number | undefined
  basePoseOf: (index: number, phase: BasePhase) => { position: Vec3; rotation: Quat } | undefined
  baseCarry: (index: number, localPos: Vec3) => Vec3 | undefined
}

const UNIT_BOX: ColliderDesc = { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
/** Level time 0, on both clocks: where the build poses everything. */
const AT_START: SequenceClocks = { shared: 0, local: 0 }
/** `a / b`, with a degenerate `b` giving 1 — a node scaled to nothing at load stretches by nothing. */
const ratio = (a: number, b: number): number => (Math.abs(b) < 1e-9 ? 1 : a / b)
const sameVec = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z

const shapeOf = (c: ComponentData): ColliderDesc => {
  const shape = c.params.shape
  // Validated by `readParams` when a registry was supplied. The fallback keeps a hand-edited file loadable
  // rather than throwing from inside the physics wrapper, which is where an unvalidated shape used to land.
  return shape !== null && typeof shape === 'object' && 'kind' in shape ? (shape as ColliderDesc) : UNIT_BOX
}

export const instantiateLevel = (world: PhysicsWorld, level: Level, types: TypeInfo): LoadedLevel => {
  const visuals: VisualItem[] = []
  const markers: WorldMarker[] = []
  const lights: WorldLight[] = []
  const nodes: WorldNode[] = []
  const allNodes: WorldNode[] = []
  const nodeByCollider = new Map<number, WorldNode>()
  /** scope -> node id -> node. Scope 0 is the level; each placement gets one for what it inherited. */
  const byScope = new Map<number, Map<string, WorldNode>>()
  let nextScope = 0
  const frames: Frame[] = []
  /** Node → its frame, for `driveOf`. Only driven nodes are ever looked up, but the map is cheap and total. */
  const frameByNode = new Map<WorldNode, Frame>()
  const dynamics: Dynamic[] = []
  const dynamicByCollider = new Map<number, number>()

  /** Where a frame sits in the tree, for re-framing its movers' travel (ADR 0106, `motion.ts`). */
  const frameOf = (f: Frame): MotionFrame => ({
    parentRot: f.parent === null ? quat() : f.parent.worldRot,
    parentScale: f.parentScale,
    ownRotation: f.base.rotation ?? ZERO,
  })

  /**
   * Each compiled sequence sampled once per instant, however many frames it moves — a door's sequence aims at
   * both halves, and each half would otherwise sample the whole of it.
   */
  const sampled = new Map<CompiledSequence, ReadonlyMap<string, SequencePose>>()
  let sampledAt: SequenceClocks | null = null
  const poseOf = (s: FrameSequence, clocks: SequenceClocks): SequencePose => {
    if (sampledAt === null || sampledAt.shared !== clocks.shared || sampledAt.local !== clocks.local) {
      sampled.clear()
      sampledAt = clocks
    }
    let poses = sampled.get(s.compiled)
    if (poses === undefined) {
      poses = sampleSequence(s.compiled, clocks)
      sampled.set(s.compiled, poses)
    }
    return poses.get(s.key) ?? AT_REST_POSE
  }

  const evaluate = (f: Frame, clocks: SequenceClocks): void => {
    const nowMs = clocks.shared
    // Every contribution is an offset from the same authored transform, so they add and none has to know
    // about the others: what the node's movers and spinner compute (ADR 0103), what a component drove
    // (ADR 0058), and what its sequences say (ADR 0137). That is what lets a component nudge a moving
    // platform rather than choose between them.
    const motion = f.motions.length === 0 ? MOTIONLESS : motionOffset(f.motions, nowMs)
    const drive = f.drive ?? MOTIONLESS
    // Live, and first: `frameOf` below reads it, and a sequence above may be scaling this whole branch.
    if (f.parent !== null) f.parentScale = f.parent.scale
    const seq = f.sequences.length === 0 ? UNMOVED : combineSequences(f.sequences.map((s) => ({ pose: poseOf(s, clocks), axes: s.compiled.sequence.axes })), frameOf(f))
    f.seq = seq
    // Movers are re-framed against this node's place in the tree, which `motionOffset` cannot know: it is
    // headless and has no parent chain. `motion.position` is the raw authored sum and is not used for
    // position at all; `travelOffset` is the framed one. A node with no motions pays nothing.
    const travel = f.motions.length === 0 ? motion.position : travelOffset(f.motions, nowMs, frameOf(f))
    const localPos = add(add(add(f.base.position, travel), drive.position), seq.position)
    const authored = eulerToQuat(add(add(f.base.rotation ?? ZERO, motion.rotation), drive.rotation))
    // A sequence's turn goes on the right of the authored rotation: inside the node's own frame (ADR 0137).
    const localRot = f.sequences.length === 0 ? authored : mulQuat(authored, seq.rotation)
    f.scale = mul(f.parentScale, f.sequences.length === 0 ? scaleOf(f.base) : mul(scaleOf(f.base), seq.scale))
    f.shown = seq.enabled !== false && (f.parent?.shown ?? true)
    f.solid = seq.collider !== false
    if (f.parent === null) {
      f.worldPos = localPos
      f.worldRot = localRot
      return
    }
    f.worldPos = add(f.parent.worldPos, rotateVec3(f.parent.worldRot, mul(f.parentScale, localPos)))
    f.worldRot = mulQuat(f.parent.worldRot, localRot)
  }

  const makeFrame = (t: Transform, motions: readonly Motion[], parent: Frame | null, driven = false, sequences: readonly FrameSequence[] = []): Frame => {
    const parentScale = parent?.scale ?? vec3(1, 1, 1)
    const drives = (pick: (c: ReturnType<typeof channelsOf>) => boolean): boolean => sequences.some((s) => pick(channelsOf(s.compiled, s.key)))
    const moves = (c: ReturnType<typeof channelsOf>): boolean => c.position || c.rotation || c.scale
    const f: Frame = {
      base: t,
      parentScale,
      scale: mul(parentScale, scaleOf(t)),
      loadScale: vec3(1, 1, 1),
      motions,
      sequences,
      seq: UNMOVED,
      shown: true,
      solid: true,
      scaling: drives((c) => c.scale) || (parent?.scaling ?? false),
      fading: drives((c) => c.opacity),
      localOnly: sequences.some((s) => s.compiled.sequence.clock === 'local' && moves(channelsOf(s.compiled, s.key))) || (parent?.localOnly ?? false),
      parent,
      // A driven node is animated for the same reason a moving one is: it needs a kinematic body and a place
      // in the per-tick pose pass. So is one with a sequence, whatever it drives: switching a collider or a
      // fade happens per tick too. Inherited by children, so moving a parent carries its subtree.
      animated: driven || movesAtAll(motions) || sequences.length > 0 || (parent?.animated ?? false),
      worldPos: vec3(0, 0, 0),
      worldRot: quat(),
      drive: driven ? { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0) } : null,
    }
    frames.push(f)
    // Posed at level time 0, where every sequence starts: a platform that begins hidden is built hidden.
    evaluate(f, AT_START)
    f.loadScale = { ...f.scale }
    return f
  }

  /** Where a collider actually sits: the frame's pose, plus its own offset rotated and scaled into it. */
  const placeAt = (f: Frame, offset: Vec3 | undefined): Vec3 =>
    offset === undefined ? f.worldPos : add(f.worldPos, rotateVec3(f.worldRot, offset))

  /** A collider's centre as the frame is scaled now. */
  const scaledCentre = (f: Frame, centre: Vec3 | undefined): Vec3 | undefined => (centre === undefined ? undefined : mul(f.scale, centre))
  /** The frame's world scale over the one its geometry was built at. */
  const drawScaleOf = (f: Frame): Vec3 => vec3(ratio(f.scale.x, f.loadScale.x), ratio(f.scale.y, f.loadScale.y), ratio(f.scale.z, f.loadScale.z))

  const addDynamic = (
    frame: Frame,
    body: PhysicsBody | undefined,
    visual: VisualItem | undefined,
    centre: Vec3 | undefined,
    light: WorldLight | undefined = undefined,
    shape: ColliderDesc | undefined = undefined,
  ): void => {
    if (body !== undefined) dynamicByCollider.set(body.colliderHandle, dynamics.length)
    const at = placeAt(frame, scaledCentre(frame, centre))
    dynamics.push({
      frame,
      body,
      visual,
      light,
      centre,
      shape,
      shapeScale: { ...frame.scale },
      prevScale: vec3(1, 1, 1),
      currScale: vec3(1, 1, 1),
      prevOpacity: frame.seq.opacity,
      currOpacity: frame.seq.opacity,
      prevPos: { ...at },
      prevRot: { ...frame.worldRot },
      currPos: { ...at },
      currRot: { ...frame.worldRot },
      renderPos: { ...at },
      renderRot: { ...frame.worldRot },
    })
  }

  /**
   * One node: its frame, its colliders, its visual, then its children.
   *
   * `inheritedMaterial` carries a `MaterialOverride` down the subtree — `undefined` means nothing above has
   * an opinion, and `''` is an opinion ("unsurfaced"), which is why it is not folded into one falsy check.
   * It cascades to children, where `PrefabInstance.material` stopped at the instance's own pieces; there is
   * no longer a distinction between a node's pieces and its children to stop at.
   */
  const build = (node: Node, parent: Frame | null, inheritedMaterial: string | undefined, scope: number, fromParent: readonly CompiledSequence[]): void => {
    const r = effectiveNode(level, node, types)
    // Disabled: build nothing, and do not descend (ADR 0099). Returning before `makeFrame` is what makes the
    // whole subtree absent rather than present-but-hidden — no body, no visual, no light, no component, and
    // no `baseIndex`, which is only safe because every client loads the same file and so skips the same nodes.
    if (r.enabled === false) return
    // Does any enabled component on this node say it moves it (ADR 0058)? Asked here because the answer
    // decides the frame's `animated` flag and whether its bodies are kinematic, and neither can change later.
    const driven = r.components.some((c) => c.enabled !== false && types.get(c.type)?.moves === true)
    // Compiled once, here (ADR 0137): every start and duration is fixed by the file, so a tick only samples.
    // A node is moved by its own sequences' steps aimed at itself, and by its parent's aimed at it by id —
    // targets are children only, so nothing further up can reach it.
    const ownSequences = componentsOfType(r.components, SEQUENCE).map((c) => compileSequence(sequenceOf(c)))
    const sequences: FrameSequence[] = [
      ...ownSequences.filter((c) => c.tracks.has(SELF)).map((compiled) => ({ compiled, key: SELF })),
      ...fromParent.filter((c) => c.tracks.has(r.id)).map((compiled) => ({ compiled, key: r.id })),
    ]
    const f = makeFrame(r.transform, motionsOf(r.components), parent, driven, sequences)
    // A placement opens a scope: everything it inherits from its prefab resolves references among itself.
    // The placement node is the prefab's root, so it belongs to that scope too.
    const inner = r.inheritedCount > 0 ? ++nextScope : scope

    const own = firstOfType(r.components, MATERIAL_OVERRIDE)
    const material = own === undefined ? inheritedMaterial : stringParam(own, 'material', '')

    if (firstOfType(r.components, SPAWN) !== undefined) markers.push({ kind: 'spawn', position: { ...f.worldPos } })

    const lightOn = firstOfType(r.components, LIGHT)
    if (lightOn !== undefined) {
      const kind = stringParam(lightOn, 'kind', 'point')
      const light: WorldLight = {
        node: r.id,
        kind: kind === 'spot' || kind === 'directional' || kind === 'ambient' || kind === 'hemisphere' ? kind : 'point',
        color: stringParam(lightOn, 'color', '#ffffff'),
        groundColor: stringParam(lightOn, 'groundColor', '#808080'),
        intensity: numberParam(lightOn, 'intensity', 4),
        range: numberParam(lightOn, 'range', 12),
        decay: numberParam(lightOn, 'decay', 2),
        angleDeg: numberParam(lightOn, 'angle', 40),
        penumbra: numberParam(lightOn, 'penumbra', 0.3),
        castShadow: boolParam(lightOn, 'castShadow', false),
        position: { ...f.worldPos },
        rotation: { ...f.worldRot },
        visible: f.shown,
      }
      lights.push(light)
      // Its own dynamic, so a light rides a moving frame whether or not the node has a collider.
      if (f.animated) addDynamic(f, undefined, undefined, undefined, light)
    }

    const handles: number[] = []
    // Filled by the collider loop below, which runs after this node object is made — as `handles` is.
    const worldColliders: ColliderDesc[] = []
    const worldNode: WorldNode = {
      id: r.id,
      name: r.name,
      components: r.components,
      position: { ...f.worldPos },
      rotation: { ...f.worldRot },
      colliderHandles: handles,
      colliders: worldColliders,
      scope: inner,
    }
    frameByNode.set(worldNode, f)
    allNodes.push(worldNode)
    /**
     * Registered under the id whoever might name it would use, which for a placement is **two** ids: its own,
     * to the level that placed it, and the prefab root's, to a reference authored inside that prefab.
     *
     * First writer wins, so two placements of one prefab do not overwrite each other where their scopes meet.
     */
    const register = (where: number, id: string): void => {
      const scoped = byScope.get(where) ?? new Map<string, WorldNode>()
      if (!scoped.has(id)) scoped.set(id, worldNode)
      byScope.set(where, scoped)
    }
    register(scope, r.id)
    if (inner !== scope) {
      register(inner, r.id)
      const rootId = node.prefab === undefined ? undefined : level.prefabs?.[node.prefab]?.id
      if (rootId !== undefined) register(inner, rootId)
    }

    const colliders = componentsOfType(r.components, COLLIDER)
    /**
     * `Renderer` says *that* this node draws; `Mesh` says *what* (ADR 0039). Unity's split, and its rule:
     *
     * - a `Renderer` with no `Mesh` draws the node's colliders — the greybox case, and most content
     * - a `Renderer` with a `Mesh` draws the mesh
     * - a `Mesh` with no `Renderer` draws nothing, exactly as a `MeshFilter` without a `MeshRenderer`
     *
     * A `Mesh` whose `model` is empty falls back to the colliders, which is the same fallback the old
     * `source: 'model'` with no asset had.
     */
    const renderer = firstOfType(r.components, RENDERER)
    const mesh = firstOfType(r.components, MESH)
    const model = mesh === undefined ? '' : stringParam(mesh, 'model', '')
    const drawsModel = renderer !== undefined && model !== ''
    const surfaced = material ?? (renderer === undefined ? '' : stringParam(renderer, 'material', ''))

    const item = (collider: ColliderDesc, at: Vec3): VisualItem => {
      const v: VisualItem = {
        collider,
        position: { ...at },
        rotation: { ...f.worldRot },
        scale: { ...f.scale },
        model: drawsModel ? model : undefined,
        material: surfaced === '' ? undefined : surfaced,
        colliderHandles: [],
        visible: f.shown,
        opacity: f.seq.opacity,
        fades: f.fading,
        drawScale: vec3(1, 1, 1),
      }
      visuals.push(v)
      return v
    }

    if (colliders.length > 0) {
      nodes.push(worldNode)
      // A model draws once for the whole node, so every collider on it points back at this one visual.
      let modelItem: VisualItem | undefined
      colliders.forEach((c, n) => {
        const collider = scaleCollider(shapeOf(c), f.scale)
        worldColliders.push(collider)
        const shape = toShape(collider)
        const authoredCentre = vec3Param(c, 'center', ZERO)
        const centre = authoredCentre.x === 0 && authoredCentre.y === 0 && authoredCentre.z === 0 ? undefined : authoredCentre
        // Scaled like any local offset, so a scaled node moves its colliders apart by the same factor.
        const at = placeAt(f, scaledCentre(f, centre))
        // A trigger is a sensor: overlap is detected, nothing is resolved (ADR 0054). Still a body and still
        // in `colliderHandles`, so a rule on this node fires the same way — it is only the physical response
        // that goes away.
        const trigger = boolParam(c, 'trigger', false)
        // Kinematic if anything above it moves, not just if *it* moves: a static node parented to a moving
        // platform travels through the world and a fixed body would leave it behind.
        const desc = { position: at, rotation: f.worldRot, shape, ...(trigger ? { sensor: true } : {}) }
        const body = f.animated ? world.addKinematicBody(desc) : world.addFixedBody(desc)
        // Built the way level time 0 has it: a platform whose sequence starts with it switched off starts off.
        if (!(f.shown && f.solid)) body.setEnabled(false)
        nodeByCollider.set(body.colliderHandle, worldNode)
        handles.push(body.colliderHandle)
        // A model draws once for the whole node and rides the first body, so a single-collider node still
        // produces exactly one dynamic with both fields — the shape every existing piece has.
        let paired: VisualItem | undefined
        if (renderer !== undefined) {
          if (drawsModel) {
            if (n === 0) modelItem = item(collider, at)
            modelItem?.colliderHandles.push(body.colliderHandle)
            paired = n === 0 ? modelItem : undefined
          } else {
            paired = item(collider, at)
            paired.colliderHandles.push(body.colliderHandle)
          }
        }
        if (f.animated) addDynamic(f, body, paired, centre, undefined, shapeOf(c))
      })
    } else if (drawsModel) {
      /**
       * Drawn but not solid — impossible for a `Piece`, whose collider was mandatory.
       *
       * Only a mesh reaches here. A `Renderer` with no `Mesh` and no collider has **nothing to draw**, and
       * inventing a unit box for it would put a shape in the world that no data asked for. That case is
       * reachable two ways, and both should be invisible: a Renderer added before a Collider, and a Collider
       * switched off.
       */
      const only = item(UNIT_BOX, f.worldPos)
      if (f.animated) addDynamic(f, undefined, only, undefined)
    }

    r.children.forEach((child, n) => build(child, f, material, n < r.inheritedCount ? inner : scope, ownSequences))
  }

  for (const node of level.nodes) build(node, null, undefined, 0, [])

  let primed = false

  const pose = (body: PhysicsBody, position: Vec3, rotation: Quat): void => {
    body.setNextKinematicTranslation(position)
    body.setNextKinematicRotation(rotation)
  }

  /** Pose with zero derived velocity — only for the body a character is riding. See `update`. */
  const poseFrozen = (body: PhysicsBody, position: Vec3, rotation: Quat): void => {
    body.setPosition(position)
    body.setRotation(rotation)
    pose(body, position, rotation)
  }

  let prevMs = 0
  let currMs = 0
  /**
   * The level time this browser's own clock counts from (ADR 0137): the first instant it was posed at. So a
   * `local` sequence starts when this screen loaded the level, and keeps step with the tick — slicing a tick
   * (ADR 0104) moves both clocks by the same amount.
   */
  let localStart: number | null = null
  const clocksAt = (nowMs: number): SequenceClocks => ({ shared: nowMs, local: nowMs - (localStart ?? nowMs) })

  const distance = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)

  /** The furthest any animated frame's local pose travels between two instants. */
  const widestStep = (fromMs: number, toMs: number): number => {
    let widest = 0
    const from = clocksAt(fromMs)
    const to = clocksAt(toMs)
    for (const f of frames) {
      if (!f.animated || (f.motions.length === 0 && f.sequences.length === 0)) continue
      // Position only: a spin's reach depends on how far the collider extends from the axis, and a node
      // large enough for that to matter is not a thing a rider stands on the top face of. What its movers and
      // its sequences move it by adds, so their distances do.
      let step = 0
      if (f.motions.length > 0) step += distance(motionOffset(f.motions, fromMs).position, motionOffset(f.motions, toMs).position)
      for (const s of f.sequences) {
        const a = sampleSequence(s.compiled, from).get(s.key)
        const b = sampleSequence(s.compiled, to).get(s.key)
        if (a !== undefined && b !== undefined) step += distance(a.position, b.position)
      }
      widest = Math.max(widest, step)
    }
    return widest
  }

  const update = (nowMs: number, ridingColliderHandle?: number): void => {
    prevMs = primed ? currMs : nowMs
    currMs = nowMs
    if (localStart === null) localStart = nowMs
    const clocks = clocksAt(nowMs)
    for (const f of frames) if (f.animated) evaluate(f, clocks)

    for (const d of dynamics) {
      const f = d.frame
      const at = placeAt(f, scaledCentre(f, d.centre))
      if (d.body !== undefined) {
        const poseIt = d.body.colliderHandle === ridingColliderHandle ? poseFrozen : pose
        poseIt(d.body, at, f.worldRot)
        // Re-shaped only when the scale actually changed: a sequence that scales pauses, and most never do.
        if (f.scaling && d.shape !== undefined && !sameVec(f.scale, d.shapeScale)) {
          d.body.setShape(toShape(scaleCollider(d.shape, f.scale)))
          d.shapeScale = { ...f.scale }
        }
        d.body.setEnabled(f.shown && f.solid)
      }
      d.prevPos = primed ? d.currPos : at
      d.prevRot = primed ? d.currRot : f.worldRot
      d.currPos = at
      d.currRot = f.worldRot
      const drawn = drawScaleOf(f)
      d.prevScale = primed ? d.currScale : drawn
      d.currScale = drawn
      d.prevOpacity = primed ? d.currOpacity : f.seq.opacity
      d.currOpacity = f.seq.opacity
      if (d.visual !== undefined) {
        d.visual.position = d.currPos
        d.visual.rotation = d.currRot
        d.visual.drawScale = d.currScale
        d.visual.opacity = d.currOpacity
        d.visual.visible = f.shown
      }
      if (d.light !== undefined) d.light.visible = f.shown
    }
    primed = true
  }

  const render = (alpha: number): void => {
    for (const d of dynamics) {
      d.renderPos = lerpVec3(d.prevPos, d.currPos, alpha)
      d.renderRot = slerpQuat(d.prevRot, d.currRot, alpha)
      if (d.visual !== undefined) {
        d.visual.position = d.renderPos
        d.visual.rotation = d.renderRot
        d.visual.drawScale = lerpVec3(d.prevScale, d.currScale, alpha)
        d.visual.opacity = d.prevOpacity + (d.currOpacity - d.prevOpacity) * alpha
      }
      if (d.light !== undefined) {
        d.light.position = d.renderPos
        d.light.rotation = d.renderRot
      }
    }
  }

  const driveOf = (node: WorldNode): NodeDrive | undefined => frameByNode.get(node)?.drive ?? undefined

  const basePose = (colliderHandle: number): { position: Vec3; rotation: Quat } | undefined => {
    const i = dynamicByCollider.get(colliderHandle)
    if (i === undefined) return undefined
    const d = dynamics[i]!
    return { position: d.currPos, rotation: d.currRot }
  }

  /**
   * The index a rider puts on the wire (ADR 0021) — never for a piece a `local` sequence moves (ADR 0137):
   * another screen has it somewhere else, so a position relative to it would place the rider wrongly there.
   * Such a rider is sent in world coordinates. The carry here is untouched; it reads `basePose`.
   */
  const baseIndex = (colliderHandle: number): number | undefined => {
    const i = dynamicByCollider.get(colliderHandle)
    return i === undefined || dynamics[i]!.frame.localOnly ? undefined : i
  }

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
    const a = add(before.position, rotateVec3(before.rotation, localPos))
    const b = add(now.position, rotateVec3(now.rotation, localPos))
    return vec3((b.x - a.x) / dt, (b.y - a.y) / dt, (b.z - a.z) / dt)
  }

  return {
    config: level.config,
    markers,
    nodes,
    allNodes,
    nodeOf: (colliderHandle) => nodeByCollider.get(colliderHandle),
    findNode: (from, id) => byScope.get(from.scope)?.get(id) ?? byScope.get(0)?.get(id),
    visuals,
    lights,
    driveOf,
    update,
    motionSlices: (fromMs, toMs, maxStep) => {
      if (!(maxStep > 0)) return 1
      const widest = widestStep(fromMs, toMs)
      // Capped so a pathological authored speed cannot turn one tick into hundreds of physics steps: past
      // this the platform is not rideable at this tick rate whatever we do, and a stutter is worse than a
      // limit. 8 slices covers a deck doing roughly 280 m/s, which is the top of the character's own range.
      return Math.min(8, Math.max(1, Math.ceil(widest / maxStep)))
    },
    render,
    basePose,
    baseIndex,
    basePoseOf,
    baseCarry,
  }
}
