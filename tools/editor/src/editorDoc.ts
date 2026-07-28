import {
  checkpointPad,
  gapJump,
  goalPad,
  hazardPad,
  ledge,
  movingPlatform,
  platform,
  ramp,
  rotatingBar,
  spawnPad,
  spiralStaircase,
  staircase,
  type Behavior,
  type ColliderDesc,
  type Level,
  type Piece,
  type Prefab,
  type Transform,
} from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

/**
 * Editor document abstraction. A **level** is placed prefab instances; a **prefab** is a flat
 * list of pieces (collider + visual + trigger + optional behavior). Both are edited with the
 * same machinery (select / gizmo / place / duplicate / delete / inspector), so this hides the
 * difference behind one interface over "items" (instances or pieces). Flat, non-recursive:
 * placing a user prefab into a level inlines a copy (author-time flatten), never a runtime ref.
 */
export type Mode = 'level' | 'prefab'
export type BehaviorKind = 'static' | 'move' | 'rotate'
export type TriggerChoice = 'none' | 'checkpoint' | 'goal' | 'hazard'

/** One mesh to draw under an item's group (transform is local to that group). */
export interface MeshSpec {
  collider: ColliderDesc
  transform: Transform
  style: string | undefined
}

/** Per-item editable properties beyond the transform. `editable` = piece-level (prefab mode). */
export interface ItemProps {
  behavior: BehaviorKind
  distance: number
  periodMs: number
  axis: Vec3
  editable: boolean
  style: string
  trigger: TriggerChoice
}

export interface Doc {
  readonly mode: Mode
  count: () => number
  transformOf: (i: number) => Transform
  meshSpecs: (i: number) => MeshSpec[]
  palette: () => string[]
  place: (name: string, position: Vec3) => number
  remove: (i: number) => void
  duplicate: (i: number) => number
  label: (i: number) => string
  props: (i: number) => ItemProps
  setProps: (i: number, p: ItemProps) => void
  /** A Level to instantiate for marker/trigger gizmos + physics (prefab → wrapped at origin). */
  asLevel: () => Level
  toJSON: () => Level | Prefab
}

const KIT: Record<string, () => Prefab> = {
  platform: () => platform(),
  ledge: () => ledge(),
  ramp: () => ramp(),
  'gap jump': () => gapJump(),
  'moving platform': () => movingPlatform(),
  'rotating bar': () => rotatingBar(),
  staircase: () => staircase(),
  'spiral staircase': () => spiralStaircase(),
  'spawn pad': () => spawnPad(),
  'checkpoint pad': () => checkpointPad(),
  'goal pad': () => goalPad(),
  'hazard pad': () => hazardPad(),
}

// Primitive pieces for prefab mode. Only shapes the physics loader supports (no cylinder).
const PRIMITIVES: Record<string, () => Piece> = {
  box: () => ({ collider: { kind: 'box', halfExtents: vec3(1, 0.5, 1) }, transform: { position: vec3(0, 0, 0) } }),
  platform: () => ({ collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, transform: { position: vec3(0, 0, 0) } }),
  wall: () => ({ collider: { kind: 'box', halfExtents: vec3(1.5, 1, 0.15) }, transform: { position: vec3(0, 0, 0) } }),
  ball: () => ({ collider: { kind: 'ball', radius: 0.5 }, transform: { position: vec3(0, 0, 0) } }),
  capsule: () => ({ collider: { kind: 'capsule', halfHeight: 0.5, radius: 0.4 }, transform: { position: vec3(0, 0, 0) } }),
}

