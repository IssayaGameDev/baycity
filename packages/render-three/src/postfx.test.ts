import { validateLevel } from '@mp/content'

import { describe, expect, it } from 'vitest'

import { DEFAULT_POSTFX } from './postfx'

/**
 * The post-FX defaults (ADR 0057).
 *
 * `createPostFX` itself needs a WebGL context, so what is tested here is the part that does not: the shipped
 * values, and that they are a thing a level is allowed to say. The bug this stops is the one the ADR is about
 * — three apps each holding their own numbers, drifting, and nobody noticing because nothing compared them.
 */

describe('DEFAULT_POSTFX', () => {
  /**
   * The schema lives in `@mp/content` and the numbers live here, so nothing checks that they agree unless
   * something like this does. A default the validator would reject means a level saving what it was shown
   * fails to load.
   */
  it('is a value the level schema accepts', () => {
    expect(() =>
      validateLevel({ id: 'l', config: { environment: { postfx: DEFAULT_POSTFX } }, nodes: [] }),
    ).not.toThrow()
  })

  /**
   * These were the *game's* values before this was level data; the editor and the viewer each had their own.
   * Pinned so that adopting one app's numbers as the shared default is a deliberate edit rather than a drift.
   */
  it('is what the game shipped, so nothing changed look until a level says so', () => {
    expect(DEFAULT_POSTFX).toEqual({ ao: true, bloom: true, bloomStrength: 0.1 })
  })
})
