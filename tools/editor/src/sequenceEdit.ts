import type { Ease, Sequence, Stage, Step, Timing } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

import type { IconName } from './icons'

/**
 * Every edit the Inspector's sequence editor makes, as plain functions from stages to stages (ADR 0143).
 *
 * The editor is DOM; this is what it does to the data, kept apart so it can be tested without a browser. Every
 * function returns a **new** list and leaves no stage empty: a stage exists to hold steps, so one emptied by a
 * removal or a drag disappears on its own (the brief).
 *
 * Places are addressed by **id**, never by index, so taking a step out before putting it back cannot shift
 * where it was meant to land.
 */

// --- what a step says on its one line -----------------------------------------------------------------

/** A number as a person would write it: at most three decimals, no trailing zeros. */
export const num = (v: number): string => String(Math.round(v * 1000) / 1000 + 0)

/** A number short enough for a step's line: one decimal, and a real minus sign. The fields keep the rest. */
export const short = (v: number): string => String(Math.round(v * 10) / 10 + 0).replace('-', '\u2212')

/** A length of time for the duration column: at most two decimals. */
export const seconds = (s: number): string => `${Math.round(s * 100) / 100 + 0} s`

/** How a step is drawn closed (ADR 0147): its icon and tint, its name, and what it does, briefly. */
export interface StepFace {
  readonly icon: IconName
  /** The kind's colour: a CSS class suffix, `tint-move` and so on. */
  readonly tint: 'move' | 'turn' | 'scale' | 'fade' | 'collider' | 'enabled' | 'wait'
  readonly name: string
  /** The values, rounded, or `''`. */
  readonly detail: string
  /** The curve to draw after the duration, for the steps that have one. */
  readonly ease?: Ease
}

/** `Y`, `−X`: an axis along one of the three, by its letter; anything else as its numbers. */
const axisText = (a: Vec3): string => {
  const len = Math.hypot(a.x, a.y, a.z)
  if (len > 1e-9) {
    for (const [letter, v] of [['X', a.x], ['Y', a.y], ['Z', a.z]] as const) {
      if (Math.abs(Math.abs(v) - len) < 1e-6) return `${v < 0 ? '\u2212' : ''}${letter}`
    }
  }
  return `${short(a.x)}, ${short(a.y)}, ${short(a.z)}`
}

const speedText = (t: Timing, unit: string): string => (t.by === 'speed' || (t.by === 'stage' && t.speed !== undefined) ? ` · ${short(t.speed!)} ${unit}` : '')

export const stepFace = (step: Step): StepFace => {
  switch (step.kind) {
    case 'move':
      return { icon: 'move', tint: 'move', name: 'Move', detail: `${short(step.to.x)}, ${short(step.to.y)}, ${short(step.to.z)}${speedText(step.timing, 'm/s')}`, ease: step.ease }
    case 'turn': {
      const spin = step.timing.by === 'stage' && step.timing.speed !== undefined
      const amount = spin ? '' : ` ${short(step.angle)}°`
      return { icon: 'turn', tint: 'turn', name: spin ? 'Spin' : 'Turn', detail: `${axisText(step.axis)}${amount}${speedText(step.timing, '°/s')}`, ...(spin ? {} : { ease: step.ease }) }
    }
    case 'scale': {
      const t = step.to
      const uniform = t.x === t.y && t.y === t.z
      return { icon: 'scale', tint: 'scale', name: 'Scale', detail: uniform ? `\u00d7${short(t.x)}` : `\u00d7${short(t.x)}, ${short(t.y)}, ${short(t.z)}`, ease: step.ease }
    }
    case 'fade':
      return { icon: 'fade', tint: 'fade', name: 'Fade', detail: `to ${Math.round(step.to * 100)}%`, ease: step.ease }
    case 'collider':
      return { icon: step.on ? 'colliderOn' : 'colliderOff', tint: 'collider', name: step.on ? 'Collider on' : 'Collider off', detail: '' }
    case 'enabled':
      return { icon: step.on ? 'enable' : 'disable', tint: 'enabled', name: step.on ? 'Enable' : 'Disable', detail: '' }
    case 'wait':
      return { icon: 'wait', tint: 'wait', name: 'Wait', detail: '' }
  }
}

/** A step that happens at an instant, and so has no length to show. */
export const isInstant = (step: Step): boolean => step.kind === 'collider' || step.kind === 'enabled'

