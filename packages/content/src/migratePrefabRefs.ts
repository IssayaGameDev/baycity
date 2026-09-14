import { fingerprintGeometry, firstDifference } from './fingerprint'
import type { TypeInfo } from './nodes'
import type { Level, Node, NodeOverride, Transform } from './types'

/**
 * Turn a level's own prefab table into references to prefab **files** (ADR 0091), once, over existing content.
 *
 * Every entry is matched to a file, or a file is created from it, and every placement is re-pointed at that
 * file's asset id. What makes this safe is the gate: the level is fingerprinted before and after
 * (`fingerprint.ts`) and the rewrite is **thrown away** unless the two agree line for line. A level that
 * cannot be migrated identically is left exactly as it was and named in the report.
 *
 * Three hazards found in the real content, all of which the gate catches and the rules below fix:
 *
 * - **A name lies.** Two levels held an entry called `FastElevator` whose contents are the `AlternatingDanger`
 *   file. Matching by name would have re-pointed them at the wrong prefab, so content is matched first and a
 *   name match is a last resort that is reported.
 * - **Node ids differ.** The `Trampoline` entries name their pad `91521042` where the file names it `p0`, and
 *   both placements override that id. Re-pointing without remapping the override key drops the override.
 * - **An override transform masks the file's.** `bakeOverrides` replaces a node's transform wholesale, so an
 *   override carrying only a position wipes the scale the file's node has — turning a 3 × 0.3 × 3 pad into a
 *   unit cube, because the file expresses its size as scale over a unit collider and the old copy expressed it
 *   as half extents. So an override transform is completed from the file node's transform.
 */
export interface PrefabFile {
  assetId: string
  /** File name without `.prefab.json` — what a created file would be called, and what the report prints. */
  name: string
  root: Node
}

export interface RefReport {
  /** A placement re-pointed at a file. */
  linked: { level: string; key: string; assetId: string; file: string; by: 'content' | 'ids' | 'name'; placements: number; remapped: number }[]
  /** An entry no file matched: its definition has to be written as a new file at this name. */
  created: { level: string; key: string; name: string; root: Node }[]
  /** A table entry that went away because a file now holds it. */
  dropped: { level: string; key: string; why: string }[]
  /** A level left exactly as it was, and why. */
  refused: { level: string; why: string }[]
  warnings: string[]
}

export const newRefReport = (): RefReport => ({ linked: [], created: [], dropped: [], refused: [], warnings: [] })

// ---------------------------------------------------------------- matching

/** A node's shape: component types and ids and the children's, ignoring node ids and names. */
const shapeOf = (n: Node, withIds: boolean): string =>
  JSON.stringify({
    i: withIds ? n.id : 0,
    c: n.components.map((c) => [c.type, withIds ? c.id : 0, c.params ?? {}]),
    t: n.transform,
    k: (n.children ?? []).map((k) => shapeOf(k, withIds)),
  })

/** Node ids paired up position-wise between two trees of the same shape: the entry's id → the file's. */
const pairIds = (from: Node, to: Node, into: Record<string, string>): void => {
  if (from.id !== to.id) into[from.id] = to.id
  const a = from.children ?? []
  const b = to.children ?? []
  for (let i = 0; i < Math.min(a.length, b.length); i++) pairIds(a[i]!, b[i]!, into)
}

export interface Match {
  file: PrefabFile
  by: 'content' | 'ids' | 'name'
  /** Entry node id → file node id, for the override keys. Empty when the ids already agree. */
  remap: Record<string, string>
}

/**
 * The file an entry is, if any. Content first (ignoring the root's own id and name, which a table key
 * routinely disagrees with), then the same shape under different node ids, then the name — reported, because a
 * name match is the one that has been wrong in this content before.
 */
export const matchEntry = (key: string, entry: Node, files: readonly PrefabFile[]): Match | null => {
  /** The file's root wearing the entry's own id and name: a table key routinely disagrees with both. */
  const sameRoot = (f: PrefabFile): Node => {
    const { name: _fileName, ...rest } = f.root
    return { ...rest, id: entry.id, ...(entry.name !== undefined ? { name: entry.name } : {}) }
  }
  for (const f of files) if (shapeOf(sameRoot(f), true) === shapeOf(entry, true)) return { file: f, by: 'content', remap: {} }
  for (const f of files) {
    if (shapeOf(sameRoot(f), false) !== shapeOf(entry, false)) continue
    const remap: Record<string, string> = {}
    pairIds(entry, f.root, remap)
    return { file: f, by: 'ids', remap }
  }
  const named = files.find((f) => f.name === key)
  if (named !== undefined) {
    const remap: Record<string, string> = {}
    pairIds(entry, named.root, remap)
    return { file: named, by: 'name', remap }
  }
  return null
}

