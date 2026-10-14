import { isDataAsset, kindForPath, type AssetKind } from './assets'

/**
 * Assets that are data files, edited live (ADR 0159).
 *
 * Any JSON asset the editor edits is a live document on the server, the way a level is: an edit is a small op,
 * applied in the order it arrives, echoed to every editor, written to the file behind. The ops know nothing about
 * what the file means — **set a value at a path, or remove it** — so a new editable kind is a validator here and
 * a panel in the editor, not a new protocol. Materials are the first kind; a game's data file (`game.json`: its
 * components and settings) is the second, though not an asset (ADR 0162). Prefabs are live documents too, but of
 * their own: a node tree with ops of its own (ADR 0091).
 *
 * Pure, and shared: the server applies these, and the editor applies the same ones to its own copy.
 */

/** An asset op: set the value at `path`, or remove the key there. A path is object keys, from the file's root. */
export type AssetOp = { kind: 'set'; path: readonly string[]; value: unknown } | { kind: 'unset'; path: readonly string[] }

/** What a live document is: an asset of a kind with a validator, or a game's data file (ADR 0162). */
export type LiveKind = AssetKind | 'game'

/** A game's data file as a live document (ADR 0162). No asset id (16 hex digits) has a colon. */
export const gameDocId = (game: string): string => `game:${game}`

/** The game a live document's id names, or `null` for an asset's. */
export const gameOfDocId = (id: string): string | null => (id.startsWith('game:') ? id.slice('game:'.length) : null)

const isPoint = (p: unknown): boolean =>
  typeof p === 'object' && p !== null && typeof (p as { x?: unknown }).x === 'number' && typeof (p as { y?: unknown }).y === 'number'

/** A table setting's row (ADR 0222): an object of finite numbers. */
const isNumberRow = (r: unknown): boolean =>
  typeof r === 'object' && r !== null && !Array.isArray(r) && Object.values(r).every((n) => typeof n === 'number' && Number.isFinite(n))

/** The kinds edited live, each with what a file of it must look like. */
const VALIDATORS: Partial<Record<LiveKind, (json: unknown) => string | null>> = {
  material: (json) => {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'a material is an object'
    const m = json as Record<string, unknown>
    if (typeof m.shader !== 'string' || m.shader === '') return 'a material names its shader'
    if (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params)) return 'a material has its params as an object'
    for (const [key, v] of Object.entries(m.params as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null || typeof (v as { kind?: unknown }).kind !== 'string' || !('value' in v)) return `param ${key} is not a tagged value`
    }
    return null
  },
  /**
   * A data asset (ADR 0181): its shape only. Its fields are checked against its type's declaration where that is
   * known — the editor, before it sends — and the server, which has no game's code, keeps to the shape.
   */
  data: (json) => (isDataAsset(json) ? null : 'a data asset names its type and holds its fields as an object'),
  /** Its shared components (ADR 0077), and its settings: a number, curve points or a table's rows each (ADR 0087/0088, ADR 0222). */
  game: (json) => {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'a game file is an object'
    const g = json as Record<string, unknown>
    if (!Array.isArray(g.components) || !g.components.every((c) => typeof c === 'string')) return 'a game file lists its components by name'
    if (g.settings === undefined) return null
    if (typeof g.settings !== 'object' || g.settings === null || Array.isArray(g.settings)) return 'a game file has its settings as an object'
    for (const [key, v] of Object.entries(g.settings as Record<string, unknown>)) {
      const number = typeof v === 'number' && Number.isFinite(v)
      if (!number && !(Array.isArray(v) && (v.every(isPoint) || v.every(isNumberRow)))) return `setting ${key} is not a number, curve points or table rows`
    }
    return null
  },
}

/** Asset kinds that are live documents. */
export const LIVE_ASSET_KINDS: ReadonlySet<AssetKind> = new Set((Object.keys(VALIDATORS) as LiveKind[]).filter((k): k is AssetKind => k !== 'game'))

/** Whether a file at this path is one. */
export const isLiveAssetPath = (path: string): boolean => {
  const kind = kindForPath(path)
  return kind !== undefined && LIVE_ASSET_KINDS.has(kind)
}

