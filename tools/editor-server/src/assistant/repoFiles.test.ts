import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { git } from '../git'
import { cleanPath, createRepoFiles, looksSecret, Refused } from './repoFiles'

/**
 * What the assistant may read (ADR 0192): tracked files inside the checkout, never a secret — refused by the server
 * whatever the model asks for.
 */

let root = ''
let outside = ''
const write = (dir: string, rel: string, body: string): void => {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mp-assist-'))
  outside = mkdtempSync(join(tmpdir(), 'mp-assist-out-'))
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.name', 'seed'])
  await git(root, ['config', 'user.email', 'seed@x'])
  write(root, 'docs/INDEX.md', '# Index\nthe table of contents\n')
  write(root, 'src/hazard.ts', Array.from({ length: 50 }, (_, n) => `line ${n + 1}${n === 9 ? ' onContact kills' : ''}`).join('\n'))
  write(root, 'deploy/server.key', 'not for anyone')
  write(root, '.gitignore', '.env\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '--quiet', '-m', 'seed'])
  // Not tracked: ignored, or simply never added.
  write(root, '.env', 'ACCESS_TOKEN=secret')
  write(root, 'scratch.txt', 'untracked')
  write(outside, 'anthropic.key', 'sk-very-secret')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('reading the repository', () => {
  it('reads a tracked file, numbered, in the range asked', async () => {
    const files = createRepoFiles(root)
    const out = await files.read('src/hazard.ts', 9, 11)
    expect(out.split('\n')[0]).toBe('src/hazard.ts — lines 9–11 of 50')
    expect(out).toContain('   10  line 10 onContact kills')
    expect(out).not.toContain('line 12')
  })

  it('lists and searches tracked files only', async () => {
    const files = createRepoFiles(root)
    expect(await files.list('')).toEqual(['.gitignore', 'docs/INDEX.md', 'src/hazard.ts'])
    expect(await files.search('onContact')).toBe('src/hazard.ts:10:line 10 onContact kills')
    expect(await files.search('nowhere to be found')).toBe('no matches')
    expect(await files.search('ACCESS_TOKEN'), 'an ignored file is not searched').toBe('no matches')
  })

  it('refuses what is not tracked, what looks secret, and anything outside', async () => {
    const files = createRepoFiles(root)
    for (const asked of ['.env', 'scratch.txt', 'deploy/server.key', '../x', `${outside}/anthropic.key`, 'C:/Windows/win.ini', '/etc/passwd']) {
      await expect(files.read(asked), asked).rejects.toBeInstanceOf(Refused)
    }
    expect(await files.search('not for anyone'), 'a tracked secret is not searched either').toBe('no matches')
  })
})

describe('the path rules', () => {
  it('cleans a path and refuses one that climbs out', () => {
    expect(cleanPath('./docs/INDEX.md')).toBe('docs/INDEX.md')
    expect(cleanPath('\\src\\a.ts')).toBe('src/a.ts')
    for (const bad of ['', '../a', 'docs/../../a', 'C:/x']) expect(() => cleanPath(bad), bad).toThrow(Refused)
  })

  it('knows a secret by its name', () => {
    for (const s of ['.env', 'a/.env.local', 'x.pem', 'state/anthropic.key', 'github.token', '.ssh/id_ed25519', '.npmrc']) expect(looksSecret(s), s).toBe(true)
    for (const s of ['docs/env.md', 'src/keyboard.ts', 'content/keys.level.json']) expect(looksSecret(s), s).toBe(false)
  })
})
