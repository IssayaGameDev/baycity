import { describe, expect, it } from 'vitest'

import { assetFile, gameFile, isGameName, levelFile, levelRefForFile, parseQualified, qualify } from './layout'

describe('content layout (ADR 0108)', () => {
  it('builds a level, game and asset path from the content root', () => {
    expect(levelFile({ game: 'keyboard', name: 'default' })).toBe('keyboard/levels/default.level.json')
    expect(gameFile('keyboard')).toBe('keyboard/game.json')
    expect(assetFile('materials/checker.mat.json')).toBe('assets/materials/checker.mat.json')
  })

  it('round-trips a qualified name', () => {
    const ref = { game: 'swing', name: 'rope-1' }
    expect(parseQualified(qualify(ref))).toEqual(ref)
  })

  it('refuses a qualified name that is not one', () => {
    // No game, a bare name, an extra segment, and the two halves empty.
    for (const bad of ['default', '/default', 'keyboard/', 'keyboard/levels/default', '', 'a/b/c']) {
      expect(parseQualified(bad), bad).toBeNull()
    }
  })

  it('refuses `assets` as a game, because the shared library owns that folder', () => {
    expect(isGameName('assets')).toBe(false)
    expect(parseQualified('assets/checker')).toBeNull()
    // Everything else that was a legal flat level name is still legal.
    for (const ok of ['keyboard', 'parkour', 'swing', '_template', 'a-b_c9']) expect(isGameName(ok), ok).toBe(true)
  })

  it('reads a level back off its path', () => {
    expect(levelRefForFile('keyboard/levels/default.level.json')).toEqual({ game: 'keyboard', name: 'default' })
  })

  it('calls nothing else a level', () => {
    for (const bad of [
      'keyboard/levels/default.json', // the old flat extension
      'keyboard/default.level.json', // not in the levels folder
      'levels/default.level.json', // no game folder
      'assets/levels/x.level.json', // the shared library is not a game
      'keyboard/levels/deep/x.level.json', // no nesting
      'keyboard/game.json',
      'assets/materials/checker.mat.json',
    ]) {
      expect(levelRefForFile(bad), bad).toBeNull()
    }
  })
})
