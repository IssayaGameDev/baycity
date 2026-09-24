import { describe, expect, it } from 'vitest'

import { SEQUENCE, effectiveNode, type TypeInfo } from './nodes'
import { applyOp, invertOp, OpError } from './ops'
import type { Stage, Step } from './sequence'
import { diffStages, readStages, sequenceOf, sequenceOverrideProblem, stagesFor, stagesProblem, type SequenceOverride } from './sequenceData'
import type { ComponentData, Level, Node } from './types'
import { validateLevel } from './validate'

const v3 = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z })
const moveStep = (id: string, x = 1): Step => ({ id, kind: 'move', to: v3(x, 0, 0), timing: { by: 'seconds', seconds: 1 }, ease: 'linear' })
const fadeStep = (id: string, to = 0): Step => ({ id, kind: 'fade', to, timing: { by: 'stage' }, ease: 'in-out-sine' })
const waitStep = (id: string, seconds = 1): Step => ({ id, kind: 'wait', seconds })
const switchStep = (id: string, on = true): Step => ({ id, kind: 'collider', on })
const stage = (id: string, ...steps: Step[]): Stage => ({ id, steps })

/** The prefab's sequence every test below starts from. */
const BASE: readonly Stage[] = [
  stage('s1', moveStep('a'), fadeStep('b')),
  stage('s2', switchStep('c')),
  stage('s3', waitStep('d', 2)),
]

describe('checking stored stages', () => {
  it('accepts every kind of step', () => {
    const all: Stage[] = [
      stage('s', moveStep('m'), fadeStep('f'), waitStep('w'), switchStep('c'), { id: 'e', kind: 'enabled', on: false }),
      stage('t', { id: 'r', kind: 'turn', axis: v3(0, 1, 0), angle: 90, timing: { by: 'stage', speed: 360 }, ease: 'out-bounce', target: 'child' }),
      stage('u', { id: 'z', kind: 'scale', to: v3(1, 2, 1), timing: { by: 'speed', speed: 2 }, ease: 'in-back' }),
    ]
    expect(stagesProblem(all)).toBeNull()
  })

  it('says where the problem is', () => {
    expect(stagesProblem([stage('s', { ...moveStep('m'), ease: 'wobbly' } as unknown as Step)])).toBe('stages[0].steps[0].ease: expected one of the easing names')
    expect(stagesProblem([stage('s', { ...moveStep('m'), to: 3 } as unknown as Step)])).toBe('stages[0].steps[0].to: expected a Vec3')
    expect(stagesProblem([stage('s', { id: 'w', kind: 'wait', seconds: -1 })])).toMatch(/seconds/)
    expect(stagesProblem([stage('s', { ...moveStep('m'), timing: { by: 'soon' } } as unknown as Step)])).toMatch(/timing.by/)
    expect(stagesProblem({})).toBe('stages: expected a list of stages')
  })

  /** A placement's record names stages and steps in one layout, so an id may mean only one thing. */
  it('refuses an id used twice, across stages and steps', () => {
    expect(stagesProblem([stage('x', moveStep('a')), stage('y', moveStep('a'))])).toMatch(/'a' is used twice/)
    expect(stagesProblem([stage('x', moveStep('x'))])).toMatch(/'x' is used twice/)
  })

  it('reads broken stages as none, so a hand-edited file still loads', () => {
    expect(readStages([{ id: 's', steps: [{ id: 'q', kind: 'jump' }] }])).toEqual([])
    expect(readStages(BASE)).toBe(BASE)
  })
})

describe('reading a Sequence component', () => {
  const comp = (params: Record<string, unknown>): ComponentData => ({ id: 'c', type: SEQUENCE, params })

  it('takes every setting it is given', () => {
    const s = sequenceOf(comp({ name: 'blink', clock: 'local', axes: 'level', loop: 'yoyo', times: 3, offset: 0.25, stages: BASE }))
    expect(s).toEqual({ name: 'blink', clock: 'local', axes: 'level', loop: 'yoyo', times: 3, offset: 0.25, stages: BASE })
  })

  it('falls back to the defaults for anything missing or broken', () => {
    expect(sequenceOf(comp({ clock: 'lunar', times: -2, stages: 'lots' }))).toEqual({
      name: '',
      clock: 'shared',
      axes: 'object',
      loop: 'restart',
      times: 0,
      offset: 0,
      stages: [],
    })
  })
})

