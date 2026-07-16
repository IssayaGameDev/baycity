import { describe, expect, it } from 'vitest'

import { PHYSICS_BACKEND } from './index'

describe('@mp/physics', () => {
  it('targets the rapier3d backend', () => {
    expect(PHYSICS_BACKEND).toBe('rapier3d')
  })
})
