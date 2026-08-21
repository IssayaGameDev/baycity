import { describe, expect, it } from 'vitest'

import { DEFAULT_REGISTRY } from '@mp/components'

import { levelsFor } from './levels'

/**
 * Engine plus the whole shared library, which is what `DEFAULT_REGISTRY` is for: these tests are about
 * *which* files a game sees, so validation has to pass for any shipped level and must not be coupled to one
 * game's chosen set.
 */
const ANY = DEFAULT_REGISTRY

/**
 * `content/levels/` is shared by every game on the platform, so the list has to be filtered — otherwise a
 * game offers files built for another, whose components it has never heard of.
 */
describe('a game\u2019s levels', () => {
  it('lists its own and not another game\u2019s', () => {
    const parkour = levelsFor('parkour', ANY).names()
    const swing = levelsFor('swing', ANY).names()
    expect(parkour).toContain('default')
    expect(swing).toContain('swing')
    expect(parkour, 'parkour must not see swing\u2019s levels').not.toContain('swing')
    expect(swing, 'swing must not see parkour\u2019s levels').not.toContain('default')
  })

  it('names what it does have when asked for something it does not', () => {
    expect(() => levelsFor('swing', ANY).byName('default')).toThrow(/no swing level "default"/)
  })

  it('sees nothing at all for a game with no levels', () => {
    expect(levelsFor('nobody-authored-this', ANY).names()).toEqual([])
  })

  /**
   * A level's name is its **filename**, and the directory is shared, so two games cannot both own
   * `default.json`. The fallback is therefore the game's *first* level, which is what lets a second game boot
   * with no `?level=` at all — swing has exactly one level and it is not called `default`.
   */
  describe('the level that loads with no ?level=', () => {
    it('prefers one actually called default', () => {
      expect(levelsFor('parkour', ANY).defaultName).toBe('default')
    })

    it('falls back to the first one otherwise', () => {
      expect(levelsFor('swing', ANY).defaultName).toBe('swing')
    })

    it('loads for null', () => {
      expect(levelsFor('swing', ANY).byName(null).config.mode?.name).toBe('swing')
    })
  })
})
