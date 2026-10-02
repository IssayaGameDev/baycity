import { applyAssetOps, applyBatch, childListsOf, invertOp, LiveAssetError, OpError, type AssetOp, type Level, type Node, type Op } from '@mp/content'

import type { OpBatch } from './editorDoc'

/**
 * Undo, around what others changed since (ADR 0194): every Ctrl+Z — a click's edit, a material's, an agent's whole
 * turn — takes back what it did **except what someone has changed since, which stays theirs** (Kodjo's call).
 *
 * The rule is a value check made when undoing, not a record of who touched what: a step is taken back only while
 * what it wrote is still there. Bob recoloured the box after you did: the colour is Bob's and stays, while the size
 * you set, untouched since, goes back. Checked rather than tracked, so the order things are undone in cannot fool
 * it — a later edit undone first puts the earlier one's value back, and the earlier one's undo then takes it.
 *
 * Parameters are checked key by key, so one patch of three fields can be two-thirds undone. Everything else is
 * whole: a node made goes only if nobody has changed it since.
 *
 * A step is either taken back or given up: given up, it is the other person's from then on, and a redo leaves it.
 */

/** One op an edit made in a level or prefab, and what undoes it. */
export interface LevelStep {
  readonly kind: 'level'
  readonly op: Op
  readonly inverse: Op
  /** What of `op` is in effect: all of it, some keys of a patch after a redo, or nothing once undone or given up. */
  live: Op | null
  /** What the last undo wrote, for a redo to check is still there; `null` when that undo gave the step up. */
  back: Op | null
}

/**
 * One op an edit made in a material or a data asset (ADR 0159), and what undoes it, in undo order: usually one op at
 * the same path; more when a gesture set a whole object after a field inside it, whose old value goes back too.
 */
export interface AssetStep {
  readonly kind: 'asset'
  readonly assetId: string
  readonly op: AssetOp
  readonly inverses: readonly AssetOp[]
  live: boolean
  back: boolean
}

export type UndoStep = LevelStep | AssetStep

/** The steps of these batches, in the order they were made. A batch's inverses come in undo order: the last op's first. */
export const levelSteps = (batches: readonly OpBatch[]): LevelStep[] =>
  batches.flatMap((b) => b.ops.map((op, k): LevelStep => ({ kind: 'level', op, inverse: b.inverses[b.ops.length - 1 - k]!, live: op, back: null })))

const under = (path: readonly string[], prefix: readonly string[]): boolean => prefix.length <= path.length && prefix.every((k, i) => path[i] === k)

/**
 * The steps of one asset edit, `inverses` in undo order as `recordAsset` keeps them: each inverse goes with the op at
 * its path — an edit's ops have one path each, and a gesture's merged ones too (`mergeAssetOps`) — or else with the op
 * whose path holds it.
 */
export const assetSteps = (assetId: string, ops: readonly AssetOp[], inverses: readonly AssetOp[]): AssetStep[] => {
  const groups = ops.map((): AssetOp[] => [])
  for (const inv of inverses) {
    const exact = ops.findIndex((op) => op.path.length === inv.path.length && under(inv.path, op.path))
    const holder = exact >= 0 ? exact : ops.findIndex((op) => under(inv.path, op.path))
    groups[holder >= 0 ? holder : ops.length - 1]?.push(inv)
  }
  return ops.map((op, k): AssetStep => ({ kind: 'asset', assetId, op, inverses: groups[k]!, live: true, back: false }))
}

const transformKey = (op: Op): string | null =>
  op.kind === 'setTransform' ? `t:${op.table ?? ''}:${op.id}` : op.kind === 'setOverrideTransform' ? `o:${op.owner}:${op.node}` : null

/**
 * One step per object for a run of transforms — a drag's hundred: its last value, and what it was before the first.
 * Only across transforms, which touch nothing but their own object; any other op ends the run.
 */
