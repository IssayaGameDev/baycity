import type { ComponentData, EnvironmentConfig, Level, ModeRef, Node, NodeOverride, Transform } from './types'
import { checkComponents, checkOverrides, checkTransform, LevelError, validateConfig, validateNodeTree } from './validate'

/**
 * Level operations (ADR 0089): the unit of a live edit.
 *
 * The editor used to mutate the `Level` object in place and remember whole-document snapshots for undo. Live
 * editing needs the edit itself as data: small enough to send, precise enough to apply on every open copy,
 * and invertible so a person's undo touches only what that person did. This module is that data and the one
 * implementation of applying it — the editor, the server and a peer's editor all run this same code, so their
 * copies of a level stay byte-identical.
 *
 * Rules:
 * - Nodes are addressed by **id**, never by position. Ids are unique per tree (`validateLevel`), so an authored
 *   node is `{ id }` in the level forest or `{ table, id }` inside `level.prefabs[table]`. A node seen *through*
 *   a placement (a prefab's child) is `{ owner, node }` — the key pair its override record lives under.
 * - Ids and table keys are **minted by the client** and carried in the op. The server never invents one, so
 *   what it applies is what the client applied.
 * - Every op has an exact inverse, computed against the state **before** it applies (`invertOp`). An op that
 *   would change nothing inverts to `null`, which is how a no-op edit is recognised and dropped.
 * - `applyOp` validates first and mutates only if the whole op is legal. Structure only: parameters need a
 *   game's registry, which the editor has and the server does not (`ParamChecker` is the editor's business).
 * - Empty `children` arrays and emptied override records are tidied here, so client and server write the same
 *   JSON — the same tidying the editor's document did before ops existed.
 */

/** An authored node, by id, in the level forest (`table` absent) or in `level.prefabs[table]`. */
export interface OwnRef {
  table?: string
  id: string
}
/** A prefab-side node as seen through one placement: the pair an override record is keyed by. Level forest only. */
export interface InheritedRef {
  owner: string
  node: string
}
export type NodeRef = OwnRef | InheritedRef

export const isInherited = (r: NodeRef): r is InheritedRef => 'owner' in r

/** A stable string for maps and hold tables. */
export const refKey = (r: NodeRef): string => (isInherited(r) ? `i:${r.owner}:${r.node}` : r.table !== undefined ? `t:${r.table}:${r.id}` : `n:${r.id}`)

export class OpError extends Error {}

export type OpBody =
  // --- an authored node's own content ---
  | { kind: 'setTransform'; id: string; transform: Transform }
  | { kind: 'setName'; id: string; name: string | null }
  | { kind: 'setParams'; id: string; componentId: string; patch: Record<string, unknown>; unset?: string[] }
  | { kind: 'setComponentEnabled'; id: string; componentId: string; enabled: boolean }
  | { kind: 'addComponent'; id: string; component: ComponentData; index?: number }
  | { kind: 'removeComponent'; id: string; componentId: string }
  | { kind: 'moveComponent'; id: string; componentId: string; to: number }
  // --- structure, authored nodes ---
  | { kind: 'insertNode'; parent: string | null; index: number; node: Node }
  | { kind: 'removeNode'; id: string }
  | { kind: 'moveNode'; id: string; parent: string | null; index: number }
  | { kind: 'replaceNode'; id: string; node: Node }
  // --- the prefab table (level scope only) ---
  | { kind: 'internPrefab'; key: string; root: Node }
  | { kind: 'dropPrefab'; key: string }
  // --- overrides a placement puts on a prefab-side node (level scope only) ---
  | { kind: 'setOverrideTransform'; owner: string; node: string; transform: Transform | null }
  | { kind: 'setOverrideName'; owner: string; node: string; name: string | null }
  | { kind: 'setOverrideParams'; owner: string; node: string; componentId: string; patch: Record<string, unknown>; unset?: string[] }
  | { kind: 'setOverrideEnabled'; owner: string; node: string; componentId: string; enabled: boolean | null }
  | { kind: 'addOverrideComponent'; owner: string; node: string; component: ComponentData }
  | { kind: 'removeOverrideComponent'; owner: string; node: string; componentId: string }
  | { kind: 'setOverrideRemoved'; owner: string; node: string; componentId: string; removed: boolean }
  | { kind: 'setNodeOverride'; owner: string; node: string; override: NodeOverride | null }
  // --- the level itself ---
  | { kind: 'setEnvironment'; environment: Partial<EnvironmentConfig> | null }
  | { kind: 'setMode'; mode: ModeRef | null }

