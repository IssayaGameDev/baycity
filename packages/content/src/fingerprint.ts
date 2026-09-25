import { vec3, type Vec3 } from '@mp/core'

import { COLLIDER, RENDERER, modelOf, walkNodes, type TypeInfo } from './nodes'
import { builtinShape, isBuiltinModel, scaleCollider } from './primitives'
import type { ColliderDesc, Level } from './types'

/**
 * What a level resolves to, as comparable lines: the safety net for a migration.
 *
 * A change to how a level *stores* its content must not change what it *is*. So fingerprint every node the
 * level resolves to — after placements are resolved and overrides are applied — before and after, and compare.
 * This is what caught the case that made it necessary: two levels held a copy of the `Trampoline` prefab whose
 * pad node was called `91521042` where the file calls it `p0`, with an override keyed on `91521042` carrying
 * `power: 60`. Re-pointing those placements at the file without remapping that id drops the override silently,
 * and the only visible symptom is a bumper that launches you less far.
 *
 * Deliberately built on `walkNodes`/`effectiveNode` rather than on `instantiateLevel`: no physics world and no
 * game registry needed, so it runs anywhere, and it compares the thing a reference change can actually break —
 * the resolved tree. Scale is baked by the loader from the same transforms, so a resolved transform standing
 * still is enough.
 */

/** A node's identity in the resolved tree: the path of names down to it, so a reordering is visible. */
const labelOf = (id: string, name: string | undefined): string => (name === undefined ? id : `${name}#${id}`)

/** Keys sorted, so a parameter written back in another order is not a difference. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : typeof v === 'object' && v !== null
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v

const round = (n: number): number => Math.round(n * 1e6) / 1e6
const vec = (v: { x: number; y: number; z: number } | undefined, fallback: number): string =>
  v === undefined ? `${fallback},${fallback},${fallback}` : `${round(v.x)},${round(v.y)},${round(v.z)}`

/**
 * One line per resolved node, in resolution order. Components carry their type, id, enabled state and every
 * parameter — which is what makes a lost override a failing comparison rather than a subtle regression.
 *
 * `types` decides how a placement's own components layer over the prefab's (a singleton replaces, a repeatable
 * appends), so pass the same registry on both sides of a comparison. `{ get: () => undefined }` treats every
 * type as repeatable, which is fine when both sides use it.
 *
 * `{ ids: false }` leaves node and component ids out, for comparing a level against the same level built over a
 * prefab **file** whose nodes are the same things under different ids — which is the case a reference migration
 * has to prove harmless. Order and content still have to match line for line.
 */
export const fingerprintLevel = (level: Level, types: TypeInfo, opts: { ids?: boolean } = {}): string[] => {
  const withIds = opts.ids ?? true
  const lines: string[] = []
  const pathOf = new Map<unknown, string>()
  walkNodes(level, types, (resolved, _node, parent) => {
    const own = withIds ? labelOf(resolved.id, resolved.name) : (resolved.name ?? '?')
    const path = parent === undefined ? own : `${pathOf.get(parent) ?? '?'}/${own}`
    pathOf.set(resolved, path)
    const t = resolved.transform
    const components = resolved.components
      .map((c) => `${c.type}${withIds ? `:${c.id}` : ''}${c.enabled === false ? ':off' : ''}=${JSON.stringify(canon(c.params ?? {}))}`)
      .join(' ')
    lines.push(`${path} | p ${vec(t.position, 0)} | r ${vec(t.rotation, 0)} | s ${vec(t.scale, 1)} | inherited ${resolved.inheritedCount} | ${components}`)
  })
  return lines
}

/** The first line that differs, with both sides, or `null` when the two fingerprints agree. */
export const firstDifference = (before: readonly string[], after: readonly string[]): { at: number; before?: string; after?: string } | null => {
  const n = Math.max(before.length, after.length)
  for (let i = 0; i < n; i++) {
    if (before[i] !== after[i]) {
      const b = before[i]
      const a = after[i]
      return { at: i, ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) }
    }
  }
  return null
}

/**
 * What a level **is on screen and in the physics world**, as comparable lines.
 *
 * Stricter than it looks and looser than `fingerprintLevel`: it normalises the two ways a size can be
 * expressed, because that is exactly what a reference migration runs into. A prefab file written after the
 * built-in shapes landed says "unit collider, scale 3 × 0.3 × 3, draw a rounded box"; a copy a level interned
 * before that says "half extents 1.5 × 0.15 × 1.5, draw the collider". They are the same pad, and a
 * component-by-component comparison says they are not. This bakes the scale in, resolves the drawn shape, and
 * compares that — plus every non-geometry component's parameters, so a tuned bumper losing its tuning is still
 * a difference.
 */
export const fingerprintGeometry = (level: Level, types: TypeInfo): string[] => {
  const lines: string[] = []
  const state = new Map<unknown, { path: string; scale: Vec3; kids: number }>()
  walkNodes(level, types, (resolved, node, parent) => {
    const above = parent === undefined ? undefined : state.get(parent)
    /**
     * The node's **own** name, not the resolved one. A placement with no name of its own shows the prefab
     * root's, so relinking it to the file that really holds its contents renames it on screen — which is a
     * label changing, not the level changing, and Kodjo chose to let that correction happen. An unnamed node
     * is its position instead; what actually pins a line is its index in this list, which is the walk order.
     */
    const seat = above === undefined ? lines.length : above.kids++
    const own = node.name ?? `#${seat}`
    const path = above === undefined ? own : `${above.path}/${own}`
    const local = resolved.transform.scale ?? vec3(1, 1, 1)
    const base = above?.scale ?? vec3(1, 1, 1)
    const worldScale = vec3(base.x * local.x, base.y * local.y, base.z * local.z)
    state.set(resolved, { path, scale: worldScale, kids: 0 })

    const colliders: string[] = []
    let drawn = 'nothing'
    let material = ''
    const others: string[] = []
    for (const c of resolved.components) {
      if (c.enabled === false) {
        others.push(`${c.type}:off`)
        continue
      }
      if (c.type === COLLIDER) {
        const shape = c.params?.shape as ColliderDesc | undefined
        colliders.push(shape === undefined ? 'none' : JSON.stringify(canon(scaleCollider(shape, worldScale))))
      } else if (c.type === RENDERER) material = String(c.params?.material ?? '')
      else others.push(`${c.type}=${JSON.stringify(canon(c.params ?? {}))}`)
    }
    const model = modelOf(resolved.components)
    const draws = resolved.components.some((c) => c.type === RENDERER && c.enabled !== false)
    if (draws) drawn = isBuiltinModel(model) ? JSON.stringify(canon(builtinShape(model, worldScale).collider)) : model !== '' ? `model:${model}` : colliders.join('+')

    const t = resolved.transform
    /**
     * World scale is deliberately **not** in the line. It is how a size is written down, not what anyone can
     * see: the baked collider and the drawn shape are, and a child's own line already carries the scale it
     * inherited. Including it would call the two ways of expressing one pad a difference.
     */
    lines.push(`${path} | p ${vec(t.position, 0)} | r ${vec(t.rotation, 0)} | collide ${colliders.join('+') || 'none'} | draw ${drawn} | mat ${material} | ${others.sort().join(' ')}`)
  })
  return lines
}
