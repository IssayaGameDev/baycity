import type { Vec3 } from '@mp/core'
import { readStages, SEQUENCE, stagesFor } from './sequenceData'
import type { ComponentData, Node, Level, NodeOverride, Transform } from './types'

/**
 * Node-tree helpers: the component types the **engine itself** must understand, and the resolution of a
 * placement against the prefab it references (PLAN-component-system, stage C1).
 *
 * Gameplay component names appear nowhere here. The loader hands a mode every component on a node and the
 * mode picks out the ones it knows, so adding a rule never touches this package.
 */

/** A collision shape. Repeatable per node. */
export const COLLIDER = 'Collider'
/**
 * A type that is gone (ADR 0153): the shape a node drew, folded into `Renderer.model` on every file. Named only by
 * the one-off tools that wrote or folded it; no registry has it, so a file still carrying one does not load.
 */
export const MESH = 'Mesh'
/** That a node draws, what, and with what surface — the Mesh Renderer (ADR 0153). Unity's `MeshRenderer` and `MeshFilter` in one. */
export const RENDERER = 'Renderer'
/** Resurfaces this node and everything below it. */
export const MATERIAL_OVERRIDE = 'MaterialOverride'
/** Stages of steps (ADR 0137); declared in `sequenceData.ts`, which this module imports. */
export { SEQUENCE }
/** Where players enter. */
export const SPAWN = 'Spawn'
/** A light. Realized by the renderer, but the loader has to surface it, so the engine knows the name. */
export const LIGHT = 'Light'
/** Text in the world (ADR 0189). Surfaced by the loader as a light is; drawn by the renderer. */
export const TEXT = 'Text'

/**
 * The one thing resolution needs to know about a component type, and the only reason this package needs
 * anything from `@mp/components`: whether a second copy on one node is meaningful.
 *
 * A `Registry` satisfies it structurally, so the dependency stays one-way — components depends on content,
 * and content takes a capability as an argument.
 */
export interface TypeInfo {
  readonly get: (type: string) => { readonly singleton?: boolean; readonly moves?: boolean } | undefined
}

/**
 * A free key in a prefab table for `entry`, wanting `key` — reusing an existing entry that is **identical**,
 * so placing the same prefab twice shares one entry instead of filling the table with copies.
 *
 * The wanted key is passed in rather than read off the value, because it is the *file name*: a name stored
 * inside a prefab is routinely stale (commit 0fc0b9f).
 */
