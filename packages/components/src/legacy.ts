import {
  bakeOverrides,
  COLLIDER,
  MATERIAL_OVERRIDE,
  SPAWN,
  TRACK,
  MESH,
  RENDERER,
  visualMaterial,
  visualModel,
  type Behavior,
  type ComponentData,
  type Level,
  type Marker,
  type Node,
  type NodeLevel,
  type NodeOverride,
  type Piece,
  type PieceOverride,
  type Prefab,
  type PrefabInstance,
  type Transform,
  type Trigger,
} from '@mp/content'
import { Bumper, Checkpoint, Goal, Hazard } from './gameplay'
import { DEFAULT_REGISTRY } from './defaults'

/**
 * Converts a `Level` (pieces and instances) into a `NodeLevel` (nodes and components).
 *
 * Written once and used three times: as the bridge while the loader is moved over (stage C1.3), as the
 * script that rewrites `content/**` (stage C1.4), and as the fixture generator for the equivalence tests
 * that prove the two produce the same world. Deleted with the legacy schema once nothing reads it.
 *
 * Every mapping below is behaviour-preserving on purpose — a migration that also improves something is a
 * migration you cannot verify.
 */

const IDENTITY: Transform = { position: { x: 0, y: 0, z: 0 } }

/** A trigger kind's component. Rules are the mode's, so their names come from `gameplay.ts`. */
const RULE = { checkpoint: Checkpoint, goal: Goal, hazard: Hazard, bumper: Bumper } as const
const RULE_TYPES = new Set(Object.values(RULE).map((d) => d.type))

/** Sequential component ids, unique within one node — which is the scope an override addresses. */
const counter = (prefix: string): (() => string) => {
  let n = 0
  return () => `${prefix}${n++}`
}

const comp = (id: string, type: string, params: Record<string, unknown>): ComponentData => ({ id, type, params })

/** `{ kind: 'static' }` and absence both mean "no motion", so neither produces a component. */
const trackParams = (b: Behavior | undefined): Record<string, unknown> | undefined =>
  b === undefined || b.kind !== 'track' ? undefined : { keys: b.keys, loop: b.loop ?? 'loop', phaseMs: b.phaseMs ?? 0 }

const ruleParams = (t: Trigger): Record<string, unknown> => (t.kind === 'bumper' ? { power: t.power } : {})

/**
 * A piece's four fields as components.
 *
 * A `Renderer` is **always** written, even where the piece had no visual: an omitted `Piece.visual` greyboxed
 * the collider, and a node with no `Renderer` draws nothing. Absent has to mean absent once it is a component,
 * so the old default becomes explicit data here rather than a rule in the renderer.
 *
 * A `Mesh` is written only for a piece that named one — its absence is what says "draw the colliders", where
 * the first cut of this schema used a `source` enum for the same thing (ADR 0039).
 */
const componentsOfPiece = (piece: Piece): ComponentData[] => {
  const id = counter('c')
  const out: ComponentData[] = [comp(id(), COLLIDER, { shape: piece.collider })]
  const model = visualModel(piece.visual)
  const material = visualMaterial(piece.visual) ?? ''
  if (model !== undefined) out.push(comp(id(), MESH, { model }))
  out.push(comp(id(), RENDERER, { material }))
  if (piece.trigger !== undefined) out.push(comp(id(), RULE[piece.trigger.kind].type, ruleParams(piece.trigger)))
  const track = trackParams(piece.behavior)
  if (track !== undefined) out.push(comp(id(), TRACK, track))
  return out
}

/** Unique within one tree, preferring an id the editor already minted so existing override keys survive. */
const nodeIds = (): ((preferred: string | undefined, fallback: string) => string) => {
  const used = new Set<string>()
  return (preferred, fallback) => {
    let id = preferred ?? fallback
    if (used.has(id)) id = `${fallback}-${id}`
    while (used.has(id)) id = `${id}'`
    used.add(id)
    return id
  }
}

const pieceNode = (piece: Piece, id: string): Node => ({
  id,
  ...(piece.name !== undefined ? { name: piece.name } : {}),
  transform: piece.transform,
  components: componentsOfPiece(piece),
})

/**
 * A marker as a node.
 *
 * `spawn` becomes a `Spawn` component and behaves exactly as it did — it is the only kind anything reads.
 *
 * The other three are **dead data**: three levels carry two `checkpoint` markers each, and every consumer
 * of `LoadedLevel.markers` filters for `spawn`, so those six positions have never done anything. The mode
 * takes its checkpoints from piece colliders instead.
 *
 * They convert to the rule plus a ball collider that is **disabled**, which is the only mapping that keeps
 * all three promises: the authored position and radius survive in the file, the node is as inert as it was
 * (a disabled collider builds no body, so it is not in `nodes` and cannot be touched), and turning it into a
 * working checkpoint is one checkbox rather than an archaeology exercise. Whether they *should* be on is
 * Kodjo's call, not a migration's.
 */
