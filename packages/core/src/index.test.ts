import { describe, expect, it } from 'vitest'

import { CORE_VERSION } from './index'

describe('@mp/core', () => {
  it('exposes a version banner', () => {
    expect(CORE_VERSION).toBe('0.0.0')
  })
})
