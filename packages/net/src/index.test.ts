import { describe, expect, it } from 'vitest'

import { CORE_VERSION } from '@mp/core'

import { PROTOCOL_VERSION } from './index'

describe('@mp/net', () => {
  it('defines a protocol version byte', () => {
    expect(PROTOCOL_VERSION).toBe(10)
  })

  it('resolves @mp/core across the workspace boundary', () => {
    expect(CORE_VERSION).toBe('0.0.0')
  })
})
