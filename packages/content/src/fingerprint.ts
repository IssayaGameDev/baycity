import { walkNodes, type TypeInfo } from './nodes'
import type { Level } from './types'

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
 */
export const fingerprintLevel = (level: Level, types: TypeInfo): string[] => {
  const lines: string[] = []
  const pathOf = new Map<unknown, string>()
  walkNodes(level, types, (resolved, _node, parent) => {
    const own = labelOf(resolved.id, resolved.name)
    const path = parent === undefined ? own : `${pathOf.get(parent) ?? '?'}/${own}`
    pathOf.set(resolved, path)
    const t = resolved.transform
    const components = resolved.components
      .map((c) => `${c.type}:${c.id}${c.enabled === false ? ':off' : ''}=${JSON.stringify(canon(c.params ?? {}))}`)
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