export const freeTableKey = <T>(table: Record<string, T>, key: string, entry: T): string => {
  const body = JSON.stringify(entry)
  const same = (a: T): boolean => JSON.stringify(a) === body
  const at = table[key]
  if (at === undefined || same(at)) return key
  for (let n = 2; ; n++) {
    const id = `${key}-${n}`
    const other = table[id]
    if (other === undefined || same(other)) return id
  }
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

/**
 * The model a node draws (ADR 0153): its enabled `Renderer`'s `model`. `''` draws the node's colliders; whether
 * anything is drawn at all is whether there is an enabled `Renderer`.
 */
export const modelOf = (components: readonly ComponentData[]): string => stringParam(firstOfType(components, RENDERER), 'model', '')

/** A boolean parameter, or the fallback. */
export const boolParam = (c: ComponentData | undefined, key: string, fallback: boolean): boolean => {
  const v = c?.params[key]
  return typeof v === 'boolean' ? v : fallback
}

/** What a node is once its prefab reference, its overrides and its own layer have been resolved. */
export interface Resolved {
  readonly id: string
  readonly name: string | undefined
  readonly transform: Transform
  /**
   * `false` when this node and its subtree must not be built (ADR 0099). Absent or `true` means build it.
   *
   * A placement's own answer wins over the prefab root's, so a placement can switch itself off without
   * touching the prefab — and a prefab whose root is disabled is off everywhere it is placed.
   */
  readonly enabled: boolean | undefined
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
    const sequence = c.type === SEQUENCE ? o.sequences?.[c.id] : undefined
    if (patch === undefined && enabled === undefined && sequence === undefined) {
      out.push(c)
      continue
    }
    const params = patch === undefined ? c.params : { ...c.params, ...patch }
    // After the params patch, so the prefab's stages are what the placement's differences apply to (ADR 0139).
    const withStages = sequence === undefined ? params : { ...params, stages: stagesFor(readStages(params.stages), sequence) }
    out.push({ ...c, ...(withStages !== c.params ? { params: withStages } : {}), ...(enabled !== undefined ? { enabled } : {}) })
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
 * Returns **the prefab's own object** when nothing changed, at any depth. Deliberate, and the same choice the
 * piece-shaped resolver made under ADR 0033: the editor writes through the objects it is handed when editing
 * the shared definition, so copying unconditionally would turn a prefab edit into a silent no-op.
 */
/** Does this placement do without the prefab's `id`, subtree and all (ADR 0133)? */
const isRemoved = (overrides: Record<string, NodeOverride> | undefined, id: string): boolean =>
  overrides?.[id]?.removedNodes?.includes(id) === true

/**
 * The children a placement shows under `node`: the prefab's, minus the removed, plus the added, in this
 * placement's order (ADR 0135).
 *
 * `childOrder` is a preference, not a contract: ids it names that are gone are skipped, and children it does
 * not mention keep their place at the end. So a prefab that gains a piece does not invalidate an order a
 * placement recorded before it existed.
 */
export const childrenFor = (
  node: Node,
  o: NodeOverride | undefined,
  overrides: Record<string, NodeOverride> | undefined,
): Node[] | undefined => {
  const inherited = (node.children ?? []).filter((k) => !isRemoved(overrides, k.id))
  const added = o?.addedChildren ?? []
  if (node.children === undefined && added.length === 0) return undefined
  const all = [...inherited, ...added]
  const order = o?.childOrder
  if (order === undefined) return all
  const byId = new Map(all.map((k) => [k.id, k]))
  const first = order.map((id) => byId.get(id)).filter((k): k is Node => k !== undefined)
  const named = new Set(first.map((k) => k.id))
  return [...first, ...all.filter((k) => !named.has(k.id))]
}

export const bakeOverrides = (node: Node, overrides: Record<string, NodeOverride> | undefined): Node => {
  const o = overrides?.[node.id]
  const kids = node.children
  /**
   * A removed child is **dropped, not patched** (ADR 0133) — Unity's removed GameObject. Its own subtree
   * goes with it, the way removing any node takes its children, and nothing below it is visited: an
   * override on a piece that is not there has nothing to apply to.
   */
  const shown = childrenFor(node, o, overrides)
  const patchedKids = shown === undefined ? undefined : shown.map((k) => bakeOverrides(k, overrides))
  const kidsChanged =
    patchedKids !== undefined &&
    (kids === undefined || patchedKids.length !== kids.length || patchedKids.some((k, i) => k !== kids[i]))
  if (o === undefined && !kidsChanged) return node
  return {
    ...node,
    ...(o?.name !== undefined ? { name: o.name } : {}),
    ...(o?.nodeEnabled !== undefined ? { enabled: o.nodeEnabled } : {}),
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
 * own layer alone rather than throwing: `validateLevel` is where a dangling reference is reported, and
 * a viewer should still show the rest of the level.
 */
export const effectiveNode = (level: Level, node: Node, types: TypeInfo): Resolved => {
  const root = node.prefab === undefined ? undefined : level.prefabs?.[node.prefab]
  if (root === undefined) {
    return {
      id: node.id,
      name: node.name,
      transform: node.transform,
      enabled: node.enabled,
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
    // The placement's own answer first, then the prefab root's: a placement may switch itself off, and a
    // prefab disabled at its root is off wherever it is placed.
    enabled: node.enabled ?? patched.enabled,
    components: layerOwn(patched.components, node.components, types),
    children: [...inherited, ...(node.children ?? [])],
    inheritedCount: inherited.length,
  }
}

/** Depth-first walk over a resolved tree, parent before child — the order the loader's frames need. */
export const walkNodes = (
  level: Level,
  types: TypeInfo,
  visit: (resolved: Resolved, node: Node, parent: Resolved | undefined) => void,
): void => {
  const step = (node: Node, parent: Resolved | undefined): void => {
    const resolved = effectiveNode(level, node, types)
    // A disabled node is not built, and neither is anything under it (ADR 0099) — so it is not visited and
    // its children are never reached. Every consumer of this walk wants what the level *is*, and a disabled
    // subtree is not part of that.
    if (resolved.enabled === false) return
    visit(resolved, node, parent)
    for (const child of resolved.children) step(child, resolved)
  }
  for (const node of level.nodes) step(node, undefined)
}