/**
 * The header's summary beside its icons (ADR 0147): repeat and offset when they are not the defaults — clock,
 * loop and axes are the icons themselves — then the length.
 */
export const sequenceSummary = (s: Sequence, passSeconds: number): string => {
  const parts: string[] = []
  if (s.times > 0) parts.push(s.times === 1 ? 'once' : `\u00d7${s.times}`)
  if (s.offset !== 0) parts.push(`+${Math.round(s.offset * 100)}%`)
  parts.push(seconds(passSeconds))
  return parts.join(' · ')
}

// --- what a new step is -----------------------------------------------------------------------------

/** What the `+` palette offers, in the brief's order, each with its icon and tint. */
export type StepChoice = 'move' | 'turn' | 'scale' | 'fade' | 'collider-on' | 'collider-off' | 'enable' | 'disable' | 'wait'

export const STEP_CHOICES: readonly { readonly choice: StepChoice; readonly label: string; readonly icon: IconName; readonly tint: StepFace['tint'] }[] = [
  { choice: 'move', label: 'Move', icon: 'move', tint: 'move' },
  { choice: 'turn', label: 'Turn', icon: 'turn', tint: 'turn' },
  { choice: 'scale', label: 'Scale', icon: 'scale', tint: 'scale' },
  { choice: 'fade', label: 'Fade', icon: 'fade', tint: 'fade' },
  { choice: 'collider-on', label: 'Collider on', icon: 'colliderOn', tint: 'collider' },
  { choice: 'collider-off', label: 'Collider off', icon: 'colliderOff', tint: 'collider' },
  { choice: 'enable', label: 'Enable', icon: 'enable', tint: 'enabled' },
  { choice: 'disable', label: 'Disable', icon: 'disable', tint: 'enabled' },
  { choice: 'wait', label: 'Wait', icon: 'wait', tint: 'wait' },
]

/** A fresh step of a kind: a second of it, going somewhere visible, linear. Edited from there. */
export const newStep = (choice: StepChoice, id: string): Step => {
  const second: Timing = { by: 'seconds', seconds: 1 }
  switch (choice) {
    case 'move':
      return { id, kind: 'move', to: vec3(0, 1, 0), timing: second, ease: 'linear' }
    case 'turn':
      return { id, kind: 'turn', axis: vec3(0, 1, 0), angle: 90, timing: second, ease: 'linear' }
    case 'scale':
      return { id, kind: 'scale', to: vec3(1.5, 1.5, 1.5), timing: second, ease: 'linear' }
    case 'fade':
      return { id, kind: 'fade', to: 0, timing: second, ease: 'linear' }
    case 'collider-on':
      return { id, kind: 'collider', on: true }
    case 'collider-off':
      return { id, kind: 'collider', on: false }
    case 'enable':
      return { id, kind: 'enabled', on: true }
    case 'disable':
      return { id, kind: 'enabled', on: false }
    case 'wait':
      return { id, kind: 'wait', seconds: 1 }
  }
}

// --- edits ---------------------------------------------------------------------------------------------

/** Where a step lands: into a stage, before one of its steps or at its end; or as a new stage of its own. */
export type StepPlace =
  | { readonly kind: 'into'; readonly stage: string; readonly before?: string }
  | { readonly kind: 'new-stage'; readonly before?: string }

/** A stage emptied by an edit has nothing left to time, so it goes. */
const tidy = (stages: readonly Stage[]): Stage[] => stages.filter((s) => s.steps.length > 0)

/** The step with this id, or `undefined`. */
export const findStep = (stages: readonly Stage[], id: string): Step | undefined => {
  for (const s of stages) for (const step of s.steps) if (step.id === id) return step
  return undefined
}

/** Take a step out, leaving any stage it empties in place until the edit is done. */
const without = (stages: readonly Stage[], id: string): { stages: Stage[]; step: Step | undefined } => {
  let step: Step | undefined
  const rest = stages.map((s) => {
    const found = s.steps.find((x) => x.id === id)
    if (found === undefined) return s
    step = found
    return { ...s, steps: s.steps.filter((x) => x.id !== id) }
  })
  return { stages: rest, step }
}

