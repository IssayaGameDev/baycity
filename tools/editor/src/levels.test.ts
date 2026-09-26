import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { levelRefForFile, LEVELS_DIR, validateLevel } from '@mp/content'
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
 * The game is now the **folder** the level is in (ADR 0108), which is stronger than the `config.mode.name` it
 * used to read: a tag can be absent, stale or in a file that will not parse, and a folder cannot. A level in
 * a folder this build has no game for is skipped: there is no registry to hold it to, and a game removed from
 * the code keeps its folder in `content/` until its removal comes back from the box (ADR 0171).
 *
 * It exists because nothing else covers the files themselves. A component renamed, a parameter retyped, or a
 * migration writing a shape the validator rejects would all ship silently and fail in the browser.
 */
describe('every authored level', () => {
  const root = 'content'
  /** Walk the game folders: `content/<game>/levels/<name>.level.json`. */
  const files = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${root}/${e.name}/${LEVELS_DIR}`))
    .flatMap((e) =>
      readdirSync(`${root}/${e.name}/${LEVELS_DIR}`).map((f) => `${e.name}/${LEVELS_DIR}/${f}`),
    )
    .filter((rel) => levelRefForFile(rel) !== null)

  it('finds some levels at all, so a bad path cannot make this vacuously pass', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('has the games installed that its level folders name', () => {
    // Not a validity check — a tripwire on the glob. If `MODES` came back empty the loop below would skip every
    // file and pass having checked nothing.
    expect(Object.keys(MODES).length).toBeGreaterThan(0)
  })

  for (const rel of files) {
    const mode = MODES[levelRefForFile(rel)!.game]
    it.skipIf(mode === undefined)(`${rel} validates against its own game, parameters included`, () => {
      const raw: unknown = JSON.parse(readFileSync(`${root}/${rel}`, 'utf8'))
      expect(() => validateLevel(raw, mode!.registry)).not.toThrow()
    })
  }
})
