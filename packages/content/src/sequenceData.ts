import type { Vec3 } from '@mp/core'

import { EASES } from './eases'
import type { Sequence, Stage, Step } from './sequence'
import type { ComponentData } from './types'

/**
 * A `Sequence` as it sits in a file: checking it, reading it off a component, and what a prefab placement
 * records when its sequence differs from the prefab's (ADR 0139).
 *
 * Separate from `sequence.ts`, which is the engine and never sees JSON, and free of `nodes.ts`, which calls
 * `stagesFor` while baking a placement and would otherwise import it back.
 */

/**
 * Stages of steps, a pure function of time (ADR 0137). **Repeatable**: several on one node each loop on their
 * own. Its `stages` parameter is the one a placement's `sequences` record patches (ADR 0139).
 *
 * Declared here rather than in `nodes.ts` beside the other type names, because `nodes.ts` imports this module
 * to bake a placement; it re-exports it from there.
 */
export const SEQUENCE = 'Sequence'

// --- checking ---------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isVec3 = (v: unknown): v is Vec3 => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.z)
const isId = (v: unknown): v is string => typeof v === 'string' && v !== ''
const EASE_SET: ReadonlySet<string> = new Set(EASES)
const STEP_KINDS: ReadonlySet<string> = new Set(['move', 'turn', 'scale', 'fade', 'collider', 'enabled', 'wait'])

const timingProblem = (v: unknown, at: string): string | null => {
  if (!isObj(v)) return `${at}: expected a timing`
  switch (v.by) {
    case 'seconds':
      return isNum(v.seconds) && v.seconds >= 0 ? null : `${at}.seconds: expected a number of seconds, 0 or more`
    case 'speed':
      return isNum(v.speed) ? null : `${at}.speed: expected a number`
    case 'stage':
      return v.speed === undefined || isNum(v.speed) ? null : `${at}.speed: expected a number`
    default:
      return `${at}.by: expected 'seconds' | 'speed' | 'stage'`
  }
}

/** The first thing wrong with one step, or `null`. Messages carry the JSON path, like `validate.ts`'s. */
export const stepProblem = (v: unknown, at: string): string | null => {
  if (!isObj(v)) return `${at}: expected a step`
  if (!isId(v.id)) return `${at}.id: expected a non-empty string`
  if (v.target !== undefined && typeof v.target !== 'string') return `${at}.target: expected a child's node id`
  if (typeof v.kind !== 'string' || !STEP_KINDS.has(v.kind)) return `${at}.kind: expected one of ${[...STEP_KINDS].join(' | ')}`
  const eased = (): string | null =>
    timingProblem(v.timing, `${at}.timing`) ??
    (typeof v.ease === 'string' && EASE_SET.has(v.ease) ? null : `${at}.ease: expected one of the easing names`)
  switch (v.kind) {
    case 'move':
    case 'scale':
      return isVec3(v.to) ? eased() : `${at}.to: expected a Vec3`
    case 'turn':
      if (!isVec3(v.axis)) return `${at}.axis: expected a Vec3`
      return isNum(v.angle) ? eased() : `${at}.angle: expected a number of degrees`
    case 'fade':
      return isNum(v.to) ? eased() : `${at}.to: expected a number`
    case 'collider':
    case 'enabled':
      return typeof v.on === 'boolean' ? null : `${at}.on: expected true or false`
    default:
      return isNum(v.seconds) && v.seconds >= 0 ? null : `${at}.seconds: expected a number of seconds, 0 or more`
  }
}

/**
 * The first thing wrong with a list of stages, or `null`.
 *
 * Ids are unique across stages **and** steps: a placement's record names both, in one layout, and an id that
 * meant two things there would move the wrong one.
 */