const put = (stages: readonly Stage[], step: Step, place: StepPlace, freshStage: () => string): Stage[] => {
  if (place.kind === 'into') {
    const target = stages.find((s) => s.id === place.stage)
    if (target === undefined) return put(stages, step, { kind: 'new-stage' }, freshStage)
    return stages.map((s) => {
      if (s.id !== place.stage) return s
      const at = place.before === undefined ? -1 : s.steps.findIndex((x) => x.id === place.before)
      const steps = [...s.steps]
      steps.splice(at < 0 ? steps.length : at, 0, step)
      return { ...s, steps }
    })
  }
  const fresh: Stage = { id: freshStage(), steps: [step] }
  const at = place.before === undefined ? -1 : stages.findIndex((s) => s.id === place.before)
  const out = [...stages]
  out.splice(at < 0 ? out.length : at, 0, fresh)
  return out
}

/** Add a step at a place — the `+` in a box, or `+ stage`. */
export const addStep = (stages: readonly Stage[], step: Step, place: StepPlace, freshStage: () => string): Stage[] => tidy(put(stages, step, place, freshStage))

/** Change one step in place. */
export const replaceStep = (stages: readonly Stage[], step: Step): Stage[] =>
  stages.map((s) => (s.steps.some((x) => x.id === step.id) ? { ...s, steps: s.steps.map((x) => (x.id === step.id ? step : x)) } : s))

export const removeStep = (stages: readonly Stage[], id: string): Stage[] => tidy(without(stages, id).stages)

export const removeStage = (stages: readonly Stage[], id: string): Stage[] => stages.filter((s) => s.id !== id)

/** A copy of a step, with a fresh id, right after it in its stage. */
export const duplicateStep = (stages: readonly Stage[], id: string, fresh: () => string): Stage[] =>
  stages.map((s) => {
    const at = s.steps.findIndex((x) => x.id === id)
    if (at < 0) return s
    const steps = [...s.steps]
    steps.splice(at + 1, 0, { ...s.steps[at]!, id: fresh() })
    return { ...s, steps }
  })

/** A copy of a stage and all its steps, every id fresh, right after it. */
export const duplicateStage = (stages: readonly Stage[], id: string, fresh: () => string): Stage[] => {
  const at = stages.findIndex((s) => s.id === id)
  if (at < 0) return [...stages]
  const copy: Stage = { id: fresh(), steps: stages[at]!.steps.map((x) => ({ ...x, id: fresh() })) }
  const out = [...stages]
  out.splice(at + 1, 0, copy)
  return out
}

/** A step dragged within one sequence. Dropped where it already is, nothing changes. */
export const moveStep = (stages: readonly Stage[], id: string, place: StepPlace, freshStage: () => string): Stage[] => {
  if (place.kind === 'into' && place.before === id) return [...stages]
  const { stages: rest, step } = without(stages, id)
  if (step === undefined) return [...stages]
  return tidy(put(rest, step, place, freshStage))
}

/** A stage dragged to before another stage, or to the end. */
export const moveStage = (stages: readonly Stage[], id: string, before?: string): Stage[] => {
  if (before === id) return [...stages]
  const moving = stages.find((s) => s.id === id)
  if (moving === undefined) return [...stages]
  const rest = stages.filter((s) => s.id !== id)
  const at = before === undefined ? -1 : rest.findIndex((s) => s.id === before)
  rest.splice(at < 0 ? rest.length : at, 0, moving)
  return rest
}

/**
 * A step dragged from one sequence into another on the same object: both lists change, as one edit. The step
 * keeps its id — ids are unique across a node's sequences as well as within one, so it cannot collide.
 */
export const moveStepAcross = (
  from: readonly Stage[],
  to: readonly Stage[],
  id: string,
  place: StepPlace,
  freshStage: () => string,
): { from: Stage[]; to: Stage[] } | null => {
  const { stages: rest, step } = without(from, id)
  if (step === undefined) return null
  return { from: tidy(rest), to: tidy(put(to, step, place, freshStage)) }
}

/** A whole stage dragged into another sequence on the same object. */
export const moveStageAcross = (from: readonly Stage[], to: readonly Stage[], id: string, before?: string): { from: Stage[]; to: Stage[] } | null => {
  const moving = from.find((s) => s.id === id)
  if (moving === undefined) return null
  const out = [...to]
  const at = before === undefined ? -1 : out.findIndex((s) => s.id === before)
  out.splice(at < 0 ? out.length : at, 0, moving)
  return { from: from.filter((s) => s.id !== id), to: out }
}
