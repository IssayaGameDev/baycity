import type { Vec3 } from '@mp/core'
import type { ComponentData, Node, NodeLevel, NodeOverride, Transform } from './types'

/**
 * Node-tree helpers: the component types the **engine itself** must understand, and the resolution of a
 * placement against the prefab it references (PLAN-component-system, stage C1).
 *
 * Gameplay component names appear nowhere here. The loader hands a mode every component on a node and the
 * mode picks out the ones it knows, so adding a rule never touches this package.
 */

/** A collision shape. Repeatable per node. */
export const COLLIDER = 'Collider'
/** Which mesh a node draws, when it draws one rather than its colliders. Unity's `MeshFilter`. */
export const MESH = 'Mesh'
/** That a node draws at all, and with what surface. Unity's `MeshRenderer`. */
export const RENDERER = 'Renderer'
/** Resurfaces this node and everything below it. */
export const MATERIAL_OVERRIDE = 'MaterialOverride'
/** Clock-driven keyed motion, evaluated by the loader's frame tree. */
export const TRACK = 'Track'
/** Where players enter. */
export const SPAWN = 'Spawn'

/**
 * The one thing resolution needs to know about a component type, and the only reason this package needs
 * anything from `@mp/components`: whether a second copy on one node is meaningful.
 *
 * A `Registry` satisfies it structurally, so the dependency stays one-way — components depends on content,
 * and content takes a capability as an argument.
 */
export interface TypeInfo {
  readonly get: (type: string) => { readonly singleton?: boolean } | undefined
}

/** Enabled components of a type, in order. `enabled` absent means enabled. */
export const componentsOfType = (components: readonly ComponentData[], type: string): ComponentData[] =>
  components.filter((c) => c.type === type && c.enabled !== false)

/** The first enabled component of a type, or `undefined`. What a singleton lookup wants. */
export const firstOfType = (components: readonly ComponentData[], type: string): ComponentData | undefined =>
  components.find((c) => c.type === type && c.enabled !== false)