export const stagesProblem = (v: unknown, at = 'stages'): string | null => {
  if (!Array.isArray(v)) return `${at}: expected a list of stages`
  const ids = new Set<string>()
  const fresh = (id: string, where: string): string | null => {
    if (ids.has(id)) return `${where}: '${id}' is used twice in this sequence`
    ids.add(id)
    return null
  }
  for (const [n, s] of v.entries()) {
    const sAt = `${at}[${n}]`
    if (!isObj(s)) return `${sAt}: expected a stage`
    if (!isId(s.id)) return `${sAt}.id: expected a non-empty string`
    const dup = fresh(s.id, `${sAt}.id`)
    if (dup !== null) return dup
    if (!Array.isArray(s.steps)) return `${sAt}.steps: expected a list of steps`
    for (const [k, step] of s.steps.entries()) {
      const bad = stepProblem(step, `${sAt}.steps[${k}]`) ?? fresh((step as { id: string }).id, `${sAt}.steps[${k}].id`)
      if (bad !== null) return bad
    }
  }
  return null
}

const isStep = (v: unknown): v is Step => stepProblem(v, 'step') === null

// --- reading ----------------------------------------------------------------------------------------

/** A component's `stages`, or none if they do not check out — a hand-edited file stays loadable. */
export const readStages = (v: unknown): readonly Stage[] => (stagesProblem(v) === null ? (v as Stage[]) : [])

const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback

/**
 * A `Sequence` component's data, read defensively the way the loader reads every other component: an absent
 * or broken field takes its default rather than throwing from inside the frame tree.
 */
export const sequenceOf = (c: ComponentData): Sequence => {
  const p = c.params
  return {
    name: typeof p.name === 'string' ? p.name : '',
    clock: pick(p.clock, ['shared', 'local'], 'shared'),
    axes: pick(p.axes, ['object', 'level'], 'object'),
    loop: pick(p.loop, ['restart', 'yoyo'], 'restart'),
    times: isNum(p.times) ? Math.max(0, Math.floor(p.times)) : 0,
    offset: isNum(p.offset) ? p.offset : 0,
    stages: readStages(p.stages),
  }
}

// --- following a re-id -----------------------------------------------------------------------------

/**
 * A step's `target` names a child by id, so it is a node reference like a `nodeRef` parameter, and has to
 * follow its child when a copied subtree's ids are re-minted — or a duplicated door's sequence would still be
 * opening the original's halves. `rename` answers the new id, or `undefined` to leave one alone.
 */
const renamedStep = (s: Step, rename: (id: string) => string | undefined): Step => {
  if (s.target === undefined) return s
  const to = rename(s.target)
  return to === undefined ? s : { ...s, target: to }
}

export const retargetStages = (stages: readonly Stage[], rename: (id: string) => string | undefined): readonly Stage[] =>
  stages.map((st) => ({ ...st, steps: st.steps.map((s) => renamedStep(s, rename)) }))

/** A component's stages, repointed in place — for the code that re-mints a copied subtree's ids. */
export const retargetSequenceParams = (c: ComponentData, rename: (id: string) => string | undefined): void => {
  // Stages that do not check out are left exactly as they are: repointing is no reason to lose them.
  if (c.type !== SEQUENCE || stagesProblem(c.params.stages) !== null) return
  c.params.stages = retargetStages(c.params.stages as Stage[], rename)
}

// --- what a placement records ----------------------------------------------------------------------

/**
 * One step's changed fields, sparse, as a placement records them. A `target` of `''` means "the object
 * itself", which is how a patch says the prefab's target was taken away. A different `kind` makes the patch
 * the whole step.
 */
export type StepPatch = Readonly<Record<string, unknown>>

/**
 * How one placement's sequence differs from its prefab's (ADR 0139) — ADR 0135's model for pieces, applied
 * to stages and steps, so a placement keeps up with its prefab everywhere it has not said otherwise.
 *
 * `layout` is a **preference**, like `childOrder`: ids it names that are gone are skipped, and anything it
 * does not mention keeps its place at the end — so a prefab that gains a step does not invalidate an order a
 * placement recorded before it existed.
 */
