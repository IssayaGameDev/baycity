import { vec3, type Vec3 } from '@mp/core'

import { COLLIDER, RENDERER, modelOf } from './nodes'
import type { BuiltinModel } from './primitives'
import type { ColliderDesc, ComponentData, Level, Node } from './types'

/**
 * Move a piece's size out of its collider and into its scale (ADR 0090), once, over existing content.
 *
 * Before: a `Renderer` drawing one box collider of half extents `h`, at scale `s`. After: the same node draws
 * `builtin:rounded-box` (the look every platform always had), its collider is the unit box, and its scale is
 * `s × 2h` — the loader bakes scale into the collider, so it collides exactly as before, and the renderer
 * builds the rounded box from the final size, so it looks exactly as before. A ball becomes `builtin:sphere`
 * with a uniform scale. The collider's `center` divides by the same factor, since the loader scales it too.
 *
 * Only a **leaf** is migrated: changing a parent's scale would move and resize every child, and undoing that
 * under a rotated child is a shear no transform can express. Capsules are left alone — a unit capsule cannot
 * take every height-to-radius ratio. Prefab nodes that any placement overrides are left alone too, because the
 * override is written against the old numbers. Everything left alone is named in the report.
 */
export interface MigrationReport {
  changed: string[]
  skipped: { at: string; why: string }[]
}

export const newReport = (): MigrationReport => ({ changed: [], skipped: [] })

const div = (a: Vec3, k: Vec3): Vec3 => vec3(a.x / k.x, a.y / k.y, a.z / k.z)
const mul = (a: Vec3, k: Vec3): Vec3 => vec3(a.x * k.x, a.y * k.y, a.z * k.z)
const isVec3 = (v: unknown): v is Vec3 => typeof v === 'object' && v !== null && ['x', 'y', 'z'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number')
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000
const round3 = (v: Vec3): Vec3 => vec3(r4(v.x), r4(v.y), r4(v.z))
const isOne = (v: Vec3): boolean => v.x === 1 && v.y === 1 && v.z === 1

/** The Mesh Renderer draws the built-in now (ADR 0153): its `model`, first. It wrote a `Mesh` when it ran. */
const drawWith = (renderer: ComponentData, model: BuiltinModel): void => {
  const rest = { ...renderer.params }
  delete rest.model
  renderer.params = { model, ...rest }
}

/**
 * Migrate one node in place. Returns the reason it was left alone, or `null` when it changed. A node that
 * already draws a model is not a candidate and is passed over silently (running twice changes nothing).
 */
export const migrateNode = (node: Node): string | null => {
  const has = (type: string): ComponentData[] => node.components.filter((c) => c.type === type)
  const renderer = has(RENDERER)[0]
  if (renderer === undefined || modelOf(node.components) !== '') return null
  const colliders = has(COLLIDER)
  if (colliders.length !== 1) return colliders.length === 0 ? null : 'more than one collider'
  if ((node.children?.length ?? 0) > 0) return 'has children'
  const collider = colliders[0]!
  const shape = collider.params.shape as ColliderDesc | undefined
  if (shape === undefined) return null
  let model: BuiltinModel
  let k: Vec3
  switch (shape.kind) {
    case 'box':
      model = 'builtin:rounded-box'
      k = mul(shape.halfExtents, vec3(2, 2, 2))
      break
    case 'ball':
      model = 'builtin:sphere'
      k = vec3(shape.radius * 2, shape.radius * 2, shape.radius * 2)
      break
    default:
      return `a ${shape.kind} collider`
  }
  if (k.x <= 0 || k.y <= 0 || k.z <= 0) return 'a zero-sized collider'
  if (isOne(k)) {
    // Already unit: only the model is missing, and nothing moves.
    drawWith(renderer, model)
    return null
  }
  const scale = node.transform.scale ?? vec3(1, 1, 1)
  const next = round3(mul(scale, k))
  node.transform = { ...node.transform, ...(isOne(next) ? {} : { scale: next }) }
  if (isOne(next)) delete node.transform.scale
  const centre = collider.params.center
  const params: Record<string, unknown> = { ...collider.params, shape: shape.kind === 'ball' ? { kind: 'ball', radius: 0.5 } : { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) } }
  if (isVec3(centre) && (centre.x !== 0 || centre.y !== 0 || centre.z !== 0)) params.center = round3(div(centre, k))
  collider.params = params
  drawWith(renderer, model)
  return null
}

const walk = (nodes: readonly Node[], at: string, protectedIds: ReadonlySet<string>, report: MigrationReport): void => {
  for (const node of nodes) {
    const here = `${at}/${node.name ?? node.id}`
    if (protectedIds.has(node.id)) {
      if (node.components.some((c) => c.type === RENDERER) && modelOf(node.components) === '' && node.components.some((c) => c.type === COLLIDER)) report.skipped.push({ at: here, why: 'a placement overrides it' })
    } else {
      const before = JSON.stringify(node.components) + JSON.stringify(node.transform)
      const why = migrateNode(node)
      if (why !== null) report.skipped.push({ at: here, why })
      else if (before !== JSON.stringify(node.components) + JSON.stringify(node.transform)) report.changed.push(here)
    }
    if (node.children !== undefined) walk(node.children, here, protectedIds, report)
  }
}

/** A prefab on its own (a `*.prefab.json` file): nothing overrides it here. */
export const migratePrefabTree = (root: Node, at: string, report: MigrationReport): void => walk([root], at, new Set(), report)

/**
 * A level: its own nodes, then each prefab in its table — with every node id any placement of that prefab
 * overrides kept out of reach, since an override transform or collider patch is written against the old
 * numbers.
 */
export const migrateLevel = (level: Level, at: string, report: MigrationReport): void => {
  // Placements are never leaves in the sense that matters (their children are the prefab's), and their own
  // components rarely draw; `migrateNode` handles them like any other node.
  walk(level.nodes, at, new Set(), report)
  const prefabs = level.prefabs ?? {}
  const overriddenBy = new Map<string, Set<string>>()
  const collect = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      if (n.prefab !== undefined && n.overrides !== undefined) {
        const set = overriddenBy.get(n.prefab) ?? new Set<string>()
        for (const id of Object.keys(n.overrides)) set.add(id)
        overriddenBy.set(n.prefab, set)
      }
      if (n.children !== undefined) collect(n.children)
    }
  }
  collect(level.nodes)
  for (const root of Object.values(prefabs)) collect([root])
  for (const [key, root] of Object.entries(prefabs)) walk([root], `${at}/prefabs/${key}`, overriddenBy.get(key) ?? new Set(), report)
}