/** `table` scopes the op to `level.prefabs[table]` (a prefab opened on top, ADR 0089); absent = the level forest. */
export type Op = OpBody & { table?: string }

export type OpKind = OpBody['kind']

// ------------------------------------------------------------------------------------------------------------
// scope and lookup

interface Found {
  node: Node
  parent: Node | null
  /** The array the node lives in; `null` for a table root, which lives in the table. */
  siblings: Node[] | null
  index: number
}

interface Scope {
  roots: Node[]
  /** The table a node in this scope may reference — empty inside a prefab tree, where references are illegal. */
  table: Record<string, Node>
  insidePrefab: boolean
  at: string
}

const scopeOf = (level: Level, table: string | undefined): Scope => {
  if (table === undefined) return { roots: level.nodes, table: level.prefabs ?? {}, insidePrefab: false, at: 'level.nodes' }
  const root = level.prefabs?.[table]
  if (root === undefined) throw new OpError(`prefab '${table}' is not in level.prefabs`)
  return { roots: [root], table: {}, insidePrefab: true, at: `level.prefabs['${table}']` }
}

const find = (scope: Scope, id: string): Found | null => {
  const walk = (list: Node[], parent: Node | null): Found | null => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!
      if (n.id === id) return { node: n, parent, siblings: scope.insidePrefab && parent === null ? null : list, index: i }
      const inner = n.children === undefined ? null : walk(n.children, n)
      if (inner !== null) return inner
    }
    return null
  }
  return walk(scope.roots, null)
}

const must = (scope: Scope, id: string): Found => {
  const f = find(scope, id)
  if (f === null) throw new OpError(`no node '${id}' in ${scope.at}`)
  return f
}

const idsIn = (roots: readonly Node[]): Set<string> => {
  const out = new Set<string>()
  const walk = (n: Node): void => {
    out.add(n.id)
    for (const kid of n.children ?? []) walk(kid)
  }
  for (const r of roots) walk(r)
  return out
}

const subtreeIds = (n: Node): string[] => {
  const out: string[] = []
  const walk = (x: Node): void => {
    out.push(x.id)
    for (const kid of x.children ?? []) walk(kid)
  }
  walk(n)
  return out
}

const contains = (root: Node, id: string): boolean => root.id === id || (root.children ?? []).some((k) => contains(k, id))

const clone = <T>(v: T): T => structuredClone(v)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** A component on an authored node, or the one a placement `added` to a prefab-side node. */
const componentOn = (list: ComponentData[], componentId: string, at: string): ComponentData => {
  const c = list.find((x) => x.id === componentId)
  if (c === undefined) throw new OpError(`no component '${componentId}' on ${at}`)
  return c
}

const checkComponent = (c: unknown, at: string): void => checkComponents([c], at, undefined)

/** The placement an override op names: an authored node of the level forest that references a prefab. */
const ownerOf = (level: Level, owner: string): Node => {
  const f = find(scopeOf(level, undefined), owner)
  if (f === null) throw new OpError(`no placement '${owner}' in level.nodes`)
  if (f.node.prefab === undefined) throw new OpError(`node '${owner}' is not a placement; it has no overrides`)
  return f.node
}

const overrideRecord = (owner: Node, node: string, create: boolean): NodeOverride | undefined => {
  if (!create) return owner.overrides?.[node]
  const map = (owner.overrides ??= {})
  return (map[node] ??= {})
}

/** Remove an override with nothing left in it, and the map with it, so the JSON accumulates no husks. */
const tidyOverride = (owner: Node, node: string): void => {
  const map = owner.overrides
  if (map === undefined) return
  const over = map[node]
  if (over !== undefined) {
    for (const k of ['params', 'enabled'] as const) {
      const sub = over[k]
      if (sub !== undefined && Object.keys(sub).length === 0) delete over[k]
    }
    for (const k of ['added', 'removed'] as const) {
      const arr = over[k]
      if (arr !== undefined && arr.length === 0) delete over[k]
    }
    if (Object.keys(over).length === 0) delete map[node]
  }
  if (Object.keys(map).length === 0) delete owner.overrides
}

/** Drop a `children: []` left behind by a move or a removal. */
const tidyChildren = (parent: Node | null): void => {
  if (parent?.children !== undefined && parent.children.length === 0) delete parent.children
}

