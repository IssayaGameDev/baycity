import { describe, expect, it } from 'vitest'

import { readSettings } from './settings'

const DECLS = {
  perKey: { label: 'per step', default: 1 },
  growth: { label: 'growth', default: 1.15, min: 1 },
} as const

describe('readSettings', () => {
  it('lays the file over the defaults and ignores what is not a finite number or not declared', () => {
    expect(readSettings(DECLS, undefined)).toEqual({ perKey: 1, growth: 1.15 })
    expect(readSettings(DECLS, { growth: 1.2, stale: 9 })).toEqual({ perKey: 1, growth: 1.2 })
    expect(readSettings(DECLS, { perKey: 'two', growth: Number.NaN })).toEqual({ perKey: 1, growth: 1.15 })
    expect(readSettings(DECLS, { components: ['Bumper'] })).toEqual({ perKey: 1, growth: 1.15 })
  })
})
