import type { Sequence, Stage, Step } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import {
  EASE_OPTIONS,
  STEP_CHOICES,
  addStep,
  duplicateStage,
  duplicateStep,
  easeLabel,
  moveStage,
  moveStageAcross,
  moveStep,
  moveStepAcross,
  newStep,
  removeStep,
  replaceStep,
  sequenceSummary,
  stepLine,
} from './sequenceEdit'

let n = 0
const fresh = (): string => `f${++n}`
const wait = (id: string, seconds = 1): Step => ({ id, kind: 'wait', seconds })
const ids = (stages: readonly Stage[]): string[][] => stages.map((s) => [s.id, ...s.steps.map((x) => x.id)])

/** Three stages: `A` with a and b, `B` with c, `C` with d. */
const ABC: readonly Stage[] = [
  { id: 'A', steps: [wait('a'), wait('b')] },
  { id: 'B', steps: [wait('c')] },
  { id: 'C', steps: [wait('d')] },
]

describe('what a step says', () => {
  it('reads the way the brief writes it', () => {
    expect(stepLine({ id: 's', kind: 'move', to: vec3(0, -7, 10), timing: { by: 'speed', speed: 8 }, ease: 'linear' })).toBe('move  (0, -7, 10)   8 m/s   linear')
    expect(stepLine({ id: 's', kind: 'turn', axis: vec3(1, 0, 0), angle: 540, timing: { by: 'stage' }, ease: 'linear' })).toBe('turn  (1, 0, 0)  540°   stage   linear')
    expect(stepLine({ id: 's', kind: 'turn', axis: vec3(1, 0, 0), angle: 0, timing: { by: 'stage', speed: 360 }, ease: 'linear' })).toBe('turn  (1, 0, 0)  360°/s  stage')
    expect(stepLine({ id: 's', kind: 'scale', to: vec3(1, 2, 1), timing: { by: 'seconds', seconds: 0.5 }, ease: 'in-out-sine' })).toBe('scale  ×(1, 2, 1)   0.5 s   sine in-out')
    expect(stepLine({ id: 's', kind: 'fade', to: 0.3, timing: { by: 'seconds', seconds: 0.5 }, ease: 'linear' })).toBe('fade  to 0.3   0.5 s   linear')
    expect(stepLine({ id: 's', kind: 'collider', on: false })).toBe('collider off')
    expect(stepLine({ id: 's', kind: 'enabled', on: false })).toBe('disable')
    expect(stepLine(wait('s', 2))).toBe('wait   2 s')
  })

  it('names the child a step is aimed at', () => {
    expect(stepLine({ id: 's', kind: 'move', to: vec3(-1, 0, 0), timing: { by: 'seconds', seconds: 1 }, ease: 'linear' }, 'LeftHalf')).toBe('move → LeftHalf  (-1, 0, 0)   1 s   linear')
  })

  it('labels every ease', () => {
    expect(EASE_OPTIONS).toHaveLength(31)
    expect(easeLabel('out-bounce')).toBe('bounce out')
  })
})

describe('the header summary', () => {
  const plain: Sequence = { name: '', clock: 'shared', axes: 'object', loop: 'restart', times: 0, offset: 0, stages: [] }

  it('shows only the length when every setting is the default', () => {
    expect(sequenceSummary(plain, 4.5)).toBe('4.5 s')
  })

  it('shows what differs, a local clock always among it', () => {
    expect(sequenceSummary({ ...plain, clock: 'local', loop: 'yoyo', times: 3 }, 2)).toBe('local · yo-yo · 3 times · 2 s')
  })
})

describe('new steps', () => {
  it('offers every kind, in the brief’s order, each one valid', () => {
    expect(STEP_CHOICES.map((c) => c.label)).toEqual(['move', 'turn', 'scale', 'fade', 'collider on', 'collider off', 'enable', 'disable', 'wait'])
    for (const { choice } of STEP_CHOICES) expect(newStep(choice, 'x').id).toBe('x')
  })
})

