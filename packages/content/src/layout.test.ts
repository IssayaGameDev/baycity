import { describe, expect, it } from 'vitest'

import { gameFile, inLibrary, isGameName, levelFile, levelRefForFile, libraryDir, libraryOf, mayUse, parseQualified, qualify } from './layout'

describe('content layout (ADR 0108)', () => {
  it('builds a level and a game path from the content root', () => {
    expect(levelFile({ game: 'keyboard', name: 'default' })).toBe('keyboard/levels/default.level.json')
    expect(gameFile('keyboard')).toBe('keyboard/game.json')
  })

  it('starts an asset path with its library, shared or a game’s own (ADR 0161)', () => {
    expect(libraryDir(null)).toBe('assets')
    expect(libraryDir('keyboard')).toBe('keyboard/assets')
    expect(libraryOf('assets/materials/red.mat.json')).toBeNull()
    expect(libraryOf('keyboard/assets/materials/red.mat.json')).toBe('keyboard')
    expect(libraryOf('keyboard/assets')).toBe('keyboard')
    for (const none of ['keyboard/levels/default.level.json', 'keyboard/game.json', 'materials/red.mat.json', 'assets2/x']) {
      expect(libraryOf(none), none).toBeUndefined()
    }
  })

  it('tells what is inside a library from the library’s own folder', () => {
    expect(inLibrary('assets/materials')).toBe(true)
    expect(inLibrary('keyboard/assets/materials/red.mat.json')).toBe(true)
    for (const not of ['assets', 'keyboard/assets', 'keyboard/levels/x.level.json', 'assets/../keyboard/game.json', 'assets//x']) {
      expect(inLibrary(not), not).toBe(false)
    }
  })

  it('lets a game’s things use its own and Shared’s, and Shared’s only Shared’s (ADR 0161)', () => {
    expect(mayUse('keyboard', 'assets/materials/red.mat.json')).toBe(true)
    expect(mayUse('keyboard', 'keyboard/assets/materials/red.mat.json')).toBe(true)
    expect(mayUse('parkour', 'keyboard/assets/materials/red.mat.json')).toBe(false)
    expect(mayUse(null, 'keyboard/assets/materials/red.mat.json'), 'a Shared asset').toBe(false)
    expect(mayUse(null, 'assets/materials/red.mat.json')).toBe(true)
    expect(mayUse('keyboard', 'keyboard/levels/x.level.json'), 'not an asset at all').toBe(false)
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
