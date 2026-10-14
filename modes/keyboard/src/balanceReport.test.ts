import type { BalanceLevel } from '@mp/mode'
import { describe, expect, it } from 'vitest'

import { balanceReport, HORIZON_S, PLAYER_OPTIONS } from './balanceReport'
import { World } from './components/world'

/** The Balance tab's report (ADR 0225): every World's moments and the rebirths, each beside its target. */

const levelOf = (name: string, params: Record<string, unknown> | null): BalanceLevel => ({
  name,
  level: {
    id: name,
    config: {},
    nodes: params === null ? [] : [{ id: 'w', transform: { position: { x: 0, y: 0, z: 0 } }, components: [{ id: 'c', type: World.type, params }] }],
  },
})
const quick = (wins: number, target = 0) => ({ obstacle: null, level: 0, wins, gateSeconds: 5, floorSeconds: 5, fail: 0, target })
const NO_REBIRTH = { rebirthLevel: [{ x: 1, y: 1e9 }] }
const run = (levels: BalanceLevel[], settings: unknown = { ...NO_REBIRTH }, options: Record<string, number> = {}) => balanceReport({ settings, levels, options })

describe('the balance report', () => {
  it('lists each World’s stages in the order they are entered, with their targets and simulated first clears', () => {
    const r = run([
      levelOf('W2', { levelToEnter: 1, targetToEnter: 2, stages: [quick(1)] }),
      levelOf('W1', { stages: [quick(1, 0.5), quick(2)] }),
      levelOf('empty', null),
    ])
    expect(r.groups.map((g) => g.title)).toEqual(['W1', 'W2'])
    const [w1, w2] = r.groups
    expect(w1!.moments.map((m) => [m.label, m.targetS])).toEqual([
      ['stage 1', 30],
      ['stage 2', null],
    ])
    expect(w1!.moments.every((m) => m.simulatedS !== null)).toBe(true)
    expect(w2!.moments.map((m) => [m.label, m.targetS])).toEqual([
      ['entered (Level 1)', 120],
      ['stage 1', null],
    ])
    expect(w2!.moments[0]!.simulatedS).toBeGreaterThan(0)
    expect(r.notes).toEqual([])
  })

  it('stops once everything is reached, and says so when a day of play is not enough', () => {
    const done = run([levelOf('W1', { stages: [quick(1)] })])
    expect(done.groups[0]!.moments[0]!.simulatedS).toBeLessThan(120)
    const never = run([levelOf('W1', { stages: [{ ...quick(1), level: 1e6 }] })])
    expect(never.groups[0]!.moments[0]!.simulatedS).toBeNull()
    expect(never.notes).toEqual([`Simulated ${HORIZON_S / 3600} h of play: a moment with no time is not reached by then.`])
  })

  it('lists the rebirths: as many as have targets, or came before the last stage', () => {
    const curve = { rebirthLevel: [{ x: 1, y: 2 }, { x: 2, y: 4 }], rebirthMultiplier: [{ x: 1, y: 2 }, { x: 2, y: 4 }] }
    const r = run([levelOf('W1', { stages: [quick(1), { ...quick(1), level: 5 }] })], { ...curve, rebirthTargets: [{ minutes: 1 }, { minutes: 2 }, { minutes: 600 }] })
    const rebirths = r.groups.find((g) => g.title === 'Rebirths')!
    expect(rebirths.moments.map((m) => [m.label, m.targetS])).toEqual([
      ['rebirth 1 (Level 2)', 60],
      ['rebirth 2 (Level 4)', 120],
      ['rebirth 3 (Level 8)', 36000],
    ])
  })

  it('plays the player the options say, each from its default', () => {
    const levels = [levelOf('W1', { stages: [quick(1), { ...quick(1), level: 3 }] })]
    const at = (options: Record<string, number>): number => run(levels, undefined, options).groups[0]!.moments[1]!.simulatedS!
    expect(Object.keys(PLAYER_OPTIONS)).toEqual(['hold', 'failCost', 'overhead'])
    expect(at({ hold: 50 }), 'moving half the time is slower').toBeGreaterThan(at({}))
    expect(at({ hold: 100, failCost: 50, overhead: 3 })).toBe(at({}))
  })

  it('leaves out a copy of a world, and falls back on a World’s defaults when no level has one', () => {
    const copy = run([levelOf('A', { stages: [quick(1)] }), levelOf('A-copy', { stages: [quick(1)] })])
    expect(copy.groups.map((g) => g.title)).toEqual(['A'])
    expect(copy.notes).toEqual(['A-copy opens at Level 0, as A does: left out.'])
    const none = run([levelOf('empty', null)])
    expect(none.groups[0]!.title).toBe('World 1 (defaults)')
    expect(none.groups[0]!.moments).toHaveLength(14)
    expect(none.notes).toEqual(['No level has a World: a World as a new one is, the design stages.'])
  })
})