const markerNode = (m: Marker, id: string): Node => ({
  id,
  transform: m.transform,
  components:
    m.kind === 'spawn'
      ? [comp('c0', SPAWN, {})]
      : [{ ...comp('c0', COLLIDER, { shape: { kind: 'ball', radius: m.radius } }), enabled: false }, comp('c1', RULE[m.kind].type, {})],
})

/** A prefab as a root node whose children are its pieces, then its local markers. */
export const prefabRoot = (key: string, prefab: Prefab): Node => {
  const id = nodeIds()
  const children: Node[] = prefab.pieces.map((p, n) => pieceNode(p, id(p.id, `p${n}`)))
  for (const [n, m] of (prefab.markers ?? []).entries()) children.push(markerNode(m, id(undefined, `m${n}`)))
  const track = trackParams(prefab.behavior)
  return {
    id: 'root',
    // The table key, not `prefab.id` — a stored id can be stale, which is exactly the bug behind 0fc0b9f.
    name: key,
    transform: IDENTITY,
    components: track === undefined ? [] : [comp('c0', TRACK, track)],
    ...(children.length > 0 ? { children } : {}),
  }
}

/** The component on a piece node that a `PieceOverride` field targets, so a patch can name it. */
const findComponent = (node: Node, pick: (c: ComponentData) => boolean): ComponentData | undefined => node.components.find(pick)

/**
 * One `PieceOverride` as a `NodeOverride`.
 *
 * The interesting cases are the two sentinels ADR 0033 needed. `material: ''` stays a value, because
 * `Renderer.material` already spells "unsurfaced" that way. `trigger: { kind: 'none' }` and
 * `behavior: { kind: 'static' }` become **structural removals**, which is the honest translation: absence
 * of a component is what "not a trigger here" means once rules are components, and it is why `removed`
 * exists in the schema from C1 rather than waiting for C3.
 */
