import { describe, expect, it } from 'vitest'

import { RENDER_PIXI_VERSION } from './index'

describe('@mp/render-pixi', () => {
  it('exposes a version banner', () => {
    expect(RENDER_PIXI_VERSION).toBe('0.0.0')
  })
})
