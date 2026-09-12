import { describe, expect, it } from 'vitest'

import { readSettings } from './settings'

const DECLS = {
  perKey: { label: 'per step', default: 1 },
  growth: { label: 'growth', default: 1.15, min: 1 },
  cost: {
    kind: 'curve',
    label: 'cost',
    xLabel: 'Level',
    yLabel: 'XP',
    interpolation: 'ratio',
    beyond: 'extend',
    default: [{ x: 0, y: 100 }, { x: 1, y: 115 }],
  },
} as const

describe('readSettings', () => {
  it('lays the file over the defaults and ignores what is not a finite number or not declared', () => {
    expect(readSettings(DECLS, undefined)).toEqual({ perKey: 1, growth: 1.15, cost: [{ x: 0, y: 100 }, { x: 1, y: 115 }] })
    expect(readSettings(DECLS, { growth: 1.2, stale: 9 }).growth).toBe(1.2)
    expect(readSettings(DECLS, { perKey: 'two', growth: Number.NaN }).growth).toBe(1.15)
    expect(readSettings(DECLS, { components: ['Bumper'] }).perKey).toBe(1)
  })

  it('a curve is a point list when the file has one, the default copy otherwise', () => {
    const own = readSettings(DECLS, { cost: [{ x: 10, y: 5 }, { x: 0, y: 1 }] }).cost
    expect(own).toEqual([{ x: 0, y: 1 }, { x: 10, y: 5 }])
    const fallback = readSettings(DECLS, { cost: 'nope' }).cost
    expect(fallback).toEqual(DECLS.cost.default)
    fallback[0]!.y = 999
    expect(DECLS.cost.default[0]!.y, 'the default is copied, not handed out').toBe(100)
  })
})
