import { EASES, type Ease, type Sequence, type Stage, type Step, type Timing } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

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

/** `in-out-sine` → `sine in-out`, which is how the brief writes it and how it reads on a line. */
export const easeLabel = (e: Ease): string => {
  if (e === 'linear') return 'linear'
  const at = e.lastIndexOf('-')
  return `${e.slice(at + 1)} ${e.slice(0, at)}`
}

/** The ease names, in picker order, with their labels. */
export const EASE_OPTIONS: readonly { readonly value: Ease; readonly label: string }[] = EASES.map((e) => ({ value: e, label: easeLabel(e) }))

/** A number as a person would write it: at most three decimals, no trailing zeros. */
export const num = (v: number): string => String(Math.round(v * 1000) / 1000)
const vec = (v: Vec3): string => `(${num(v.x)}, ${num(v.y)}, ${num(v.z)})`

const timingText = (t: Timing, unit: string): string => {
  switch (t.by) {
    case 'seconds':
      return `${num(t.seconds)} s`
    case 'speed':
      return `${num(t.speed)} ${unit}`
    case 'stage':
      return t.speed === undefined ? 'stage' : `${num(t.speed)}${unit}  stage`
  }
}

/**
 * The line a closed step shows (the brief's table). `target` is the child's name when the step is aimed at one,
 * and it goes after an arrow: `move → LeftHalf  (-1, 0, 0)   1 s`.
 */
export const stepLine = (step: Step, target?: string): string => {
  const head = (verb: string): string => (target === undefined ? verb : `${verb} → ${target}`)
  switch (step.kind) {
    case 'move':
      return `${head('move')}  ${vec(step.to)}   ${timingText(step.timing, 'm/s')}   ${easeLabel(step.ease)}`
    case 'turn': {
      const spin = step.timing.by === 'stage' && step.timing.speed !== undefined
      const amount = spin ? '' : `${num(step.angle)}°   `
      return `${head('turn')}  ${vec(step.axis)}  ${amount}${timingText(step.timing, '°/s')}${spin ? '' : `   ${easeLabel(step.ease)}`}`
    }
    case 'scale':
      return `${head('scale')}  ×${vec(step.to)}   ${timingText(step.timing, '')}   ${easeLabel(step.ease)}`
    case 'fade':
      return `${head('fade')}  to ${num(step.to)}   ${timingText(step.timing, '')}   ${easeLabel(step.ease)}`
    case 'collider':
      return `${head('collider')} ${step.on ? 'on' : 'off'}`
    case 'enabled':
      return head(step.on ? 'enable' : 'disable')
    case 'wait':
      return `${head('wait')}   ${num(step.seconds)} s`
  }
}

/**
 * The header's summary: **only what differs from the defaults**, then the length (the brief). A local clock
 * always shows, since a sequence other screens do not see the same way must never pass unnoticed.
 */
export const sequenceSummary = (s: Sequence, passSeconds: number): string => {
  const parts: string[] = []
  if (s.clock === 'local') parts.push('local')
  if (s.axes === 'level') parts.push('level axes')
  if (s.loop === 'yoyo') parts.push('yo-yo')
  if (s.times > 0) parts.push(s.times === 1 ? 'once' : `${s.times} times`)
  if (s.offset !== 0) parts.push(`offset ${num(s.offset)}`)
  parts.push(`${num(passSeconds)} s`)
  return parts.join(' · ')
}

// --- what a new step is -----------------------------------------------------------------------------

/** What the `+` menu offers, in the brief's order. */
export type StepChoice = 'move' | 'turn' | 'scale' | 'fade' | 'collider-on' | 'collider-off' | 'enable' | 'disable' | 'wait'

export const STEP_CHOICES: readonly { readonly choice: StepChoice; readonly label: string }[] = [
  { choice: 'move', label: 'move' },
  { choice: 'turn', label: 'turn' },
  { choice: 'scale', label: 'scale' },
  { choice: 'fade', label: 'fade' },
  { choice: 'collider-on', label: 'collider on' },
  { choice: 'collider-off', label: 'collider off' },
  { choice: 'enable', label: 'enable' },
  { choice: 'disable', label: 'disable' },
  { choice: 'wait', label: 'wait' },
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
