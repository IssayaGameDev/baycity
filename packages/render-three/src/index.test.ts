import { describe, expect, it } from 'vitest'

import { RENDER_THREE_VERSION } from './index'

describe('@mp/render-three', () => {
  it('exposes a version banner', () => {
    expect(RENDER_THREE_VERSION).toBe('0.0.0')
  })
})
