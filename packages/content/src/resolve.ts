import type { Level, Prefab, PrefabInstance } from './types'

/**
 * Resolve an instance's prefab: an inline definition is itself, an id is looked up in
 * `Level.prefabs`. Referencing is the whole point of that table — one entry, many instances, edit
 * once — so the lookup lives here rather than inside the loader, where the editor could not reach it
 * and would grow a second definition of the same rule.
 */
export const resolvePrefab = (level: Level, inst: PrefabInstance): Prefab => {
  if (typeof inst.prefab !== 'string') return inst.prefab
  const found = level.prefabs?.[inst.prefab]
  if (found === undefined) throw new Error(`prefab '${inst.prefab}' not found in level.prefabs`)
  return found
}

/**
 * One placed instance, found by walking the tree, with everything needed to address it: who its parent
 * is, and which array it lives in and where. Reordering splices within `siblings`; reparenting splices
 * from one `siblings` into another.
 */
export interface InstanceVisit {
  inst: PrefabInstance
  parent: PrefabInstance | null
  siblings: PrefabInstance[]
  /** Position within `siblings`. */
  index: number
  /** 0 for a top-level instance. */
  depth: number
}

/**
 * Every instance in the level, **depth-first, parents before children** — one definition of that order,
 * shared by the loader (where it fixes the movement-base numbering every client must agree on) and the
 * editor (where it is the row order of the hierarchy).
 */
export const walkInstances = (level: Level): InstanceVisit[] => {
  const out: InstanceVisit[] = []
  const visit = (siblings: PrefabInstance[], parent: PrefabInstance | null, depth: number): void => {
    siblings.forEach((inst, index) => {
      out.push({ inst, parent, siblings, index, depth })
      if (inst.children !== undefined) visit(inst.children, inst, depth + 1)
    })
  }
  visit(level.instances, null, 0)
  return out
}

/** The instances referencing `id`, at any depth — what "3 instances" in the editor counts. */
export const instancesOf = (level: Level, id: string): PrefabInstance[] =>
  walkInstances(level)
    .filter((v) => v.inst.prefab === id)
    .map((v) => v.inst)

/**
 * A table id for `prefab` that will not collide with a *different* prefab already in `table`.
 * Same id and same content reuses the entry — placing the same kit piece twice shares one — while
 * same id, different content takes a numeric suffix. Content compared with the id blanked, since
 * the id is exactly what is allowed to differ.
 */
export const freeTableId = (table: Record<string, Prefab>, prefab: Prefab): string => {
  const body = JSON.stringify({ ...prefab, id: '' })
  const same = (a: Prefab): boolean => JSON.stringify({ ...a, id: '' }) === body
  const at = table[prefab.id]
  if (at === undefined || same(at)) return prefab.id
  for (let n = 2; ; n++) {
    const id = `${prefab.id}-${n}`
    const other = table[id]
    if (other === undefined || same(other)) return id
  }
}