// ---------------------------------------------------------------- rewriting

const nodeById = (root: Node, id: string): Node | undefined => {
  if (root.id === id) return root
  for (const k of root.children ?? []) {
    const found = nodeById(k, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * An override transform completed from the node it now overrides. `bakeOverrides` replaces a transform
 * wholesale, so a field the override leaves out is a field the definition loses — and the file may express a
 * size as scale where the old copy expressed it as half extents.
 */
const completeTransform = (over: Transform, target: Transform | undefined): Transform => ({
  ...over,
  ...(over.rotation === undefined && target?.rotation !== undefined ? { rotation: target.rotation } : {}),
  ...(over.scale === undefined && target?.scale !== undefined ? { scale: target.scale } : {}),
})

/** Re-point one placement at `match`, remapping its override keys and completing their transforms. */
const repoint = (placement: Node, match: Match): number => {
  placement.prefab = match.file.assetId
  const overrides = placement.overrides
  if (overrides === undefined) return 0
  let remapped = 0
  const next: Record<string, NodeOverride> = {}
  for (const [id, over] of Object.entries(overrides)) {
    const to = match.remap[id] ?? id
    if (to !== id) remapped++
    const target = nodeById(match.file.root, to)
    next[to] = over.transform === undefined ? over : { ...over, transform: completeTransform(over.transform, target?.transform) }
  }
  placement.overrides = next
  return remapped
}

const placementsOf = (level: Level, key: string): Node[] => {
  const found: Node[] = []
  const walk = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      if (n.prefab === key) found.push(n)
      if (n.children !== undefined) walk(n.children)
    }
  }
  walk(level.nodes)
  return found
}

/**
 * Migrate one level, in place, or leave it untouched.
 *
 * `files` is every prefab asset that exists **plus** the ones this run will create — the caller writes those
 * files, so their ids have to be known here. Returns the level's fingerprint verdict: `true` when the rewrite
 * was kept.
 */
export const migrateLevelRefs = (level: Level, at: string, files: readonly PrefabFile[], types: TypeInfo, report: RefReport): boolean => {
  const table = level.prefabs
  if (table === undefined || Object.keys(table).length === 0) return true

  const before = fingerprintGeometry(level, types)
  const original = structuredClone(level)

  const linked: RefReport['linked'] = []
  const dropped: RefReport['dropped'] = []
  const unmatched: string[] = []
  const resolved: Record<string, Node> = {}

  for (const [key, entry] of Object.entries(table)) {
    const match = matchEntry(key, entry, files)
    if (match === null) {
      unmatched.push(key)
      continue
    }
    const places = placementsOf(level, key)
    let remapped = 0
    for (const p of places) remapped += repoint(p, match)
    if (places.length > 0) resolved[match.file.assetId] = match.file.root
    linked.push({ level: at, key, assetId: match.file.assetId, file: match.file.name, by: match.by, placements: places.length, remapped })
    dropped.push({ level: at, key, why: places.length === 0 ? `no placements; ${match.file.name} holds it` : `${match.file.name} holds it` })
  }

  // An entry no file matched stays put this pass: the caller writes a file for it and runs again.
  if (unmatched.length > 0) {
    for (const key of unmatched) report.created.push({ level: at, key, name: key, root: structuredClone(table[key]!) })
    Object.assign(level, original)
    return false
  }

  level.prefabs = resolved
  const after = fingerprintGeometry(level, types)
  const diff = firstDifference(before, after)
  if (diff !== null) {
    Object.assign(level, original)
    report.refused.push({ level: at, why: `line ${diff.at} changed\n      before ${diff.before ?? '(none)'}\n      after  ${diff.after ?? '(none)'}` })
    return false
  }
  // Kept. The resolution map is not part of the file; the caller strips it.
  report.linked.push(...linked)
  report.dropped.push(...dropped)
  return true
}