const nodeOverride = (over: PieceOverride, target: Node): NodeOverride => {
  const params: Record<string, Record<string, unknown>> = {}
  const added: ComponentData[] = []
  const removed: string[] = []
  const addId = counter('a')

  if (over.material !== undefined) {
    const renderer = findComponent(target, (c) => c.type === RENDERER)
    if (renderer !== undefined) params[renderer.id] = { material: over.material }
    else added.push(comp(addId(), RENDERER, { material: over.material }))
  }

  if (over.trigger !== undefined) {
    const rule = findComponent(target, (c) => RULE_TYPES.has(c.type))
    const wanted = over.trigger.kind === 'none' ? undefined : RULE[over.trigger.kind].type
    if (rule !== undefined && rule.type !== wanted) removed.push(rule.id)
    if (wanted !== undefined && over.trigger.kind !== 'none') {
      if (rule?.type === wanted) params[rule.id] = ruleParams(over.trigger)
      else added.push(comp(addId(), wanted, ruleParams(over.trigger)))
    }
  }

  if (over.behavior !== undefined) {
    const track = findComponent(target, (c) => c.type === TRACK)
    const wanted = trackParams(over.behavior)
    if (wanted === undefined) {
      if (track !== undefined) removed.push(track.id)
    } else if (track !== undefined) params[track.id] = wanted
    else added.push(comp(addId(), TRACK, wanted))
  }

  return {
    ...(over.transform !== undefined ? { transform: over.transform } : {}),
    ...(over.name !== undefined ? { name: over.name } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(added.length > 0 ? { added } : {}),
    ...(removed.length > 0 ? { removed } : {}),
  }
}

/** Every `PieceOverride` on an instance, re-keyed from piece ids to the node ids they became. */
const translateOverrides = (inst: PrefabInstance, root: Node): Record<string, NodeOverride> | undefined => {
  if (inst.overrides === undefined) return undefined
  const out: Record<string, NodeOverride> = {}
  for (const [pieceId, over] of Object.entries(inst.overrides)) {
    // Node ids prefer the piece id they came from, so this is usually an identity mapping. A piece whose
    // id no longer matches a node is an override for a piece the prefab lost — inert then, inert now.
    const target = (root.children ?? []).find((c) => c.id === pieceId)
    if (target === undefined) continue
    out[pieceId] = nodeOverride(over, target)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * An instance's own layer: what it says about itself rather than about the prefab's insides.
 *
 * `behavior` and `material` were per-instance fields and become ordinary components on the placement,
 * where being `singleton` makes them beat the prefab's — which is precisely the `inst.behavior ??
 * prefab.behavior` precedence they had.
 */
const ownComponents = (inst: PrefabInstance): ComponentData[] => {
  const id = counter('o')
  const out: ComponentData[] = []
  const track = trackParams(inst.behavior)
  if (track !== undefined) out.push(comp(id(), TRACK, track))
  if (inst.material !== undefined && inst.material !== '') out.push(comp(id(), MATERIAL_OVERRIDE, { material: inst.material }))
  return out
}

/**
 * An explicit `behavior: { kind: 'static' }` on an instance meant "this placement does not move" and beat
 * the prefab's track. No component can say that, so it becomes a removal of the inherited one. No authored
 * content uses it; converting it anyway is cheaper than finding out later that something did.
 */
const staticOverride = (inst: PrefabInstance, root: Node): Record<string, NodeOverride> | undefined => {
  if (inst.behavior?.kind !== 'static') return undefined
  const track = findComponent(root, (c) => c.type === TRACK)
  return track === undefined ? undefined : { root: { removed: [track.id] } }
}

const mergeOverrides = (
  a: Record<string, NodeOverride> | undefined,
  b: Record<string, NodeOverride> | undefined,
): Record<string, NodeOverride> | undefined => {
  if (a === undefined) return b
  if (b === undefined) return a
  return { ...a, ...b }
}

/**
 * Re-id a flattened subtree under the placement that absorbed it.
 *
 * Node ids are unique per tree, and an inline definition's pieces land in the *level* tree — where two
 * one-off instances of the same shape would both have minted `p0`. Safe to rewrite at this point precisely
 * because the overrides are already baked in: there is no key left pointing at the old id.
 */
const prefixIds = (node: Node, prefix: string): Node => ({
  ...node,
  id: `${prefix}-${node.id}`,
  ...(node.children !== undefined ? { children: node.children.map((c) => prefixIds(c, prefix)) } : {}),
})

const instanceNode = (level: Level, inst: PrefabInstance, id: string, childId: (n: number) => string): Node => {
  const own = ownComponents(inst)
  const children = (inst.children ?? []).map((c, n) => instanceNode(level, c, childId(n), (k) => `${childId(n)}-${k}`))

  if (typeof inst.prefab === 'string') {
    // Converted, not the legacy `Prefab`: translating an override needs the component ids the pieces
    // became. `prefabRoot` is deterministic, so this is the same tree the prefab table holds.
    const table = level.prefabs?.[inst.prefab]
    const root = table === undefined ? undefined : prefabRoot(inst.prefab, table)
    const overrides = root === undefined ? undefined : mergeOverrides(translateOverrides(inst, root), staticOverride(inst, root))
    return {
      id,
      ...(inst.name !== undefined ? { name: inst.name } : {}),
      transform: inst.transform,
      components: own,
      prefab: inst.prefab,
      ...(overrides !== undefined ? { overrides } : {}),
      ...(children.length > 0 ? { children } : {}),
    }
  }

  /**
   * An inline definition has no shared identity, so there is nothing to override *against*: the overrides
   * are baked into the tree and disappear. `bakeOverrides` is the same code `effectiveNode` resolves a real
   * placement with, so an inline instance and a referenced one cannot drift apart.
   */
  const root = prefabRoot(inst.name ?? inst.prefab.id, inst.prefab)
  const baked = bakeOverrides(root, translateOverrides(inst, root))
  const replaced = new Set(own.filter((c) => DEFAULT_REGISTRY.get(c.type)?.singleton === true).map((c) => c.type))
  const inherited = baked.components.filter((c) => !replaced.has(c.type))
  const all = [...(baked.children ?? []).map((c) => prefixIds(c, id)), ...children]
  return {
    id,
    ...(inst.name !== undefined ? { name: inst.name } : baked.name !== undefined ? { name: baked.name } : {}),
    transform: inst.transform,
    components: [...inherited, ...own],
    ...(all.length > 0 ? { children: all } : {}),
  }
}

/**
 * A standalone prefab **file** as a root node — `content/assets/prefabs/*.prefab.json`.
 *
 * `name` is the file's name, and it becomes the root's name. Never the `id` stored inside the file, which is
 * routinely stale (commit 0fc0b9f).
 */
export const nodeFromLegacyPrefab = (name: string, prefab: Prefab): Node => prefabRoot(name, prefab)

export const nodeLevelFromLegacy = (level: Level): NodeLevel => {
  const prefabs: Record<string, Node> = {}
  for (const [key, prefab] of Object.entries(level.prefabs ?? {})) prefabs[key] = prefabRoot(key, prefab)

  const nodes: Node[] = level.instances.map((inst, n) => instanceNode(level, inst, `n${n}`, (k) => `n${n}-${k}`))
  for (const [n, m] of (level.markers ?? []).entries()) nodes.push(markerNode(m, `m${n}`))

  return {
    id: level.id,
    config: level.config,
    ...(Object.keys(prefabs).length > 0 ? { prefabs } : {}),
    nodes,
  }
}