describe('a placement’s difference', () => {
  /** The property the whole record rests on: what the editor shows is exactly what gets rebuilt. */
  const roundTrip = (want: readonly Stage[]): SequenceOverride | undefined => {
    const record = diffStages(BASE, want)
    expect(stagesFor(BASE, record)).toEqual(want)
    if (record !== undefined) expect(sequenceOverrideProblem(record, 'record')).toBeNull()
    return record
  }

  it('records nothing when nothing differs', () => {
    expect(diffStages(BASE, BASE)).toBeUndefined()
    expect(stagesFor(BASE, undefined)).toBe(BASE)
  })

  it('records a changed value as that field alone, and no order', () => {
    const record = roundTrip([stage('s1', moveStep('a', 7), fadeStep('b')), BASE[1]!, BASE[2]!])
    expect(record).toEqual({ steps: { a: { to: v3(7, 0, 0) } } })
  })

  it('records a target taken away as the object itself', () => {
    const aimed = [stage('s1', { ...moveStep('a'), target: 'kid' }, fadeStep('b')), BASE[1]!, BASE[2]!]
    const record = diffStages(aimed, BASE)
    expect(record).toEqual({ steps: { a: { target: '' } } })
    expect(stagesFor(aimed, record)).toEqual(BASE)
  })

  it('records removed steps and stages', () => {
    const record = roundTrip([stage('s1', fadeStep('b')), BASE[2]!])
    expect(record).toEqual({ removedSteps: ['a', 'c'], removedStages: ['s2'] })
  })

  it('records an added step and where it goes', () => {
    roundTrip([stage('s1', moveStep('a'), moveStep('new', 4), fadeStep('b')), BASE[1]!, BASE[2]!])
  })

  it('records an added stage', () => {
    roundTrip([BASE[0]!, stage('mine', waitStep('w', 5)), BASE[1]!, BASE[2]!])
  })

  it('records a step moved to another stage, and stages reordered', () => {
    roundTrip([stage('s3', waitStep('d', 2), fadeStep('b')), stage('s1', moveStep('a')), BASE[1]!])
  })

  it('keeps a step whose stage was removed when it was moved out first', () => {
    roundTrip([stage('s1', moveStep('a'), fadeStep('b'), switchStep('c')), BASE[2]!])
  })

  /** A seeded generator, so a failure reproduces. */
  const rng = (seed: number): (() => number) => {
    let s = seed >>> 0
    return () => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('rebuilds exactly what was wanted, over a thousand random edits', () => {
    const next = rng(1337)
    let fresh = 0
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!
    const at = (n: number): number => Math.floor(next() * (n + 1))
    for (let run = 0; run < 1000; run++) {
      /** Mutable, for editing in place; a `Stage`'s steps are read-only. */
      type Draft = { id: string; steps: Step[] }
      let want: Draft[] = BASE.map((s) => ({ id: s.id, steps: [...s.steps] }))
      for (let edits = 1 + Math.floor(next() * 6); edits > 0; edits--) {
        const withSteps = want.filter((s) => s.steps.length > 0)
        switch (Math.floor(next() * 8)) {
          case 0: {
            if (withSteps.length === 0) break
            const s = pick(withSteps)
            const k = Math.floor(next() * s.steps.length)
            const step = s.steps[k]!
            s.steps[k] = step.kind === 'move' ? { ...step, to: v3(next(), 1, 2) } : step.kind === 'wait' ? { ...step, seconds: 3 } : { ...step, target: 'kid' }
            break
          }
          case 1:
            if (withSteps.length > 0) {
              const s = pick(withSteps)
              s.steps.splice(Math.floor(next() * s.steps.length), 1)
            }
            break
          case 2:
            if (want.length > 0) want.splice(Math.floor(next() * want.length), 1)
            break
          case 3:
            if (want.length > 0) {
              const s = pick(want)
              s.steps.splice(at(s.steps.length), 0, moveStep(`n${++fresh}`, next()))
            }
            break
          case 4:
            want.splice(at(want.length), 0, { id: `t${++fresh}`, steps: next() < 0.5 ? [] : [waitStep(`n${++fresh}`)] })
            break
          case 5: {
            if (withSteps.length === 0 || want.length === 0) break
            const from = pick(withSteps)
            const [moved] = from.steps.splice(Math.floor(next() * from.steps.length), 1)
            const to = pick(want)
            to.steps.splice(at(to.steps.length), 0, moved!)
            break
          }
          case 6:
            if (want.length > 1) {
              const i = Math.floor(next() * want.length)
              const j = Math.floor(next() * want.length)
              ;[want[i], want[j]] = [want[j]!, want[i]!]
            }
            break
          default:
            if (withSteps.length > 0) {
              const s = pick(withSteps)
              s.steps.reverse()
            }
        }
        want = want.map((s) => ({ ...s, steps: [...s.steps] }))
      }
      expect(stagesFor(BASE, diffStages(BASE, want)), `run ${run}`).toEqual(want)
    }
  })
})

/** A prefab keeps changing after a placement recorded its differences. Nothing it recorded may break. */
describe('a prefab that changes afterwards', () => {
  it('shows a step the prefab gains, at the end of its stage, around the placement’s own order', () => {
    const record = diffStages(BASE, [stage('s1', fadeStep('b'), moveStep('a')), BASE[1]!, BASE[2]!])
    const later = [stage('s1', moveStep('a'), fadeStep('b'), switchStep('gained')), BASE[1]!, BASE[2]!]
    expect(stagesFor(later, record)[0]!.steps.map((s) => s.id)).toEqual(['b', 'a', 'gained'])
  })

  it('lets a change to a step the prefab has since lost go inert', () => {
    const record = diffStages(BASE, [stage('s1', moveStep('a', 9), fadeStep('b')), BASE[1]!, BASE[2]!])
    const later = [stage('s1', fadeStep('b')), BASE[1]!, BASE[2]!]
    expect(stagesFor(later, record)).toEqual(later)
  })

  it('keeps following the prefab for every value the placement did not change', () => {
    const record = diffStages(BASE, [stage('s1', moveStep('a', 9), fadeStep('b')), BASE[1]!, BASE[2]!])
    const later = [stage('s1', moveStep('a'), fadeStep('b', 0.5)), BASE[1]!, BASE[2]!]
    expect(stagesFor(later, record)).toEqual([stage('s1', moveStep('a', 9), fadeStep('b', 0.5)), BASE[1]!, BASE[2]!])
  })

  it('ignores a change that would make a step invalid', () => {
    const record: SequenceOverride = { steps: { a: { to: 'far' } } }
    expect(stagesFor(BASE, record)).toEqual(BASE)
  })
})

/** The op, and the level it lands in: a placement of a prefab whose piece carries a sequence. */
describe('setOverrideSequence', () => {
  const TYPES: TypeInfo = { get: () => undefined }
  const level = (): Level => ({
    id: 'lv',
    config: { mode: { name: 'parkour' } },
    prefabs: {
      door: {
        id: 'root',
        transform: { position: v3(0, 0, 0) },
        components: [],
        children: [{ id: 'leaf', transform: { position: v3(0, 0, 0) }, components: [{ id: 'seq', type: SEQUENCE, params: { name: 'open', stages: BASE } }] }],
      },
    },
    nodes: [{ id: 'p', transform: { position: v3(0, 0, 0) }, components: [], prefab: 'door' }],
  })
  const stagesOnLeaf = (l: Level): unknown => {
    const placement = effectiveNode(l, l.nodes[0]!, TYPES)
    const leaf = effectiveNode(l, placement.children[0] as Node, TYPES)
    return leaf.components.find((c) => c.id === 'seq')?.params.stages
  }
  const want = [stage('s1', moveStep('a', 3)), BASE[2]!]

  it('records the difference and bakes it into what the placement shows', () => {
    const l = level()
    applyOp(l, { kind: 'setOverrideSequence', owner: 'p', node: 'leaf', componentId: 'seq', override: diffStages(BASE, want)! })
    validateLevel(JSON.parse(JSON.stringify(l)))
    expect(stagesOnLeaf(l)).toEqual(want)
  })

  it('undoes to the prefab’s sequence, tidying the record away', () => {
    const l = level()
    const before = JSON.stringify(l)
    const op = { kind: 'setOverrideSequence', owner: 'p', node: 'leaf', componentId: 'seq', override: diffStages(BASE, want)! } as const
    const back = invertOp(l, op)
    applyOp(l, op)
    applyOp(l, back!)
    expect(JSON.stringify(l)).toBe(before)
    expect(stagesOnLeaf(l)).toEqual(BASE)
  })

  it('is a no-op when the record is what is already there', () => {
    const l = level()
    expect(invertOp(l, { kind: 'setOverrideSequence', owner: 'p', node: 'leaf', componentId: 'seq', override: null })).toBeNull()
  })

  it('refuses a malformed record, and a component the placement added', () => {
    const l = level()
    expect(() => invertOp(l, { kind: 'setOverrideSequence', owner: 'p', node: 'leaf', componentId: 'seq', override: { removedSteps: [3] } as unknown as SequenceOverride })).toThrow(OpError)
    applyOp(l, { kind: 'addOverrideComponent', owner: 'p', node: 'leaf', component: { id: 'mine', type: SEQUENCE, params: {} } })
    expect(() => invertOp(l, { kind: 'setOverrideSequence', owner: 'p', node: 'leaf', componentId: 'mine', override: {} })).toThrow(/edit its params instead/)
  })
})
