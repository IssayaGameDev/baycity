import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isAdmin, listedIn } from './admins'

/** Who may do what, by lists of emails in the state directory (ADR 0200). */
let dir = ''
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'mp-admins-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a list of emails', () => {
  it('names one a line, case ignored, comments and blanks skipped; missing names nobody', () => {
    const file = join(dir, 'list')
    expect(listedIn(file, 'ada@x.com')).toBe(false)
    writeFileSync(file, '# who\n\n  Ada@X.com  \r\nbob@x.com\n')
    expect(listedIn(file, 'ADA@x.com')).toBe(true)
    expect(listedIn(file, 'bob@x.com')).toBe(true)
    expect(listedIn(file, '# who')).toBe(false)
    expect(listedIn(file, 'cy@x.com')).toBe(false)
  })

  it('makes an admin of an email in admins, and reads it again each time', () => {
    expect(isAdmin(dir, 'ada@x.com')).toBe(false)
    writeFileSync(join(dir, 'admins'), 'ada@x.com\n')
    expect(isAdmin(dir, 'ada@x.com')).toBe(true)
  })
})