/**
 * Patch a record in place: set `patch`'s keys, delete `unset`. Returns the inverse patch/unset against the
 * record as it was, or `null` when nothing changes.
 */
const patchRecord = (target: Record<string, unknown>, patch: Record<string, unknown>, unset: readonly string[]): { patch: Record<string, unknown>; unset: string[] } | null => {
  const back: Record<string, unknown> = {}
  const backUnset: string[] = []
  let changed = false
  for (const [k, v] of Object.entries(patch)) {
    if (k in target) {
      if (same(target[k], v)) continue
      back[k] = clone(target[k])
    } else backUnset.push(k)
    changed = true
  }
  for (const k of unset) {
    if (!(k in target)) continue
    back[k] = clone(target[k])
    changed = true
  }
  if (!changed) return null
  for (const [k, v] of Object.entries(patch)) target[k] = clone(v)
  for (const k of unset) delete target[k]
  return { patch: back, unset: backUnset }
}

/** Where a `setOverrideParams`/`setOverrideEnabled` lands: the added component itself, or the override maps. */
const overrideTarget = (owner: Node, node: string, componentId: string): { added: ComponentData } | { over: NodeOverride | undefined } => {
  const over = overrideRecord(owner, node, false)
  const added = over?.added?.find((c) => c.id === componentId)
  return added !== undefined ? { added } : { over }
}

// ------------------------------------------------------------------------------------------------------------
// inverses

/**
 * The op that undoes `op` against `level` as it is **now** — so call it before `applyOp`. `null` means `op`
 * changes nothing. Throws `OpError` for what `applyOp` would refuse, with the same message.
 */
export const invertOp = (level: Level, op: Op): Op | null => {
  try {
    return invert(level, op)
  } catch (e) {
    // The validator's refusals are this module's refusals: one error type for a caller to catch.
    if (e instanceof LevelError) throw new OpError(e.message)
    throw e
  }
}