/** A number parameter, or the fallback when it is absent or not a number. */
export const numberParam = (c: ComponentData | undefined, key: string, fallback: number): number => {
  const v = c?.params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** A Vec3 parameter, or the fallback when it is absent or malformed. */
export const vec3Param = (c: ComponentData | undefined, key: string, fallback: Vec3): Vec3 => {
  const v = c?.params[key]
  if (v === null || typeof v !== 'object') return fallback
  const { x, y, z } = v as Record<string, unknown>
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? { x, y, z } : fallback
}

/** A string parameter, or the fallback. */
export const stringParam = (c: ComponentData | undefined, key: string, fallback: string): string => {
  const v = c?.params[key]
  return typeof v === 'string' ? v : fallback
}

/** What a node is once its prefab reference, its overrides and its own layer have been resolved. */
export interface Resolved {
  readonly id: string
  readonly name: string | undefined
  readonly transform: Transform
  readonly components: readonly ComponentData[]
  /**
   * Inherited children (already patched) followed by the placement's own. Plain `Node`s, so a consumer
   * resolves each one the same way — an inherited child can never itself reference a prefab, but one of
   * the placement's own can.
   */
  readonly children: readonly Node[]
  /**
   * How many of `children` came from the prefab rather than from this placement.
   *
   * The split matters for one thing only, and it is worth the field: a `nodeRef` authored *inside* a prefab
   * names a node in that prefab, and every placement has to resolve it to its own copy. The inherited run is
   * that scope; the placement's own children are the level's (stage C4).
   */
  readonly inheritedCount: number
}

const patchComponents = (components: readonly ComponentData[], o: NodeOverride | undefined): ComponentData[] => {
  if (o === undefined) return [...components]
  const removed = new Set(o.removed ?? [])
  const out: ComponentData[] = []
  for (const c of components) {
    if (removed.has(c.id)) continue
    const patch = o.params?.[c.id]
    const enabled = o.enabled?.[c.id]
    if (patch === undefined && enabled === undefined) out.push(c)
    else out.push({ ...c, ...(patch !== undefined ? { params: { ...c.params, ...patch } } : {}), ...(enabled !== undefined ? { enabled } : {}) })
  }
  return [...out, ...(o.added ?? [])]
}

/**
 * Apply a placement's overrides to one inherited node and everything below it, returning a tree that needs
 * no reference to explain itself.
 *
 * Exported because two callers want exactly this: `effectiveNode` below, and anything that has to turn a
 * placement back into plain nodes — extracting a one-off, or migrating an inline definition.
 *
 * Returns **the prefab's own object** when nothing changed, at any depth. Deliberate, and the same choice
 * `effectivePieces` made under ADR 0033: the editor writes through the objects it is handed when editing
 * the shared definition, so copying unconditionally would turn a prefab edit into a silent no-op.
 */
export const bakeOverrides = (node: Node, overrides: Record<string, NodeOverride> | undefined): Node => {
  const o = overrides?.[node.id]
  const kids = node.children
  const patchedKids = kids === undefined ? undefined : kids.map((k) => bakeOverrides(k, overrides))
  const kidsChanged = kids !== undefined && patchedKids !== undefined && patchedKids.some((k, i) => k !== kids[i])
  if (o === undefined && !kidsChanged) return node
  return {
    ...node,
    ...(o?.name !== undefined ? { name: o.name } : {}),
    ...(o?.transform !== undefined ? { transform: o.transform } : {}),
    components: patchComponents(node.components, o),
    ...(patchedKids !== undefined ? { children: patchedKids } : {}),
  }
}

/**
 * The placement's own components layered over what it inherited.
 *
 * A **singleton** type the placement declares replaces the inherited one — which is exactly the
 * `inst.behavior ?? prefab.behavior` precedence this migrated from, and what makes `MaterialOverride` on a
 * placement beat the prefab's. A **repeatable** type appends, because a placement adding a collider must
 * not delete the prefab's.
 */
const layerOwn = (inherited: readonly ComponentData[], own: readonly ComponentData[], types: TypeInfo): ComponentData[] => {
  if (own.length === 0) return [...inherited]
  const replaced = new Set(own.filter((c) => types.get(c.type)?.singleton === true).map((c) => c.type))
  return [...inherited.filter((c) => !replaced.has(c.type)), ...own]
}

/**
 * Resolve one node: itself when it references nothing, or the prefab's root wearing this placement's
 * transform, name and id when it does.
 *
 * A placement's own `children` are **appended after** the inherited ones, which is what the loader already
 * did (a prefab's pieces, then the instance's children). An unknown prefab key resolves to the placement's
 * own layer alone rather than throwing: `validateNodeLevel` is where a dangling reference is reported, and
 * a viewer should still show the rest of the level.
 */
export const effectiveNode = (level: NodeLevel, node: Node, types: TypeInfo): Resolved => {
  const root = node.prefab === undefined ? undefined : level.prefabs?.[node.prefab]
  if (root === undefined) {
    return {
      id: node.id,
      name: node.name,
      transform: node.transform,
      components: node.components,
      children: node.children ?? [],
      inheritedCount: 0,
    }
  }
  const patched = bakeOverrides(root, node.overrides)
  const inherited = patched.children ?? []
  return {
    id: node.id,
    name: node.name ?? patched.name,
    transform: node.transform,
    components: layerOwn(patched.components, node.components, types),
    children: [...inherited, ...(node.children ?? [])],
    inheritedCount: inherited.length,
  }
}

/** Depth-first walk over a resolved tree, parent before child — the order the loader's frames need. */
export const walkNodes = (
  level: NodeLevel,
  types: TypeInfo,
  visit: (resolved: Resolved, node: Node, parent: Resolved | undefined) => void,
): void => {
  const step = (node: Node, parent: Resolved | undefined): void => {
    const resolved = effectiveNode(level, node, types)
    visit(resolved, node, parent)
    for (const child of resolved.children) step(child, resolved)
  }
  for (const node of level.nodes) step(node, undefined)
}
