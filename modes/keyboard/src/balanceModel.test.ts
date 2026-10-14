import type { BalanceLevel } from '@mp/mode'
import { describe, expect, it } from 'vitest'

import { generateModel, modelRulesFrom, type ModelOut } from './balanceModel'
import { balanceReport, KEYBOARD_BALANCE } from './balanceReport'
import { World } from './components/world'

/** World 1 from a few rules (ADR 0226): every number out, and the game's own simulator holding to them. */

const SHARP = { hold: 1, failCost: 0.5, overheadSeconds: 3 }
const RULES = modelRulesFrom(undefined)
const made = (worldParams: Record<string, unknown> = { stages: [] }, rules = RULES): ModelOut => {
  const out = generateModel(rules, SHARP, undefined, worldParams)
  if ('refused' in out) throw new Error(out.refused)
  return out
}
const levelWith = (params: Record<string, unknown>): BalanceLevel => ({
  name: 'Roblox_World_1',
  level: { id: 'w1', config: {}, nodes: [{ id: 'w', transform: { position: { x: 0, y: 0, z: 0 } }, components: [{ id: 'c', type: World.type, params }] }] },
})

describe('the balance model', () => {
  const out = made()

  it('spreads the stages’ Levels evenly to the last, each paying the growth times the last, on the pace', () => {
    expect(out.stages.map((s) => s.level)).toEqual([6, 13, 19, 25, 32, 38, 44, 51, 57, 63, 70, 76, 82, 89, 95])
    expect(out.stages.map((s) => s.wins)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384])
    // Each wait a step longer than the last: 0.34 min a step, here.
    expect(out.stages.map((s) => s.target)).toEqual([0.3, 1, 2, 3.4, 5.1, 7.1, 9.5, 12.2, 15.3, 18.7, 22.4, 26.5, 30.9, 35.6, 40.7])
  })

  it('makes the curves: speed on its two points, a rebirth every four stages at their Levels, each ×2', () => {
    expect(out.settings.speed).toEqual([
      { x: 0, y: 10 },
      { x: 100, y: 200 },
    ])
    expect(out.settings.rebirthLevel).toEqual([
      { x: 1, y: 25 },
      { x: 2, y: 51 },
      { x: 3, y: 76 },
    ])
    expect(out.settings.rebirthMultiplier.map((p) => p.y)).toEqual([2, 4, 8])
    const [c0, c100] = out.settings.levelCost
    expect(c0!.x).toBe(0)
    expect(c100!.y / c0!.y).toBeCloseTo(1.125 ** 100, -3)
  })

  it('prices each pad where it unlocks: rising, the first free, each paying twice the last', () => {
    expect(out.settings.pads.map((p) => p.perStep)).toEqual([1, 2, 4, 8, 16, 32, 64, 128])
    const wins = out.settings.pads.map((p) => p.requiresWins!)
    expect(wins[0]).toBe(0)
    for (let i = 1; i < wins.length; i++) expect(wins[i], `pad ${i + 1}`).toBeGreaterThan(wins[i - 1]!)
  })

  it('brings the next world in at the world’s length, on the game’s own simulator', () => {
    const settings = { ...out.settings }
    const r = balanceReport({ settings, levels: [levelWith({ stages: out.stages })], options: {} })
    // With the World only, the run stops at its last stage; with the next world listed it is entered on time.
    const two = balanceReport({
      settings,
      levels: [levelWith({ stages: out.stages }), { ...levelWith({ levelToEnter: 100, stages: [{ obstacle: null, level: 100, wins: 1 }] }), name: 'World_2' }],
      options: {},
    })
    const entered = two.groups[1]!.moments[0]!.simulatedS!
    expect(Math.abs(entered - 45 * 60), 'the next world at 45 min, within a run').toBeLessThan(60)
    const stages = r.groups[0]!.moments
    for (const m of stages) expect(Math.abs(m.simulatedS! - m.targetS!), m.label).toBeLessThan(3 * 60)
  })

  it('keeps what a row holds — its obstacle, its run — and adds the rows it lacks', () => {
    const obstacle = { node: 'o1', component: 'c1' }
    const kept = made({ stages: [{ obstacle, level: 0, wins: 1, gateSeconds: 19, floorSeconds: 19, fail: 10, target: 0 }] })
    expect(kept.stages[0]).toMatchObject({ obstacle, gateSeconds: 19, floorSeconds: 19, fail: 10, level: 6, wins: 1, target: 0.3 })
    expect(kept.stages).toHaveLength(15)
    expect(kept.stages[14]).toMatchObject({ obstacle: null, level: 95 })
  })

  it('refuses without a World, past the rows it would drop, and on rules that cannot be', () => {
    expect(generateModel(RULES, SHARP, undefined, null)).toEqual({ refused: expect.stringContaining('World component') })
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ obstacle: i === 15 ? { node: 'o', component: '' } : null, level: 0, wins: 1 }))
    expect(generateModel(RULES, SHARP, undefined, { stages: sixteen })).toEqual({ refused: expect.stringContaining('set Stages to 16') })
    expect(generateModel({ ...RULES, modelLastLevel: 10 }, SHARP, undefined, { stages: [] })).toEqual({ refused: expect.stringContaining('at least the number of stages') })
    expect(generateModel({ ...RULES, modelNextLevel: 90 }, SHARP, undefined, { stages: [] })).toEqual({ refused: expect.stringContaining('after the last stage') })
  })

  it('is the Balance tab’s Apply: settings, and the World’s stages', () => {
    const r = KEYBOARD_BALANCE.apply!({ settings: undefined, rules: {}, options: {}, paramsOf: (type) => (type === World.type ? { stages: [] } : null) })
    expect(r.refused).toBeNull()
    expect(Object.keys(r.settings).sort()).toEqual(['levelCost', 'pads', 'rebirthLevel', 'rebirthMultiplier', 'speed'])
    expect(r.component?.type).toBe(World.type)
    expect((r.component?.patch.stages as unknown[]).length).toBe(15)
    expect(KEYBOARD_BALANCE.apply!({ settings: undefined, rules: {}, options: {}, paramsOf: () => null }).refused).toContain('World component')
  })
})
