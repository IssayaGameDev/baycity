import { EASES, SEQUENCE, stagesProblem, type Stage, type Step } from '@mp/content'

import { ActionError, defineAction } from './actions'
import { object, str, type JsonSchema, type Schema } from './schema'
import { viewOf } from './views'

/**
 * A Sequence's steps (ADR 0198, ADR 0137): what an object does over time — the only motion a level has — written
 * whole, the way the Inspector's sequence editor writes them: `Doc.setSequenceStages`, so a placement's copy of a
 * prefab's sequence becomes an override, not an edit of the prefab. Stages play one after another; the steps in a
 * stage play together.
 *
 * Steps are given as they are stored, with two kindnesses: an id left out is minted (keep one to keep the step the
 * same step), and a step's `target` is a direct child's object id, as every action takes objects, turned into the id
 * the step stores. Then the whole is checked by the content's own `stagesProblem`, as a level is when it loads.
 */

const vec3Json: JsonSchema = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }
const timingJson: JsonSchema = {
  description: 'How long: by seconds; by speed (metres a second for a move, degrees a second for a turn, the average); or as long as its stage',
  oneOf: [
    { type: 'object', properties: { by: { const: 'seconds' }, seconds: { type: 'number', minimum: 0 } }, required: ['by', 'seconds'] },
    { type: 'object', properties: { by: { const: 'speed' }, speed: { type: 'number' } }, required: ['by', 'speed'] },
    { type: 'object', properties: { by: { const: 'stage' }, speed: { type: 'number', description: 'a turn only: spin at this rate for the stage' } }, required: ['by'] },
  ],
}
const easeJson: JsonSchema = { type: 'string', enum: [...EASES] }
const common = {
  id: { type: 'string', description: 'keep a step’s id to keep it the same step; leave it out for a new one' },
  target: { type: 'string', description: 'a direct child’s object id; left out, the object the sequence is on' },
}
const stepJson = (kind: string, fields: Record<string, JsonSchema>, required: string[], description: string): JsonSchema => ({
  type: 'object',
  description,
  properties: { kind: { const: kind }, ...common, ...fields },
  required: ['kind', ...required],
})
const STEPS_JSON: JsonSchema = {
  oneOf: [
    stepJson('move', { to: vec3Json, timing: timingJson, ease: easeJson }, ['to', 'timing', 'ease'], 'Move to a point, in metres from where the object was placed'),
    stepJson('turn', { axis: vec3Json, angle: { type: 'number', description: 'degrees, turned by' }, timing: timingJson, ease: easeJson }, ['axis', 'angle', 'timing', 'ease'], 'Turn by an angle about an axis'),
    stepJson('scale', { to: vec3Json, timing: timingJson, ease: easeJson }, ['to', 'timing', 'ease'], 'Scale to a factor of the scale it was placed at'),
    stepJson('fade', { to: { type: 'number', description: 'a factor of its material’s opacity, 0 to 1' }, timing: timingJson, ease: easeJson }, ['to', 'timing', 'ease'], 'Fade to an opacity'),
    stepJson('collider', { on: { type: 'boolean' } }, ['on'], 'Switch its collider on or off'),
    stepJson('enabled', { on: { type: 'boolean' } }, ['on'], 'Switch the object on or off'),
    stepJson('wait', { seconds: { type: 'number', minimum: 0 } }, ['seconds'], 'Wait'),
  ],
}

/** The stages as given: lists of plain objects, checked whole once their ids and targets are put right. */
type GivenStage = { readonly id?: string; readonly steps: readonly Record<string, unknown>[] }

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const stagesInput: Schema<GivenStage[]> = {
  json: {
    type: 'array',
    description: 'The stages, in order. Each: { id?, steps: [...] }',
    items: { type: 'object', properties: { id: { type: 'string' }, steps: { type: 'array', items: STEPS_JSON } }, required: ['steps'] },
  },
  parse: (v, at) => {
    if (!Array.isArray(v)) throw new ActionError(`${at}: expected a list of stages`)
    return v.map((s, n) => {
      if (!isPlain(s) || !Array.isArray(s.steps)) throw new ActionError(`${at}[${n}]: expected { id?, steps: [...] }`)
      const steps = s.steps.map((step: unknown, k: number) => {
        if (!isPlain(step)) throw new ActionError(`${at}[${n}].steps[${k}]: expected a step`)
        return step
      })
      return typeof s.id === 'string' && s.id !== '' ? { id: s.id, steps } : { steps }
    })
  },
}

/** Eight hex digits, as the editor mints a step's. */
const mint = (): string => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')

const setSequenceStages = defineAction({
  name: 'set_sequence_stages',
  summary:
    'Set a Sequence’s stages, whole: what its object does over time — move, turn, scale, fade, switch its collider or itself on or off, wait. Stages play one after another, the steps in a stage together; the Sequence’s loop, times and offset are its other fields.',
  effect: 'edit',
  input: object({ id: str('the object the Sequence is on'), componentId: str('the Sequence’s id'), stages: stagesInput }),
  run: (ctx, input) => {
    const doc = ctx.doc()
    const i = ctx.at(input.id)
    const c = doc.components(i).find((x) => x.id === input.componentId)
    if (c === undefined) throw new ActionError(`no component ${input.componentId} on this object`)
    if (c.type !== SEQUENCE) throw new ActionError(`${input.componentId} is a ${c.type}, not a Sequence`)
    const targets = new Set(doc.childTargets(i).map((t) => t.id))
    /** A child's object id as the id a step stores, or a refusal. */
    const targetOf = (given: unknown, at: string): string | undefined => {
      if (given === undefined || given === '') return undefined
      if (typeof given !== 'string') throw new ActionError(`${at}: expected a child’s object id`)
      const j = ctx.at(given)
      const ref = doc.refAt(j)
      const stored = ref === null ? null : 'id' in ref ? ref.id : ref.node
      if (doc.parentOf(j) !== i || stored === null || !targets.has(stored)) throw new ActionError(`${at}: ${given} is not one of this object’s own children`)
      return stored
    }
    const stages = input.stages.map((s, n): Stage => ({
      id: s.id ?? mint(),
      steps: s.steps.map((step, k) => {
        const { target, ...rest } = step
        const stored = targetOf(target, `stages[${n}].steps[${k}].target`)
        return { ...rest, id: typeof step.id === 'string' && step.id !== '' ? step.id : mint(), ...(stored === undefined ? {} : { target: stored }) } as unknown as Step
      }),
    }))
    const bad = stagesProblem(stages)
    if (bad !== null) throw new ActionError(bad)
    ctx.edit('sequence steps', (d) => void d.setSequenceStages(i, input.componentId, stages))
    return { object: viewOf(ctx, input.id) }
  },
})

export const SEQUENCE_ACTIONS = [setSequenceStages]
