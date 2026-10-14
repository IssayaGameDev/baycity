import { describe, expect, it } from 'vitest'

import { readSetting, readSettings, type TableSetting } from './settings'

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

/** A table (ADR 0222): rows of numbers in named columns — Keyboard's step pads. */
describe('a table setting', () => {
  const PADS: TableSetting = {
    kind: 'table',
    label: 'Step pads',
    columns: { perStep: { label: 'XP', default: 1 }, requiresWins: { label: 'Wins', default: 0 } },
    default: [{ perStep: 1, requiresWins: 0 }, { perStep: 2, requiresWins: 3 }],
  }
  it('reads the file’s rows, a column it lacks or cannot use at its default, and the declared rows otherwise', () => {
    expect(readSetting(PADS, [{ perStep: 5, requiresWins: 15 }, { perStep: 'x' }])).toEqual([{ perStep: 5, requiresWins: 15 }, { perStep: 1, requiresWins: 0 }])
    expect(readSetting(PADS, 'nope')).toEqual(PADS.default)
    expect(readSetting(PADS, [1, 2]), 'not rows').toEqual(PADS.default)
    const copy = readSetting(PADS, undefined)
    copy[0]!.perStep = 999
    expect(PADS.default[0]!.perStep, 'the default is copied').toBe(1)
  })
})
