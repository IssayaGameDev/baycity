import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { clearTime, formatReport, perStepFor, simulate, type Scenario } from './balance'
import { DEFAULT_CURVE, maxSpeedAt, stepsPerMinute } from './progression'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const WORLD1 = JSON.parse(readFileSync(here('../balance.world1.json'), 'utf8')) as Scenario

const one = (stages: { stage: number; speed: number; wins: number }[], extra: Partial<Scenario> = {}): Scenario => ({
  worlds: [{ name: 'W', levelRequired: 0, xpMultiplier: 1, speedMultiplier: 1, stages }],
  pads: [],
  rebirths: [],
  trails: [],
  auras: [],
  clearSeconds: 10,
  fastClearSeconds: 5,
  ...extra,
})

describe('the World 1 scenario agrees with docs/games/keyboard/world-1.md', () => {
  const md = readFileSync(here('../../../docs/games/keyboard/world-1.md'), 'utf8')
  const rows = md
    .split('\n')
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => {
      const cells = l.split('|').map((c) => c.trim())
      const speed = Number(/[\d.]+/.exec(cells[3] ?? '')?.[0])
      const wins = Number((cells[5] ?? '').replace(/\s/g, ''))
      return { stage: Number(cells[1]), speed, wins }
    })
  it('has the same stages, gate speeds (low bound) and Wins', () => {
    const stages = WORLD1.worlds[0]!.stages
    expect(stages.length).toBeGreaterThan(10)
    for (const s of stages) {
      const row = rows.find((r) => r.stage === s.stage)
      expect(row, `stage ${s.stage} in the doc`).toBeDefined()
      expect(row!.speed, `stage ${s.stage} speed`).toBe(s.speed)
      expect(row!.wins, `stage ${s.stage} wins`).toBe(s.wins)
    }
  })
  it('names the worlds at the Levels the doc gives', () => {
    expect(WORLD1.worlds.map((w) => w.levelRequired)).toEqual([0, 120, 400])
  })
})

describe('perStepFor', () => {
  it('is the StepPad rule: best affordable pad, else the base', () => {
    const pads = WORLD1.pads
    expect(perStepFor(0, pads, 1)).toBe(1)
    expect(perStepFor(3, pads, 1)).toBe(2)
    expect(perStepFor(14, pads, 1)).toBe(2)
    expect(perStepFor(15, pads, 1)).toBe(5)
    expect(perStepFor(99, [], 7)).toBe(7)
  })
})

describe('clearTime', () => {
  it('is the slow time at the gate, the fast time from twice the gate, linear between', () => {
    expect(clearTime(50, 50, 45, 5)).toBe(45)
    expect(clearTime(50, 75, 45, 5)).toBe(25)
    expect(clearTime(50, 100, 45, 5)).toBe(5)
    expect(clearTime(50, 500, 45, 5)).toBe(5)
    expect(clearTime(0, 10, 45, 5)).toBe(5)
  })
})

describe('simulate', () => {
  it('earns cadence × per-step at a fixed level, and clears a stage every clearTime', () => {
    const curve = { ...DEFAULT_CURVE, levelCost: [{ x: 0, y: 1e15 }] }
    const r = simulate({ curve, scenario: one([{ stage: 1, speed: 1, wins: 1 }]), horizonS: 60, dt: 0.25 })
    expect(r.final.experience).toBeCloseTo((stepsPerMinute(0, curve) / 60) * 60, 3)
    // Speed 10 against gate 1 is far past twice the gate → the fast time, 5 s → 12 clears in a minute.
    expect(r.final.wins).toBe(12)
    expect(r.final.level).toBe(0)
  })

  it('runs the furthest passable stage and opens new ones as speed grows', () => {
    const stages = [
      { stage: 1, speed: 1, wins: 1 },
      { stage: 2, speed: 30, wins: 10 },
      { stage: 3, speed: 50, wins: 100 },
    ]
    const r = simulate({ curve: DEFAULT_CURVE, scenario: one(stages), horizonS: 3 * 3600 })
    expect(r.stageOpenAt.get('W/1')).toBe(0)
    const open2 = r.stageOpenAt.get('W/2')
    const open3 = r.stageOpenAt.get('W/3')
    expect(open2).toBeDefined()
    expect(open3).toBeDefined()
    expect(open2!).toBeLessThan(open3!)
    expect(maxSpeedAt(10, DEFAULT_CURVE)).toBe(30)
    expect(r.events.some((e) => e.what.startsWith('stage 2'))).toBe(true)
  })

  it('takes pads by threshold, buys the best affordable trail once, and rebirths at the Level', () => {
    const scenario = one([{ stage: 1, speed: 1, wins: 100 }], {
      pads: [{ perStep: 1, requiresWins: 0 }, { perStep: 5, requiresWins: 300 }],
      trails: [{ name: 'a', wins: 500, multiplier: 2 }, { name: 'b', wins: 2000, multiplier: 3 }],
      rebirths: [{ levelRequired: 3, multiplier: 2 }],
    })
    const r = simulate({ curve: DEFAULT_CURVE, scenario, horizonS: 600 })
    const whats = r.events.map((e) => e.what)
    expect(whats.some((w) => w.startsWith('pad +5/step taken'))).toBe(true)
    expect(whats.filter((w) => w.startsWith('trail a bought'))).toHaveLength(1)
    expect(whats.some((w) => w.startsWith('trail b bought'))).toBe(true)
    expect(whats.some((w) => w.startsWith('rebirth 1 at Level 3'))).toBe(true)
    expect(r.final.rebirths).toBe(1)
    // After the rebirth the per-step carries ×2 and the trail; the pad stays.
    expect(r.final.perStep).toBe(5 * 2 * 3)
  })

  it('moves up a world when its Level opens and applies its multipliers', () => {
    const scenario: Scenario = {
      ...one([{ stage: 1, speed: 1, wins: 1 }]),
      worlds: [
        { name: 'W1', levelRequired: 0, xpMultiplier: 1, speedMultiplier: 1, stages: [{ stage: 1, speed: 1, wins: 1 }] },
        { name: 'W2', levelRequired: 5, xpMultiplier: 100, speedMultiplier: 0.5, stages: [{ stage: 1, speed: 1, wins: 1 }] },
      ],
    }
    const r = simulate({ curve: DEFAULT_CURVE, scenario, horizonS: 1200 })
    expect(r.events.some((e) => e.what.startsWith('entered W2 at Level 5'))).toBe(true)
    expect(r.final.world).toBe('W2')
    expect(r.final.perStep).toBe(100)
    expect(r.final.speed).toBe(maxSpeedAt(r.final.level, DEFAULT_CURVE) * 0.5)
  })

  it('reports without throwing on the real scenario', () => {
    const input = { curve: DEFAULT_CURVE, scenario: WORLD1, horizonS: 1800 }
    const text = formatReport(input, simulate(input))
    expect(text).toContain('Level milestones')
    expect(text).toContain('Events')
    expect(text).toMatch(/World 1: 14 stages/)
  })
})
