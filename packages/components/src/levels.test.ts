import { readdirSync, readFileSync } from 'node:fs'

import { validateLevel } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { DEFAULT_REGISTRY } from './defaults'

/**
 * Every authored level, checked against the **real** registry.
 *
 * This is the only test that reads `content/`, and it lives here because it is the only place both halves are
 * available: `@mp/content` validates structure but never imports the declarations, and the registry is what
 * turns `validateLevel` into a parameter check (ADR 0035).
 *
 * It exists because nothing else covered the files themselves. A component renamed, a parameter retyped, or a
 * migration script writing a shape the validator rejects would all have shipped silently and failed in the
 * browser. It caught nothing when it was written, which is the point — it is a tripwire, not a discovery.
 */
describe('every authored level', () => {
  const dir = 'content/levels'
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))

  it('finds some levels at all, so a bad path cannot make this vacuously pass', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} validates, parameters included`, () => {
      const raw: unknown = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))
      expect(() => validateLevel(raw, DEFAULT_REGISTRY)).not.toThrow()
    })
  }
})