const invert = (level: Level, op: Op): Op | null => {
  const t = op.table
  const stamp = (body: OpBody): Op => (t === undefined ? body : { ...body, table: t })
  switch (op.kind) {
    case 'setTransform': {
      const { node } = must(scopeOf(level, t), op.id)
      checkTransform(op.transform, 'transform')
      return same(node.transform, op.transform) ? null : stamp({ kind: 'setTransform', id: op.id, transform: clone(node.transform) })
    }
    case 'setName': {
      const { node } = must(scopeOf(level, t), op.id)
      const prior = node.name ?? null
      return prior === op.name ? null : stamp({ kind: 'setName', id: op.id, name: prior })
    }
    case 'setParams': {
      const { node } = must(scopeOf(level, t), op.id)
      const c = componentOn(node.components, op.componentId, `node '${op.id}'`)
      const back = patchRecord(clone(c.params), op.patch, op.unset ?? [])
      return back === null ? null : stamp({ kind: 'setParams', id: op.id, componentId: op.componentId, patch: back.patch, unset: back.unset })
    }
    case 'setComponentEnabled': {
      const { node } = must(scopeOf(level, t), op.id)
      const c = componentOn(node.components, op.componentId, `node '${op.id}'`)
      const prior = c.enabled !== false
      return prior === op.enabled ? null : stamp({ kind: 'setComponentEnabled', id: op.id, componentId: op.componentId, enabled: prior })
    }
    case 'addComponent': {
      const { node } = must(scopeOf(level, t), op.id)
      checkComponent(op.component, 'component')
      if (node.components.some((c) => c.id === op.component.id)) throw new OpError(`component '${op.component.id}' is already on node '${op.id}'`)
      return stamp({ kind: 'removeComponent', id: op.id, componentId: op.component.id })
    }
    case 'removeComponent': {
      const { node } = must(scopeOf(level, t), op.id)
      const index = node.components.findIndex((c) => c.id === op.componentId)
      if (index < 0) throw new OpError(`no component '${op.componentId}' on node '${op.id}'`)
      return stamp({ kind: 'addComponent', id: op.id, component: clone(node.components[index]!), index })
    }
    case 'moveComponent': {
      const { node } = must(scopeOf(level, t), op.id)
      const from = node.components.findIndex((c) => c.id === op.componentId)
      if (from < 0) throw new OpError(`no component '${op.componentId}' on node '${op.id}'`)
      const to = Math.max(0, Math.min(node.components.length - 1, op.to))
      return to === from ? null : stamp({ kind: 'moveComponent', id: op.id, componentId: op.componentId, to: from })
    }
    case 'insertNode': {
      const scope = scopeOf(level, t)
      if (op.parent === null && scope.insidePrefab) throw new OpError('a prefab has one root; insert under it')
      const ids = idsIn(scope.roots)
      validateNodeTree(op.node, 'node', { ids: new Set(), insidePrefab: scope.insidePrefab })
      for (const id of subtreeIds(op.node)) if (ids.has(id)) throw new OpError(`node id '${id}' is already in ${scope.at}`)
      if (op.parent !== null) must(scope, op.parent)
      return stamp({ kind: 'removeNode', id: op.node.id })
    }
    case 'removeNode': {
      const scope = scopeOf(level, t)
      const f = must(scope, op.id)
      if (f.siblings === null) throw new OpError(`'${op.id}' is the prefab's root; a prefab cannot lose its root`)
      return stamp({ kind: 'insertNode', parent: f.parent?.id ?? null, index: f.index, node: clone(f.node) })
    }
    case 'moveNode': {
      const scope = scopeOf(level, t)
      const f = must(scope, op.id)
      if (f.siblings === null) throw new OpError(`'${op.id}' is the prefab's root; it cannot move`)
      if (op.parent === null && scope.insidePrefab) throw new OpError('a prefab has one root; move under it')
      if (op.parent !== null) {
        if (contains(f.node, op.parent)) throw new OpError(`'${op.parent}' is inside '${op.id}'; a node cannot become its own descendant`)
        must(scope, op.parent)
      }
      const priorParent = f.parent?.id ?? null
      if (priorParent === op.parent) {
        const to = Math.max(0, Math.min(f.siblings.length - 1, op.index))
        if (to === f.index) return null
      }
      return stamp({ kind: 'moveNode', id: op.id, parent: priorParent, index: f.index })
    }
    case 'replaceNode': {
      const scope = scopeOf(level, t)
      const f = must(scope, op.id)
      if (op.node.id !== op.id) throw new OpError(`replaceNode keeps the id: '${op.node.id}' is not '${op.id}'`)
      const others = idsIn(scope.roots)
      for (const id of subtreeIds(f.node)) others.delete(id)
      validateNodeTree(op.node, 'node', { ids: new Set(), insidePrefab: scope.insidePrefab })
      for (const id of subtreeIds(op.node)) if (others.has(id)) throw new OpError(`node id '${id}' is already in ${scope.at}`)
      return same(f.node, op.node) ? null : stamp({ kind: 'replaceNode', id: op.id, node: clone(f.node) })
    }
    case 'internPrefab': {
      if (t !== undefined) throw new OpError('the prefab table belongs to the level, not to a prefab')
      validateNodeTree(op.root, `level.prefabs['${op.key}']`, { ids: new Set(), insidePrefab: true })
      const existing = level.prefabs?.[op.key]
      if (existing === undefined) return { kind: 'dropPrefab', key: op.key }
      if (same(existing, op.root)) return null
      throw new OpError(`prefab '${op.key}' already exists with a different definition`)
    }
    case 'dropPrefab': {
      if (t !== undefined) throw new OpError('the prefab table belongs to the level, not to a prefab')
      const existing = level.prefabs?.[op.key]
      if (existing === undefined) return null
      const referenced = level.nodes.some((n) => refersTo(n, op.key))
      return referenced ? null : { kind: 'internPrefab', key: op.key, root: clone(existing) }
    }
    case 'setOverrideTransform': {
      const owner = ownerOf(level, op.owner)
      if (op.transform !== null) checkTransform(op.transform, 'transform')
      const prior = overrideRecord(owner, op.node, false)?.transform ?? null
      return same(prior, op.transform) ? null : { kind: 'setOverrideTransform', owner: op.owner, node: op.node, transform: prior === null ? null : clone(prior) }
    }
    case 'setOverrideName': {
      const owner = ownerOf(level, op.owner)
      const prior = overrideRecord(owner, op.node, false)?.name ?? null
      return prior === op.name ? null : { kind: 'setOverrideName', owner: op.owner, node: op.node, name: prior }
    }
    case 'setOverrideParams': {
      const owner = ownerOf(level, op.owner)
      const target = overrideTarget(owner, op.node, op.componentId)
      const current = 'added' in target ? target.added.params : (target.over?.params?.[op.componentId] ?? {})
      const back = patchRecord(clone(current), op.patch, op.unset ?? [])
      return back === null ? null : { kind: 'setOverrideParams', owner: op.owner, node: op.node, componentId: op.componentId, patch: back.patch, unset: back.unset }
    }
    case 'setOverrideEnabled': {
      const owner = ownerOf(level, op.owner)
      const target = overrideTarget(owner, op.node, op.componentId)
      const prior: boolean | null = 'added' in target ? target.added.enabled !== false : (target.over?.enabled?.[op.componentId] ?? null)
      return prior === op.enabled ? null : { kind: 'setOverrideEnabled', owner: op.owner, node: op.node, componentId: op.componentId, enabled: prior }
    }
    case 'addOverrideComponent': {
      const owner = ownerOf(level, op.owner)
      checkComponent(op.component, 'component')
      if (overrideRecord(owner, op.node, false)?.added?.some((c) => c.id === op.component.id) === true) {
        throw new OpError(`component '${op.component.id}' was already added on '${op.owner}/${op.node}'`)
      }
      return { kind: 'removeOverrideComponent', owner: op.owner, node: op.node, componentId: op.component.id }
    }
    case 'removeOverrideComponent': {
      const owner = ownerOf(level, op.owner)
      const added = overrideRecord(owner, op.node, false)?.added?.find((c) => c.id === op.componentId)
      if (added === undefined) throw new OpError(`no added component '${op.componentId}' on '${op.owner}/${op.node}'`)
      return { kind: 'addOverrideComponent', owner: op.owner, node: op.node, component: clone(added) }
    }
    case 'setOverrideRemoved': {
      const owner = ownerOf(level, op.owner)
      const prior = overrideRecord(owner, op.node, false)?.removed?.includes(op.componentId) ?? false
      return prior === op.removed ? null : { kind: 'setOverrideRemoved', owner: op.owner, node: op.node, componentId: op.componentId, removed: prior }
    }
    case 'setNodeOverride': {
      const owner = ownerOf(level, op.owner)
      if (op.override !== null) checkOverrides({ [op.node]: op.override }, 'overrides', undefined)
      const prior = overrideRecord(owner, op.node, false) ?? null
      return same(prior, op.override) ? null : { kind: 'setNodeOverride', owner: op.owner, node: op.node, override: prior === null ? null : clone(prior) }
    }
    case 'setEnvironment': {
      if (t !== undefined) throw new OpError('a prefab has no environment')
      validateConfig({ ...level.config, ...(op.environment === null ? {} : { environment: op.environment }) })
      const prior = level.config.environment ?? null
      return same(prior, op.environment) ? null : { kind: 'setEnvironment', environment: prior === null ? null : clone(prior) }
    }
    case 'setMode': {
      if (t !== undefined) throw new OpError('a prefab belongs to no game')
      validateConfig({ ...level.config, ...(op.mode === null ? {} : { mode: op.mode }) })
      const prior = level.config.mode ?? null
      return same(prior, op.mode) ? null : { kind: 'setMode', mode: prior === null ? null : clone(prior) }
    }
  }
}