export interface SequenceOverride {
  /** Step id → the fields that differ. */
  readonly steps?: Readonly<Record<string, StepPatch>>
  readonly removedSteps?: readonly string[]
  readonly removedStages?: readonly string[]
  /** Steps this placement adds. Where they sit is `layout`'s business; unmentioned, they go last. */
  readonly addedSteps?: readonly Step[]
  /** Stage ids this placement adds; their steps are `addedSteps` or moved inherited ones. */
  readonly addedStages?: readonly string[]
  /** The order of stages, and of the steps in each, when it differs from what the rest would give. */
  readonly layout?: readonly { readonly stage: string; readonly steps: readonly string[] }[]
}

const isIdList = (v: unknown): boolean => Array.isArray(v) && v.every(isId)

/** The first thing wrong with a placement's sequence record, or `null`. Shape only: it is read against a prefab that may have changed. */
export const sequenceOverrideProblem = (v: unknown, at: string): string | null => {
  if (!isObj(v)) return `${at}: expected an object`
  if (v.steps !== undefined) {
    if (!isObj(v.steps)) return `${at}.steps: expected an object keyed by step id`
    for (const [id, patch] of Object.entries(v.steps)) if (!isObj(patch)) return `${at}.steps['${id}']: expected an object`
  }
  for (const k of ['removedSteps', 'removedStages', 'addedStages'] as const)
    if (v[k] !== undefined && !isIdList(v[k])) return `${at}.${k}: expected a list of ids`
  if (v.addedSteps !== undefined) {
    if (!Array.isArray(v.addedSteps)) return `${at}.addedSteps: expected a list of steps`
    for (const [n, s] of v.addedSteps.entries()) {
      const bad = stepProblem(s, `${at}.addedSteps[${n}]`)
      if (bad !== null) return bad
    }
  }
  if (v.layout !== undefined) {
    if (!Array.isArray(v.layout)) return `${at}.layout: expected a list of stages`
    for (const [n, l] of v.layout.entries()) {
      if (!isObj(l) || !isId(l.stage) || !isIdList(l.steps)) return `${at}.layout[${n}]: expected { stage, steps }`
    }
  }
  return null
}

/** A step with a placement's patch on it. A patch that would make it invalid is ignored rather than breaking the level. */
const patched = (step: Step, patch: StepPatch | undefined): Step => {
  if (patch === undefined) return step
  const whole = patch.kind !== undefined && patch.kind !== step.kind
  const merged: Record<string, unknown> = whole ? { ...patch, id: step.id } : { ...step, ...patch }
  if (merged.target === '') delete merged.target
  return isStep(merged) ? merged : step
}

/**
 * The stages a placement shows: the prefab's, with this placement's differences applied (ADR 0139).
 *
 * Inherited steps it does not place go to the end of their own stage, in the prefab's order; a step whose
 * stage was removed goes with it unless the layout moved it somewhere else. Added steps it does not place go
 * to the end of the last stage.
 */
export const stagesFor = (base: readonly Stage[], o: SequenceOverride | undefined): readonly Stage[] => {
  if (o === undefined) return base
  const removedStages = new Set(o.removedStages ?? [])
  const removedSteps = new Set(o.removedSteps ?? [])
  const stageIds: string[] = []
  const home = new Map<string, string>()
  const byId = new Map<string, Step>()
  for (const s of base) {
    if (!removedStages.has(s.id)) stageIds.push(s.id)
    for (const step of s.steps) {
      if (removedSteps.has(step.id)) continue
      byId.set(step.id, patched(step, o.steps?.[step.id]))
      home.set(step.id, s.id)
    }
  }
  for (const id of o.addedStages ?? []) if (!stageIds.includes(id)) stageIds.push(id)
  const added = (o.addedSteps ?? []).filter((s) => !byId.has(s.id))
  for (const s of added) byId.set(s.id, s)

  const contents = new Map<string, Step[]>(stageIds.map((id) => [id, []]))
  const order: string[] = []
  const placed = new Set<string>()
  const put = (stage: string, id: string): void => {
    const step = byId.get(id)
    if (step === undefined || placed.has(id)) return
    contents.get(stage)!.push(step)
    placed.add(id)
  }
  for (const l of o.layout ?? []) {
    if (!contents.has(l.stage) || order.includes(l.stage)) continue
    order.push(l.stage)
    for (const id of l.steps) put(l.stage, id)
  }
  for (const id of stageIds) if (!order.includes(id)) order.push(id)
  for (const s of base) for (const step of s.steps) if (contents.has(home.get(step.id) ?? '')) put(home.get(step.id)!, step.id)
  const last = order[order.length - 1]
  if (last !== undefined) for (const s of added) put(last, s.id)
  return order.map((id) => ({ id, steps: contents.get(id)! }))
}

