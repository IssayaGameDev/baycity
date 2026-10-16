import { describe, expect, it } from 'vitest'

import { countdownOf, countdownSeconds, countdownText, COUNTDOWN } from './countdown'
import { compileSequence, untilStage, type Sequence, type Stage, type Step } from './sequence'

/** A sign counting down to a sequence's stages (ADR 0228): the platform's fade-in, then its fade-out. */

let ids = 0
const id = (): string => `s${++ids}`
const wait = (seconds: number): Step => ({ id: id(), kind: 'wait', seconds })
const fade = (to: number, seconds: number): Step => ({ id: id(), kind: 'fade', to, timing: { by: 'seconds', seconds }, ease: 'linear' })
const stage = (...steps: Step[]): Stage => ({ id: id(), steps })
const sequence = (over: Partial<Sequence> = {}): Sequence => ({
  name: 'platform',
  clock: 'shared',
  axes: 'object',
  loop: 'restart',
  times: 0,
  offset: 0,
  // Hidden 5 s, fading in over 1, there 3, fading out over 1: a pass of 10 s. Stage 2 starts at 5, stage 4 at 9.
  stages: [stage(wait(5)), stage(fade(1, 1)), stage(wait(3)), stage(fade(0, 1))],
  ...over,
})
const at = (seconds: number) => ({ shared: seconds * 1000, local: seconds * 1000 })

describe('until a stage starts', () => {
  const c = compileSequence(sequence())

  it('counts to its start this pass, and to the next pass once it has started', () => {
    expect(untilStage(c, at(0), 1)).toBe(5)
    expect(untilStage(c, at(4.5), 1)).toBe(0.5)
    expect(untilStage(c, at(5), 1), 'begun: the next pass').toBe(10)
    expect(untilStage(c, at(7), 1)).toBe(8)
    expect(untilStage(c, at(7), 3)).toBe(2)
  })

  it('reads its own clock and offset, holds after its last pass, and has no stage it has not got', () => {
    expect(untilStage(compileSequence(sequence({ offset: 0.5 })), at(0), 1), 'half a cycle in').toBe(10)
    expect(untilStage(compileSequence(sequence({ clock: 'local' })), { shared: 99_000, local: 1000 }, 1)).toBe(4)
    expect(untilStage(compileSequence(sequence({ times: 1 })), at(6), 1), 'one pass, played').toBeNull()
    expect(untilStage(c, at(0), 9)).toBeNull()
  })

  it('on a yo-yo, counts only the forward passes: backward, a fade-in fades out', () => {
    const y = compileSequence(sequence({ loop: 'yoyo' }))
    expect(untilStage(y, at(0), 1)).toBe(5)
    expect(untilStage(y, at(6), 1), 'pass 2 runs backward: pass 3 is next').toBe(19)
  })
})

describe('the countdown', () => {
  const c = compileSequence(sequence())
  const desc = { sequence: { node: 'platform', component: '' }, rows: [{ stage: 2, text: 'Appears in {t}' }, { stage: 4, text: 'Gone in {t}' }] }

  it('says the soonest row’s words, the seconds in tenths rounded up', () => {
    expect(countdownText(desc, c, at(0))).toBe('Appears in 5.0')
    expect(countdownText(desc, c, at(4.93))).toBe('Appears in 0.1')
    expect(countdownText(desc, c, at(5)), 'it has appeared').toBe('Gone in 4.0')
    expect(countdownText(desc, c, at(8.99))).toBe('Gone in 0.1')
    expect(countdownText(desc, c, at(9))).toBe('Appears in 6.0')
  })

  it('says words without {t} as they are, and nothing to count to is the Text’s own', () => {
    expect(countdownText({ ...desc, rows: [{ stage: 2, text: 'GO!' }] }, c, at(0))).toBe('GO!')
    expect(countdownText(desc, undefined, at(0))).toBeNull()
    expect(countdownText({ ...desc, rows: [] }, c, at(0))).toBeNull()
    expect(countdownText(desc, compileSequence(sequence({ times: 1 })), at(11))).toBeNull()
  })

  it('shows a tenth as the last before its moment, never 0.0', () => {
    expect(countdownSeconds(0.01)).toBe('0.1')
    expect(countdownSeconds(2.7)).toBe('2.7')
    expect(countdownSeconds(2.71)).toBe('2.8')
  })

  it('is read off its component: the reference, old shape too, and its rows', () => {
    const comp = (params: Record<string, unknown>) => [{ id: 'c', type: COUNTDOWN, params }]
    expect(countdownOf(comp({ sequence: { node: 'p', component: 'q' }, rows: [{ stage: 2, text: 'in {t}' }] }))).toEqual({ sequence: { node: 'p', component: 'q' }, rows: [{ stage: 2, text: 'in {t}' }] })
    expect(countdownOf(comp({ sequence: 'p', rows: [] }))?.sequence).toEqual({ node: 'p', component: '' })
    expect(countdownOf(comp({ sequence: null }))).toEqual({ sequence: null, rows: [] })
    expect(countdownOf([{ id: 'c', type: COUNTDOWN, params: {}, enabled: false }])).toBeUndefined()
  })
})