const refersTo = (n: Node, key: string): boolean => n.prefab === key || (n.children ?? []).some((k) => refersTo(k, key))

// ------------------------------------------------------------------------------------------------------------
// apply

/** Apply `op` to `level` in place. Validates first (through `invertOp`) and throws `OpError` having changed nothing. */
export const applyOp = (level: Level, op: Op): void => {
  invertOp(level, op) // every refusal lives there, once
  const t = op.table
  switch (op.kind) {
    case 'setTransform': {
      must(scopeOf(level, t), op.id).node.transform = clone(op.transform)
      return
    }
    case 'setName': {
      const { node } = must(scopeOf(level, t), op.id)
      if (op.name === null) delete node.name
      else node.name = op.name
      return
    }
    case 'setParams': {
      const { node } = must(scopeOf(level, t), op.id)
      const c = componentOn(node.components, op.componentId, `node '${op.id}'`)
      const next = { ...c.params }
      patchRecord(next, op.patch, op.unset ?? [])
      c.params = next
      return
    }
    case 'setComponentEnabled': {
      const { node } = must(scopeOf(level, t), op.id)
      const c = componentOn(node.components, op.componentId, `node '${op.id}'`)
      if (op.enabled) delete c.enabled
      else c.enabled = false
      return
    }
    case 'addComponent': {
      const { node } = must(scopeOf(level, t), op.id)
      const at = op.index === undefined ? node.components.length : Math.max(0, Math.min(node.components.length, op.index))
      node.components.splice(at, 0, clone(op.component))
      return
    }
    case 'removeComponent': {
      const { node } = must(scopeOf(level, t), op.id)
      node.components.splice(
        node.components.findIndex((c) => c.id === op.componentId),
        1,
      )
      return
    }
    case 'moveComponent': {
      const { node } = must(scopeOf(level, t), op.id)
      const from = node.components.findIndex((c) => c.id === op.componentId)
      const [moved] = node.components.splice(from, 1)
      node.components.splice(Math.max(0, Math.min(node.components.length, op.to)), 0, moved!)
      return
    }
    case 'insertNode': {
      const scope = scopeOf(level, t)
      const host = op.parent === null ? scope.roots : (must(scope, op.parent).node.children ??= [])
      host.splice(Math.max(0, Math.min(host.length, op.index)), 0, clone(op.node))
      return
    }
    case 'removeNode': {
      const scope = scopeOf(level, t)
      const f = must(scope, op.id)
      f.siblings!.splice(f.index, 1)
      tidyChildren(f.parent)
      return
    }
    case 'moveNode': {
      const scope = scopeOf(level, t)
      const f = must(scope, op.id)
      f.siblings!.splice(f.index, 1)
      const host = op.parent === null ? scope.roots : (must(scope, op.parent).node.children ??= [])
      host.splice(Math.max(0, Math.min(host.length, op.index)), 0, f.node)
      if (host !== f.siblings) tidyChildren(f.parent)
      return
    }
    case 'replaceNode': {
      const scope = scopeOf(level, t)
      const f = must(scope, op.id)
      const fresh = clone(op.node)
      if (f.siblings === null) {
        // A table root is replaced in the table, and the wrapper a prefab document holds must see it too, so
        // the object is emptied and refilled rather than swapped.
        for (const k of Object.keys(f.node)) delete (f.node as unknown as Record<string, unknown>)[k]
        Object.assign(f.node, fresh)
      } else f.siblings[f.index] = fresh
      return
    }
    case 'internPrefab': {
      const table = (level.prefabs ??= {})
      if (table[op.key] === undefined) table[op.key] = clone(op.root)
      return
    }
    case 'dropPrefab': {
      const table = level.prefabs
      if (table === undefined || table[op.key] === undefined || level.nodes.some((n) => refersTo(n, op.key))) return
      delete table[op.key]
      if (Object.keys(table).length === 0) delete level.prefabs
      return
    }
    case 'setOverrideTransform': {
      const owner = ownerOf(level, op.owner)
      const over = overrideRecord(owner, op.node, true)!
      if (op.transform === null) delete over.transform
      else over.transform = clone(op.transform)
      tidyOverride(owner, op.node)
      return
    }
    case 'setOverrideName': {
      const owner = ownerOf(level, op.owner)
      const over = overrideRecord(owner, op.node, true)!
      if (op.name === null) delete over.name
      else over.name = op.name
      tidyOverride(owner, op.node)
      return
    }
    case 'setOverrideParams': {
      const owner = ownerOf(level, op.owner)
      const target = overrideTarget(owner, op.node, op.componentId)
      if ('added' in target) {
        const next = { ...target.added.params }
        patchRecord(next, op.patch, op.unset ?? [])
        target.added.params = next
      } else {
        const over = overrideRecord(owner, op.node, true)!
        const params = (over.params ??= {})
        const next = { ...(params[op.componentId] ?? {}) }
        patchRecord(next, op.patch, op.unset ?? [])
        if (Object.keys(next).length === 0) delete params[op.componentId]
        else params[op.componentId] = next
      }
      tidyOverride(owner, op.node)
      return
    }
    case 'setOverrideEnabled': {
      const owner = ownerOf(level, op.owner)
      const target = overrideTarget(owner, op.node, op.componentId)
      if ('added' in target) {
        if (op.enabled === false) target.added.enabled = false
        else delete target.added.enabled
      } else {
        const over = overrideRecord(owner, op.node, true)!
        const enabled = (over.enabled ??= {})
        if (op.enabled === null) delete enabled[op.componentId]
        else enabled[op.componentId] = op.enabled
      }
      tidyOverride(owner, op.node)
      return
    }
    case 'addOverrideComponent': {
      const owner = ownerOf(level, op.owner)
      const over = overrideRecord(owner, op.node, true)!
      ;(over.added ??= []).push(clone(op.component))
      return
    }
    case 'removeOverrideComponent': {
      const owner = ownerOf(level, op.owner)
      const over = overrideRecord(owner, op.node, true)!
      over.added!.splice(
        over.added!.findIndex((c) => c.id === op.componentId),
        1,
      )
      tidyOverride(owner, op.node)
      return
    }
    case 'setOverrideRemoved': {
      const owner = ownerOf(level, op.owner)
      const over = overrideRecord(owner, op.node, true)!
      const list = (over.removed ??= [])
      const at = list.indexOf(op.componentId)
      if (op.removed && at < 0) list.push(op.componentId)
      if (!op.removed && at >= 0) list.splice(at, 1)
      tidyOverride(owner, op.node)
      return
    }
    case 'setNodeOverride': {
      const owner = ownerOf(level, op.owner)
      if (op.override === null) {
        if (owner.overrides !== undefined) delete owner.overrides[op.node]
      } else (owner.overrides ??= {})[op.node] = clone(op.override)
      tidyOverride(owner, op.node)
      return
    }
    case 'setEnvironment': {
      const { environment: _dropped, ...rest } = level.config
      level.config = op.environment === null ? rest : { ...rest, environment: clone(op.environment) }
      return
    }
    case 'setMode': {
      const { mode: _dropped, ...rest } = level.config
      level.config = op.mode === null ? rest : { ...rest, mode: clone(op.mode) }
      return
    }
  }
}

