import { COLLIDER } from './nodes'
import type { ComponentData, Level, Node } from './types'

/**
 * One-off content migration (ADR 0177): a component field saved in the old shape — a bare node id, from when Boss's
 * `zone` was an object field — becomes `{ node, component }`, naming one component on that node.
 *
 * Which one: the node's first enabled component of the field's type, and for a `Collider` its first enabled **box**
 * before any other — the one Boss's zone read took, so every Boss chases exactly as it did. A reference resolves
 * where the runtime resolves it: inside a prefab, in that prefab; on a level's own node, among the level's own
 * nodes; in a placement's record, among that placement's pieces first and then the level's. What cannot be resolved
 * is left as it is — the code reads the old shape as the node's first of the type — and named.
 *
 * Pure: the caller reads and writes the files (`tools/editor-server/src/migrateComponentRefs.ts`).
 */

/** A `componentRef` parameter of a component type: its key, and the type it takes. */
export interface ComponentRefParam {
  readonly key: string
  readonly of: string
}

export interface ComponentRefReport {
  readonly changed: string[]
  readonly left: string[]
}

export const newComponentRefReport = (): ComponentRefReport => ({ changed: [], left: [] })

/** What the migration needs from outside: the reference parameters of a type, and a prefab by asset id. */
export interface ComponentRefDeps {
  readonly refsOf: (type: string) => readonly ComponentRefParam[]
  readonly prefabOf: (assetId: string) => Node | undefined
}

/** The component a reference takes on a node with these components, by the rule above, or `undefined`. */
const pick = (components: readonly ComponentData[], of: string): ComponentData | undefined => {
  const on = components.filter((c) => c.type === of && c.enabled !== false)
  const box = of === COLLIDER ? on.find((c) => (c.params?.shape as { kind?: unknown } | undefined)?.kind === 'box') : undefined
  return box ?? on[0] ?? components.find((c) => c.type === of)
}

/** Every node of a tree by id — children, and what a placement added under its pieces — each with its components. */
const index = (roots: readonly Node[], prefabOf: (id: string) => Node | undefined, tables?: Record<string, Node>): Map<string, readonly ComponentData[]> => {
  const out = new Map<string, readonly ComponentData[]>()
  const visit = (n: Node): void => {
    // A placement's root draws its prefab's root, and its record may add to it.
    const def = n.prefab === undefined ? undefined : (tables?.[n.prefab] ?? prefabOf(n.prefab))
    const added = def === undefined ? [] : (n.overrides?.[def.id]?.added ?? [])
    if (!out.has(n.id)) out.set(n.id, def === undefined ? n.components : [...def.components, ...added])
    for (const kid of n.children ?? []) visit(kid)
    for (const over of Object.values(n.overrides ?? {})) for (const kid of over.addedChildren ?? []) visit(kid)
  }
  for (const r of roots) visit(r)
  return out
}

/** Rewrite one component's old-shape references, resolving each through `find` in turn. */
const migrateParams = (
  params: Record<string, unknown>,
  refs: readonly ComponentRefParam[],
  finds: readonly ((id: string) => readonly ComponentData[] | undefined)[],
  where: string,
  report: ComponentRefReport,
): boolean => {
  let changed = false
  for (const { key, of } of refs) {
    const node = params[key]
    if (typeof node !== 'string' || node === '') continue
    const components = finds.map((f) => f(node)).find((c) => c !== undefined)
    const c = components === undefined ? undefined : pick(components, of)
    if (c === undefined) {
      report.left.push(`${where}.${key}: '${node}' ${components === undefined ? 'is not in reach' : `has no ${of}`}`)
      continue
    }
    params[key] = { node, component: c.id }
    report.changed.push(`${where}.${key} → ${node} / ${c.id}`)
    changed = true
  }
  return changed
}

/** A tree whose references resolve inside it: a prefab file, or one entry of a level's inline table. */
export const migratePrefabComponentRefs = (root: Node, at: string, deps: ComponentRefDeps, report: ComponentRefReport): boolean => {
  const within = index([root], deps.prefabOf)
  let changed = false
  const visit = (n: Node, path: string): void => {
    for (const c of n.components) {
      const refs = deps.refsOf(c.type)
      if (refs.length > 0) changed = migrateParams(c.params, refs, [(id) => within.get(id)], `${at}: ${path}.${c.type}`, report) || changed
    }
    for (const kid of n.children ?? []) visit(kid, `${path}/${kid.name ?? kid.id}`)
  }
  visit(root, root.name ?? root.id)
  return changed
}

/** A level: its own nodes, its placements' records, and its inline prefab table. */
export const migrateLevelComponentRefs = (level: Level, at: string, deps: ComponentRefDeps, report: ComponentRefReport): boolean => {
  const tables = level.prefabs
  const definitionOf = (id: string): Node | undefined => tables?.[id] ?? deps.prefabOf(id)
  const own = index(level.nodes, deps.prefabOf, tables)
  const inLevel = (id: string): readonly ComponentData[] | undefined => own.get(id)
  let changed = false

  const visit = (n: Node, path: string): void => {
    for (const c of n.components) {
      const refs = deps.refsOf(c.type)
      if (refs.length > 0) changed = migrateParams(c.params, refs, [inLevel], `${at}: ${path}.${c.type}`, report) || changed
    }
    const def = n.prefab === undefined ? undefined : definitionOf(n.prefab)
    if (def !== undefined && n.overrides !== undefined) {
      const pieces = index([def], deps.prefabOf)
      // A record's reference names this placement's piece first, then the level's node — as `findNode` scopes it.
      const inPlacement = (id: string): readonly ComponentData[] | undefined => {
        const base = pieces.get(id)
        return base === undefined ? undefined : [...base, ...(n.overrides?.[id]?.added ?? [])]
      }
      for (const [piece, over] of Object.entries(n.overrides)) {
        const inherited = pieces.get(piece) ?? []
        for (const [cid, patch] of Object.entries(over.params ?? {})) {
          const type = inherited.find((c) => c.id === cid)?.type
          const refs = type === undefined ? [] : deps.refsOf(type)
          if (refs.length > 0) changed = migrateParams(patch, refs, [inPlacement, inLevel], `${at}: ${path}#${piece}.${type}`, report) || changed
        }
        for (const c of over.added ?? []) {
          const refs = deps.refsOf(c.type)
          if (refs.length > 0) changed = migrateParams(c.params, refs, [inPlacement, inLevel], `${at}: ${path}#${piece}+${c.type}`, report) || changed
        }
        for (const kid of over.addedChildren ?? []) visit(kid, `${path}#${piece}/${kid.name ?? kid.id}`)
      }
    }
    for (const kid of n.children ?? []) visit(kid, `${path}/${kid.name ?? kid.id}`)
  }
  for (const n of level.nodes) visit(n, n.name ?? n.id)
  for (const [key, root] of Object.entries(tables ?? {})) changed = migratePrefabComponentRefs(root, `${at} (table ${key})`, deps, report) || changed
  return changed
}