const kindOf = (b: Behavior | undefined): BehaviorKind => (b?.kind === 'move' ? 'move' : b?.kind === 'rotate' ? 'rotate' : 'static')
const readBehavior = (b: Behavior | undefined): Pick<ItemProps, 'behavior' | 'distance' | 'periodMs' | 'axis'> => ({
  behavior: kindOf(b),
  distance: b?.kind === 'move' ? b.distance : 3,
  periodMs: b?.kind === 'move' || b?.kind === 'rotate' ? b.periodMs : 4000,
  axis: b?.kind === 'move' || b?.kind === 'rotate' ? { ...b.axis } : vec3(0, 1, 0),
})
const makeBehavior = (p: ItemProps): Behavior | undefined => {
  if (p.behavior === 'move') return { kind: 'move', axis: p.axis, distance: p.distance, periodMs: p.periodMs }
  if (p.behavior === 'rotate') return { kind: 'rotate', axis: p.axis, periodMs: p.periodMs }
  return undefined
}

export const levelDoc = (level: Level, userPrefabs: Record<string, Prefab>): Doc => {
  const insts = level.instances
  const resolve = (ref: string | Prefab): Prefab => (typeof ref === 'string' ? (level.prefabs?.[ref] ?? { id: ref, pieces: [] }) : ref)
  return {
    mode: 'level',
    count: () => insts.length,
    transformOf: (i) => insts[i]!.transform,
    meshSpecs: (i) => resolve(insts[i]!.prefab).pieces.map((pc) => ({ collider: pc.collider, transform: pc.transform, style: pc.visual?.style })),
    palette: () => [...Object.keys(KIT), ...Object.keys(userPrefabs)],
    place: (name, position) => {
      const make = KIT[name]
      const prefab = make !== undefined ? make() : structuredClone(userPrefabs[name]!) // user prefab → inlined copy
      insts.push({ prefab, transform: { position } })
      return insts.length - 1
    },
    remove: (i) => void insts.splice(i, 1),
    duplicate: (i) => {
      insts.push(structuredClone(insts[i]!))
      return insts.length - 1
    },
    label: (i) => {
      const r = insts[i]!.prefab
      return typeof r === 'string' ? r : r.id
    },
    props: (i) => ({ ...readBehavior(insts[i]!.behavior), editable: false, style: '', trigger: 'none' }),
    setProps: (i, p) => {
      const b = makeBehavior(p)
      if (b !== undefined) insts[i]!.behavior = b
      else delete insts[i]!.behavior
    },
    asLevel: () => level,
    toJSON: () => level,
  }
}

export const prefabDoc = (prefab: Prefab): Doc => {
  const pieces = prefab.pieces
  return {
    mode: 'prefab',
    count: () => pieces.length,
    transformOf: (i) => pieces[i]!.transform,
    meshSpecs: (i) => [{ collider: pieces[i]!.collider, transform: { position: vec3(0, 0, 0) }, style: pieces[i]!.visual?.style }],
    palette: () => Object.keys(PRIMITIVES),
    place: (name, position) => {
      const piece = (PRIMITIVES[name] ?? PRIMITIVES['box']!)()
      piece.transform = { position }
      pieces.push(piece)
      return pieces.length - 1
    },
    remove: (i) => void pieces.splice(i, 1),
    duplicate: (i) => {
      pieces.push(structuredClone(pieces[i]!))
      return pieces.length - 1
    },
    label: (i) => `${pieces[i]!.collider.kind}${pieces[i]!.trigger !== undefined ? ` (${pieces[i]!.trigger})` : ''}`,
    props: (i) => {
      const pc = pieces[i]!
      return { ...readBehavior(pc.behavior), editable: true, style: pc.visual?.style ?? '', trigger: pc.trigger ?? 'none' }
    },
    setProps: (i, p) => {
      const pc = pieces[i]!
      const b = makeBehavior(p)
      if (b !== undefined) pc.behavior = b
      else delete pc.behavior
      if (p.style !== '') pc.visual = { kind: 'primitive', style: p.style }
      else delete pc.visual
      if (p.trigger === 'none') delete pc.trigger
      else pc.trigger = p.trigger
    },
    asLevel: () => ({ id: prefab.id, config: { fallBehavior: 'physical-fall', fallY: -999 }, instances: [{ prefab, transform: { position: vec3(0, 0, 0) } }] }),
    toJSON: () => prefab,
  }
}