export const squashTransforms = (steps: readonly LevelStep[]): LevelStep[] => {
  const out: LevelStep[] = []
  let run = new Map<string, number>()
  for (const s of steps) {
    const key = transformKey(s.op)
    if (key === null) {
      run = new Map()
      out.push(s)
      continue
    }
    const at = run.get(key)
    if (at === undefined) {
      run.set(key, out.length)
      out.push(s)
    } else out[at] = { kind: 'level', op: s.op, inverse: out[at]!.inverse, live: s.op, back: null }
  }
  return out
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

type PatchOp = Extract<Op, { kind: 'setParams' | 'setOverrideParams' }>
const isPatch = (op: Op): op is PatchOp => op.kind === 'setParams' || op.kind === 'setOverrideParams'
const keysOf = (op: PatchOp): string[] => [...Object.keys(op.patch), ...(op.unset ?? [])]
/** The part of a patch on these keys. */
const only = (op: PatchOp, keys: ReadonlySet<string>): PatchOp => ({
  ...op,
  patch: Object.fromEntries(Object.entries(op.patch).filter(([k]) => keys.has(k))),
  unset: (op.unset ?? []).filter((k) => keys.has(k)),
})

/** Whether `op` would change nothing now: what it writes is what is there. `false` when it cannot apply at all. */
const quiet = (level: Level, op: Op): boolean => {
  try {
    return invertOp(level, op) === null
  } catch (e) {
    if (e instanceof OpError) return false
    throw e
  }
}

/** A node by id, wherever it hangs — children, or what a placement added under a piece — and its parent's id. */
const findNode = (level: Level, table: string | undefined, id: string): { node: Node; parent: string | null } | null => {
  const root = table === undefined ? undefined : level.prefabs?.[table]
  const roots = table === undefined ? level.nodes : root === undefined ? [] : [root]
  const walk = (list: readonly Node[], parent: string | null): { node: Node; parent: string | null } | null => {
    for (const n of list) {
      if (n.id === id) return { node: n, parent }
      for (const kids of childListsOf(n)) {
        const found = walk(kids, n.id)
        if (found !== null) return found
      }
    }
    return null
  }
  return walk(roots, null)
}

/** Whether the level still shows what `op` did — nobody has changed it since. A patch is asked per key, elsewhere. */
const stillThere = (level: Level, op: Op): boolean => {
  const t = op.table
  switch (op.kind) {
    case 'insertNode': {
      const f = findNode(level, t, op.node.id)
      return f !== null && same(f.node, op.node)
    }
    case 'insertOverrideChild': {
      const f = findNode(level, t, op.child.id)
      return f !== null && same(f.node, op.child)
    }
    case 'removeNode':
      return findNode(level, t, op.id) === null
    case 'moveNode': {
      // Its place among siblings shifts whenever anyone adds a sibling; its parent is what the move chose.
      const f = findNode(level, t, op.id)
      return f !== null && f.parent === op.parent
    }
    case 'addComponent': {
      const c = findNode(level, t, op.id)?.node.components.find((x) => x.id === op.component.id)
      return c !== undefined && same(c, op.component)
    }
    case 'removeComponent':
      return findNode(level, t, op.id)?.node.components.some((x) => x.id === op.componentId) !== true
    case 'moveComponent': {
      const list = findNode(level, t, op.id)?.node.components
      if (list === undefined) return false
      const at = list.findIndex((x) => x.id === op.componentId)
      return at >= 0 && at === Math.max(0, Math.min(list.length - 1, op.to))
    }
    case 'addOverrideComponent': {
      const c = findNode(level, undefined, op.owner)?.node.overrides?.[op.node]?.added?.find((x) => x.id === op.component.id)
      return c !== undefined && same(c, op.component)
    }
    case 'removeOverrideComponent':
      return findNode(level, undefined, op.owner)?.node.overrides?.[op.node]?.added?.some((x) => x.id === op.componentId) !== true
    case 'internPrefab':
      return same(level.prefabs?.[op.key], op.root)
    case 'dropPrefab':
      return level.prefabs?.[op.key] === undefined
    default:
      // Every other op sets something: it is still there when setting it again would change nothing.
      return quiet(level, op)
  }
}

/**
 * Which of `wrote` is still there, and what to apply for that part: `write` restricted to it. `null` when none
 * of it is. Whole for anything but a patch.
 */
const partStillThere = (level: Level, wrote: Op, write: Op): { apply: Op; whole: boolean } | null => {
  if (!isPatch(wrote) || !isPatch(write)) return stillThere(level, wrote) ? { apply: write, whole: true } : null
  const all = keysOf(wrote)
  const keys = new Set(all.filter((k) => quiet(level, only(wrote, new Set([k])))))
  if (keys.size === 0) return null
  return { apply: keys.size === all.length ? write : only(write, keys), whole: keys.size === all.length }
}

/** Apply one op to a trial copy: `false`, leaving the copy as it was, when it no longer applies. */
const tryApply = (trial: Level, op: Op): boolean => {
  try {
    applyBatch(trial, [op])
    return true
  } catch (e) {
    if (e instanceof OpError) return false
    throw e
  }
}

/** The value at a path in an asset's JSON, or `undefined`. */
const valueAt = (json: unknown, path: readonly string[]): unknown => {
  let at: unknown = json
  for (const key of path) {
    if (typeof at !== 'object' || at === null || Array.isArray(at)) return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}
const assetStillThere = (json: unknown, op: AssetOp): boolean => (op.kind === 'set' ? same(valueAt(json, op.path), op.value) : valueAt(json, op.path) === undefined)

/** What an undo or a redo will do, worked out on copies: apply it, then `done` to mark the steps. */
export interface TurnPlan {
  /** The level's ops, in order — already applied once, to a copy. */
  readonly level: Op[]
  /** Each asset's ops, in order. */
  readonly assets: ReadonlyMap<string, AssetOp[]>
  /** Steps, or parts of a patch, left alone because someone changed them since. */
  readonly kept: number
  /** Mark the steps as undone (or redone). Only once the ops above have been applied for real. */
  readonly done: () => void
}

/**
 * Work out an undo of an entry's steps against the level and assets as they are now: last step first, each taken
 * back only while what it wrote is still there.
 */
export const planUndo = (steps: readonly UndoStep[], level: Level, assetNow: (assetId: string) => unknown): TurnPlan =>
  plan([...steps].reverse(), level, assetNow, 'undo')

/**
 * Work out a redo: first step first, each step the last undo took back put again — only while what that undo
 * wrote is still there, so a change made since the undo stays too.
 */
export const planRedo = (steps: readonly UndoStep[], level: Level, assetNow: (assetId: string) => unknown): TurnPlan =>
  plan(steps, level, assetNow, 'redo')

const plan = (ordered: readonly UndoStep[], level: Level, assetNow: (assetId: string) => unknown, way: 'undo' | 'redo'): TurnPlan => {
  const trial = structuredClone(level)
  const assetTrials = new Map<string, unknown>()
  const levelOps: Op[] = []
  const assets = new Map<string, AssetOp[]>()
  const marks: (() => void)[] = []
  let kept = 0

  for (const s of ordered) {
    if (s.kind === 'level') {
      // An undo checks that what the turn wrote is there and writes the inverse; a redo checks what the undo wrote
      // and writes the op. For a patch, only the keys still in play.
      const wrote = way === 'undo' ? s.live : s.back
      if (wrote === null) continue
      const full = way === 'undo' ? s.inverse : s.op
      const write = isPatch(full) && isPatch(wrote) ? only(full, new Set(keysOf(wrote))) : full
      const part = partStillThere(trial, wrote, write)
      if (part === null || !tryApply(trial, part.apply)) {
        kept++
        marks.push(() => {
          s.live = null
          s.back = null
        })
        continue
      }
      if (!part.whole) kept++
      levelOps.push(part.apply)
      marks.push(() => {
        if (way === 'undo') {
          s.live = null
          s.back = part.apply
        } else {
          s.live = part.apply
          s.back = null
        }
      })
      continue
    }
    if (way === 'undo' ? !s.live : !s.back) continue
    const json = assetTrials.has(s.assetId) ? assetTrials.get(s.assetId) : structuredClone(assetNow(s.assetId))
    // An undo checks the op is still there and writes its inverses; a redo checks every inverse and writes the op.
    const wrote = way === 'undo' ? [s.op] : s.inverses
    const apply = way === 'undo' ? s.inverses : [s.op]
    let next: unknown
    try {
      next = json === undefined || !wrote.every((w) => assetStillThere(json, w)) ? undefined : applyAssetOps(json, apply).json
    } catch (e) {
      if (!(e instanceof LiveAssetError)) throw e
      next = undefined
    }
    if (next === undefined) {
      kept++
      marks.push(() => {
        s.live = false
        s.back = false
      })
      continue
    }
    assetTrials.set(s.assetId, next)
    assets.set(s.assetId, [...(assets.get(s.assetId) ?? []), ...apply])
    marks.push(() => {
      s.live = way === 'redo'
      s.back = way === 'undo'
    })
  }
  return { level: levelOps, assets, kept, done: () => marks.forEach((m) => m()) }
}