describe('editing', () => {
  it('adds into a stage, before a step or at its end', () => {
    expect(ids(addStep(ABC, wait('z'), { kind: 'into', stage: 'A', before: 'b' }, fresh))[0]).toEqual(['A', 'a', 'z', 'b'])
    expect(ids(addStep(ABC, wait('z'), { kind: 'into', stage: 'B' }, fresh))[1]).toEqual(['B', 'c', 'z'])
  })

  it('adds a stage of its own, before another or at the end', () => {
    const before = addStep(ABC, wait('z'), { kind: 'new-stage', before: 'B' }, () => 'N')
    expect(ids(before).map((s) => s[0])).toEqual(['A', 'N', 'B', 'C'])
    expect(ids(addStep(ABC, wait('z'), { kind: 'new-stage' }, () => 'N')).at(-1)).toEqual(['N', 'z'])
  })

  /** A stage exists to hold steps: emptied, it goes (the brief). */
  it('drops a stage its last step leaves', () => {
    expect(ids(removeStep(ABC, 'c')).map((s) => s[0])).toEqual(['A', 'C'])
  })

  it('changes one step in place', () => {
    const next = replaceStep(ABC, wait('c', 9))
    expect(next[1]!.steps[0]).toEqual(wait('c', 9))
    expect(next[0]).toBe(ABC[0])
  })

  it('duplicates a step after itself and a stage after itself, with fresh ids', () => {
    expect(ids(duplicateStep(ABC, 'a', () => 'a2'))[0]).toEqual(['A', 'a', 'a2', 'b'])
    let k = 0
    const twice = duplicateStage(ABC, 'A', () => `n${++k}`)
    expect(ids(twice).slice(0, 2)).toEqual([['A', 'a', 'b'], ['n1', 'n2', 'n3']])
  })
})

describe('dragging', () => {
  it('moves a step into another stage', () => {
    expect(ids(moveStep(ABC, 'a', { kind: 'into', stage: 'C', before: 'd' }, fresh))).toEqual([['A', 'b'], ['B', 'c'], ['C', 'a', 'd']])
  })

  it('makes a step its own stage when dropped between boxes', () => {
    expect(ids(moveStep(ABC, 'b', { kind: 'new-stage', before: 'C' }, () => 'N'))).toEqual([['A', 'a'], ['B', 'c'], ['N', 'b'], ['C', 'd']])
  })

  /** The stage it empties goes — and a drop placed relative to that stage still lands where it was aimed. */
  it('drops the stage a moved step empties, even when the drop is placed against it', () => {
    expect(ids(moveStep(ABC, 'c', { kind: 'new-stage', before: 'B' }, () => 'N'))).toEqual([['A', 'a', 'b'], ['N', 'c'], ['C', 'd']])
  })

  it('leaves everything alone when a step is dropped on itself', () => {
    expect(moveStep(ABC, 'a', { kind: 'into', stage: 'A', before: 'a' }, fresh)).toEqual(ABC)
  })

  it('moves a stage, with its steps', () => {
    expect(ids(moveStage(ABC, 'C', 'A')).map((s) => s[0])).toEqual(['C', 'A', 'B'])
    expect(ids(moveStage(ABC, 'A')).map((s) => s[0])).toEqual(['B', 'C', 'A'])
  })

  it('moves a step or a stage into another sequence on the same object', () => {
    const other: readonly Stage[] = [{ id: 'X', steps: [wait('x')] }]
    const step = moveStepAcross(ABC, other, 'c', { kind: 'into', stage: 'X' }, fresh)!
    expect(ids(step.from).map((s) => s[0])).toEqual(['A', 'C'])
    expect(ids(step.to)).toEqual([['X', 'x', 'c']])
    const stage = moveStageAcross(ABC, other, 'A', 'X')!
    expect(ids(stage.to).map((s) => s[0])).toEqual(['A', 'X'])
    expect(ids(stage.from).map((s) => s[0])).toEqual(['B', 'C'])
  })
})
