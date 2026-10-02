import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Who may do what, by lists of emails in the state directory (ADR 0200): one email a line, `#` comments, case
 * ignored — read every time it is asked, so an edit to one needs no restart. Missing or empty: nobody.
 */
export const listedIn = (file: string, email: string): boolean => {
  if (!existsSync(file)) return false
  const want = email.toLowerCase()
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .some((l) => l !== '' && !l.startsWith('#') && l === want)
}

/** The admin role (ADR 0200, Kodjo's call: only him): the emails in this file, whose the admin page is. */
export const ADMINS_FILE = 'admins'

export const isAdmin = (stateDir: string, email: string): boolean => listedIn(join(stateDir, ADMINS_FILE), email)