const json = (v: unknown): string => JSON.stringify(v)

/** The fields of `want` that differ from `was`, or `undefined` when none do. */
const stepPatch = (was: Step, want: Step): StepPatch | undefined => {
  if (was.kind !== want.kind) return { ...want }
  const a = was as unknown as Record<string, unknown>
  const b = want as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'id' || json(a[k]) === json(b[k])) continue
    out[k] = b[k] ?? (k === 'target' ? '' : null)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** A placement's record, with every target in it repointed. See `retargetStages`. */
export const retargetSequenceOverride = (o: SequenceOverride, rename: (id: string) => string | undefined): SequenceOverride => {
  const patch = (p: StepPatch): StepPatch => {
    const t = p.target
    if (typeof t !== 'string' || t === '') return p
    const to = rename(t)
    return to === undefined ? p : { ...p, target: to }
  }
  return {
    ...o,
    ...(o.steps === undefined ? {} : { steps: Object.fromEntries(Object.entries(o.steps).map(([id, p]) => [id, patch(p)])) }),
    ...(o.addedSteps === undefined ? {} : { addedSteps: o.addedSteps.map((s) => renamedStep(s, rename)) }),
  }
}

const layoutOf = (stages: readonly Stage[]): string => json(stages.map((s) => [s.id, s.steps.map((x) => x.id)]))

/**
 * The record that turns `base` into `want` — the inverse of `stagesFor`, so that
 * `stagesFor(base, diffStages(base, want))` is `want`. `undefined` when they are the same.
 *
 * The editor only ever knows the sequence a person is looking at; this is what lets every edit to a
 * placement's sequence, structural or not, be one op carrying the whole difference.
 */
export const diffStages = (base: readonly Stage[], want: readonly Stage[]): SequenceOverride | undefined => {
  const wasSteps = new Map<string, Step>()
  for (const s of base) for (const step of s.steps) wasSteps.set(step.id, step)
  const wantSteps = new Map<string, Step>()
  for (const s of want) for (const step of s.steps) wantSteps.set(step.id, step)

  const steps: Record<string, StepPatch> = {}
  const removedSteps: string[] = []
  for (const [id, was] of wasSteps) {
    const now = wantSteps.get(id)
    if (now === undefined) removedSteps.push(id)
    else {
      const p = stepPatch(was, now)
      if (p !== undefined) steps[id] = p
    }
  }
  const addedSteps = [...wantSteps.values()].filter((s) => !wasSteps.has(s.id))
  const baseStages = new Set(base.map((s) => s.id))
  const wantStages = new Set(want.map((s) => s.id))
  const removedStages = base.filter((s) => !wantStages.has(s.id)).map((s) => s.id)
  const addedStages = want.filter((s) => !baseStages.has(s.id)).map((s) => s.id)

  const record: {
    steps?: Record<string, StepPatch>
    removedSteps?: string[]
    removedStages?: string[]
    addedSteps?: Step[]
    addedStages?: string[]
    layout?: { stage: string; steps: string[] }[]
  } = {}
  if (Object.keys(steps).length > 0) record.steps = steps
  if (removedSteps.length > 0) record.removedSteps = removedSteps
  if (removedStages.length > 0) record.removedStages = removedStages
  if (addedSteps.length > 0) record.addedSteps = addedSteps
  if (addedStages.length > 0) record.addedStages = addedStages
  // Only when the rest would put something somewhere else: a record that changes values alone stays small,
  // and keeps following the prefab's order.
  if (layoutOf(stagesFor(base, record)) !== layoutOf(want)) record.layout = want.map((s) => ({ stage: s.id, steps: s.steps.map((x) => x.id) }))
  return Object.keys(record).length === 0 ? undefined : record
}
