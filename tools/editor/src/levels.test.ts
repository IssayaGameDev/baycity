import { readdirSync, readFileSync } from 'node:fs'

import { DEFAULT_REGISTRY } from '@mp/components'
import { validateLevel } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { MODES } from './modes'

/**
 * Every authored level, checked against **its own game's** registry.
 *
 * It lives here rather than in `@mp/components` because that stopped being the place both halves are
 * available. ADR 0052 made a game compose its own registry with its own components, and ADR 0069 was the
 * first game to actually do it: `Keyboard` belongs to `modes/keyboard`, so `DEFAULT_REGISTRY` rejected a level
 * that is perfectly valid. A package cannot import a game without inverting the dependency; the editor
 * already globs every one of them, so this is where the question can be asked.
 *
 * Stronger than what it replaces, too. Validating against the game named in `config.mode.name` also catches a
 * level authored for a game whose registry does not install the component the level uses — which the old test
 * could not see at all.
 *
 * A level naming no game, or one this build does not have, falls back to the shared registry: those files
 * predate games being explicit and must still be readable (`modeOf`'s own rule).
 *
 * It exists because nothing else covers the files themselves. A component renamed, a parameter retyped, or a
 * migration writing a shape the validator rejects would all ship silently and fail in the browser.
 */
describe('every authored level', () => {
  const dir = 'content/levels'
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))

  it('finds some levels at all, so a bad path cannot make this vacuously pass', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('has the games installed that its levels name', () => {
    // Not a validity check — a tripwire on the glob. If `MODES` came back empty the loop below would still
    // pass on every file, having quietly fallen back to the shared registry for all of them.
    expect(Object.keys(MODES).length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} validates against its own game, parameters included`, () => {
      const raw: unknown = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))
      const named = (raw as { config?: { mode?: { name?: unknown } } }).config?.mode?.name
      const mode = typeof named === 'string' ? MODES[named] : undefined
      expect(() => validateLevel(raw, mode?.registry ?? DEFAULT_REGISTRY)).not.toThrow()
    })
  }
})
