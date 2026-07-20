import { describe, expect, it } from 'vitest'

import { CORE_VERSION } from '@mp/core'
import { PROTOCOL_VERSION } from '@mp/net'

import { SERVER_VERSION } from './index'

describe('@mp/server', () => {
  it('exposes a version banner', () => {
    expect(SERVER_VERSION).toBe('0.0.0')
  })

  it('resolves upstream packages (core, net)', () => {
    expect(CORE_VERSION).toBe('0.0.0')
    expect(PROTOCOL_VERSION).toBe(7)
  })
})
