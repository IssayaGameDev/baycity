import { describe, expect, it } from 'vitest'

import { CORE_VERSION } from '@mp/core'
import { PROTOCOL_VERSION } from '@mp/net'
import { PHYSICS_BACKEND } from '@mp/physics'

import { SERVER_VERSION } from './index'

describe('@mp/server', () => {
  it('exposes a version banner', () => {
    expect(SERVER_VERSION).toBe('0.0.0')
  })

  it('resolves all upstream packages (core, net, physics)', () => {
    expect(CORE_VERSION).toBe('0.0.0')
    expect(PROTOCOL_VERSION).toBe(4)
    expect(PHYSICS_BACKEND).toBe('rapier3d')
  })
})
