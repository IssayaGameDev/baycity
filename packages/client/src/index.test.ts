import { describe, expect, it } from 'vitest'

import { CLIENT_VERSION } from './index'

describe('@mp/client', () => {
  it('exposes a version banner', () => {
    expect(CLIENT_VERSION).toBe('0.0.0')
  })
})