/**
 * Apply a batch, all or nothing: every op is validated against a scratch copy first, so a bad third op leaves
 * the level untouched. Returns the ops that changed something (in order) and their inverses (in **undo**
 * order), so an undo entry is `applyBatch(level, inverses)`.
 */
export const applyBatch = (level: Level, ops: readonly Op[]): { ops: Op[]; inverses: Op[] } => {
  const trial = clone(level)
  const kept: Op[] = []
  const inverses: Op[] = []
  for (const op of ops) {
    const inv = invertOp(trial, op)
    applyOp(trial, op)
    if (inv === null) continue
    kept.push(op)
    inverses.push(inv)
  }
  for (const op of kept) applyOp(level, op)
  return { ops: kept, inverses: inverses.reverse() }
}

/**
 * Every node an op reads or writes, as refs — what a hold check compares against and what a repaint touches.
 * A structural op on a subtree names the whole subtree, and, for each placement in it, the prefab-side nodes
 * seen through it: deleting a placement removes what someone may be holding under it.
 */
export const touchedRefs = (level: Level, op: Op): NodeRef[] => {
  const t = op.table
  const own = (id: string): OwnRef => (t === undefined ? { id } : { table: t, id })
  const subtree = (n: Node): NodeRef[] => {
    const out: NodeRef[] = []
    const walk = (x: Node): void => {
      out.push(own(x.id))
      if (t === undefined && x.prefab !== undefined) {
        const root = level.prefabs?.[x.prefab]
        const inherited = (y: Node): void => {
          for (const kid of y.children ?? []) {
            out.push({ owner: x.id, node: kid.id })
            inherited(kid)
          }
        }
        if (root !== undefined) inherited(root)
      }
      for (const kid of x.children ?? []) walk(kid)
    }
    walk(n)
    return out
  }
  switch (op.kind) {
    case 'setTransform':
    case 'setName':
    case 'setParams':
    case 'setComponentEnabled':
    case 'addComponent':
    case 'removeComponent':
    case 'moveComponent':
      return [own(op.id)]
    case 'insertNode':
      return [...subtree(op.node), ...(op.parent === null ? [] : [own(op.parent)])]
    case 'removeNode':
    case 'replaceNode': {
      const f = find(scopeOf(level, t), op.id)
      return f === null ? [own(op.id)] : subtree(f.node)
    }
    case 'moveNode': {
      const f = find(scopeOf(level, t), op.id)
      return [...(f === null ? [own(op.id)] : subtree(f.node)), ...(op.parent === null ? [] : [own(op.parent)])]
    }
    case 'internPrefab':
    case 'dropPrefab':
    case 'setEnvironment':
    case 'setMode':
      return []
    default:
      return [{ owner: op.owner, node: op.node }]
  }
}
