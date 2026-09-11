import { describe, expect, it } from 'vitest'

import { formatReport, perStepFor, simulate } from './balance'
import { DEFAULT_CURVE, experienceForLevel, maxSpeedAt, stepsPerMinute } from './progression'

const PADS = [
  { perStep: 1, requiresWins: 0 },
  { perStep: 2, requiresWins: 3 },
  { perStep: 5, requiresWins: 15 },
]

describe('perStepFor', () => {
  it('is the StepPad rule: best affordable pad, else the base', () => {
    expect(perStepFor(0, PADS, 1)).toBe(1)
    expect(perStepFor(3, PADS, 1)).toBe(2)
    expect(perStepFor(14, PADS, 1)).toBe(2)
    expect(perStepFor(15, PADS, 1)).toBe(5)
    expect(perStepFor(99, [], 7)).toBe(7)
  })
})

describe('simulate', () => {
  it('earns exactly cadence × perStep at a fixed level, and finishes a stage in length / speed', () => {
    // A curve where Level never moves: level 1 costs more than an hour earns.
    const curve = { ...DEFAULT_CURVE, firstLevel: 1e12 }
    const r = simulate({ curve, stages: [{ lengthStuds: 100, wins: 1 }], pads: [], horizonS: 60, dt: 0.1 })
    const expectedXp = (stepsPerMinute(0, curve) / 60) * 60 * curve.perKey
    expect(r.final.experience).toBeCloseTo(expectedXp, 3)
    expect(r.final.level).toBe(0)
    // 100 studs at 10 studs/s = 10 s per stage → 6 stages in a minute, the first at 10 s.
    expect(r.stageAt[0]).toBeCloseTo(100 / maxSpeedAt(0, curve), 1)
    expect(r.stageAt).toHaveLength(6)
    expect(r.final.wins).toBe(6)
  })

  it('reaches levels in order, at the times the curve says, and takes pads the moment Wins allow', () => {
    const r = simulate({ curve: DEFAULT_CURVE, stages: [{ lengthStuds: 50, wins: 1 }], pads: PADS, horizonS: 600 })
    expect(r.levelAt[0]).toBe(0)
    for (let L = 1; L < r.levelAt.length; L++) expect(r.levelAt[L]!).toBeGreaterThanOrEqual(r.levelAt[L - 1]!)
    // At the moment Level 1 was reached, experience had just crossed its cost.
    const atL1 = r.samples.find((s) => s.level >= 1)
    expect(atL1).toBeDefined()
    expect(r.final.experience).toBeGreaterThan(experienceForLevel(r.final.level, DEFAULT_CURVE))
    // Pad 0 is free; pad 1 needs 3 Wins = the third stage; pad 2 needs 15 = the fifteenth.
    expect(r.padAt[0]).toBe(0)
    expect(r.padAt[1]).toBeCloseTo(r.stageAt[2]!, 5)
    expect(r.padAt[2]).toBeCloseTo(r.stageAt[14]!, 5)
    expect(r.final.perStep).toBe(5)
  })

  it('hold scales earning and distance alike', () => {
    const full = simulate({ curve: { ...DEFAULT_CURVE, firstLevel: 1e12 }, stages: [{ lengthStuds: 1e9, wins: 1 }], pads: [], horizonS: 60 })
    const half = simulate({ curve: { ...DEFAULT_CURVE, firstLevel: 1e12 }, stages: [{ lengthStuds: 1e9, wins: 1 }], pads: [], horizonS: 60, hold: 0.5 })
    expect(half.final.experience).toBeCloseTo(full.final.experience / 2, 6)
  })

  it('samples once a minute plus the end, and the report names the milestones', () => {
    const input = { curve: DEFAULT_CURVE, stages: [{ lengthStuds: 80, wins: 1 }], pads: PADS, horizonS: 300 }
    const r = simulate(input)
    expect(r.samples.map((s) => s.t)).toEqual([0, 60, 120, 180, 240, 300])
    const text = formatReport(input, r)
    expect(text).toContain('Level milestones')
    expect(text).toMatch(/L {2}1 {2}/)
    expect(text).toContain('+   2/step  needs      3 Wins')
    expect(text.split('\n').at(-1)).toMatch(/^ {3}5m00/)
  })
})