/** Why this content is not a valid live document of this kind, or `null` when it is. */
export const validateLiveAsset = (kind: LiveKind, json: unknown): string | null => {
  const check = VALIDATORS[kind]
  return check === undefined ? 'not a live asset kind' : check(json)
}

export class LiveAssetError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Apply ops to a copy of `json`, in order. Returns the result and each op's inverse, newest last — undoing is
 * applying those in reverse. Throws `LiveAssetError` for a path through something that is not an object.
 */
export const applyAssetOps = (json: unknown, ops: readonly AssetOp[]): { json: unknown; inverses: AssetOp[] } => {
  const doc: unknown = structuredClone(json)
  const inverses: AssetOp[] = []
  for (const op of ops) {
    if (op.path.length === 0) throw new LiveAssetError('an op needs a path')
    let at: unknown = doc
    for (const key of op.path.slice(0, -1)) {
      if (!isObject(at)) throw new LiveAssetError(`${op.path.join('.')}: ${key} is not inside an object`)
      if (at[key] === undefined) {
        // Nothing there: removing needs nothing, and setting makes the object on the way.
        if (op.kind === 'unset') {
          at = undefined
          break
        }
        at[key] = {}
      } else if (!isObject(at[key])) throw new LiveAssetError(`${op.path.join('.')}: ${key} is not an object`)
      at = at[key]
    }
    const last = op.path[op.path.length - 1]!
    if (op.kind === 'unset' && !isObject(at)) {
      inverses.push({ kind: 'unset', path: op.path })
      continue
    }
    if (!isObject(at)) throw new LiveAssetError(`${op.path.join('.')}: not inside an object`)
    const had = Object.prototype.hasOwnProperty.call(at, last)
    const prior = had ? structuredClone(at[last]) : undefined
    inverses.push(had ? { kind: 'set', path: op.path, value: prior } : { kind: 'unset', path: op.path })
    if (op.kind === 'set') at[last] = structuredClone(op.value)
    else delete at[last]
  }
  return { json: doc, inverses }
}

/**
 * The ops that turn `before` into `after`: a set for each value that differs, down through objects, and an unset
 * for each key `after` dropped. An array or a value of another type is set whole. `[]` when they are equal.
 */
export const diffAssetOps = (before: unknown, after: unknown, path: readonly string[] = []): AssetOp[] => {
  if (isObject(before) && isObject(after)) {
    const ops: AssetOp[] = []
    for (const key of Object.keys(after)) {
      if (!(key in before)) ops.push({ kind: 'set', path: [...path, key], value: structuredClone(after[key]) })
      else ops.push(...diffAssetOps(before[key], after[key], [...path, key]))
    }
    for (const key of Object.keys(before)) if (!(key in after)) ops.push({ kind: 'unset', path: [...path, key] })
    return ops
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  // At the root, a whole-document replacement is every top-level key.
  if (path.length === 0) return diffAssetOps({}, isObject(after) ? after : {}, path)
  return [{ kind: 'set', path, value: structuredClone(after) }]
}

/**
 * `first` then `then`, as one list: the newest op per path, the most recently touched last. A path being replaced
 * drops the narrower edits under it, which it already covers — so the result does what applying both in order does.
 */
export const mergeAssetOps = (first: readonly AssetOp[], then: readonly AssetOp[]): AssetOp[] => {
  const byPath = new Map<string, AssetOp>(first.map((op) => [op.path.join('\u0000'), op]))
  for (const op of then) {
    const key = op.path.join('\u0000')
    for (const k of [...byPath.keys()]) if (k.startsWith(`${key}\u0000`)) byPath.delete(k)
    byPath.delete(key)
    byPath.set(key, op)
  }
  return [...byPath.values()]
}

/** Whether a value read off the wire is an asset op. Peers' data, checked. */
export const isAssetOp = (v: unknown): v is AssetOp => {
  if (!isObject(v) || !Array.isArray(v.path) || !v.path.every((k) => typeof k === 'string')) return false
  return v.kind === 'unset' || (v.kind === 'set' && 'value' in v)
}
