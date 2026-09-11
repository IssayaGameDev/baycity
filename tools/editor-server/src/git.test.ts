import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { changedUnder, commitPaths, git } from './git'

const A = { name: 'Ada Lovelace', email: 'ada@example.com' }
const SERVER = { name: 'Editor Server', email: 'editor@localhost' }

let repo = ''
const write = (rel: string, body: string): void => {
  const full = join(repo, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'mp-git-'))
  await git(repo, ['init', '--quiet', '--initial-branch=content'])
  await git(repo, ['config', 'user.name', 'seed'])
  await git(repo, ['config', 'user.email', 'seed@x'])
  write('content/levels/a.json', '{"a":1}\n')
  write('content/levels/b.json', '{"b":1}\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--quiet', '-m', 'seed'])
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('commitPaths', () => {
  it('commits only the named paths, as the author, leaving other dirty files alone', async () => {
    write('content/levels/a.json', '{"a":2}\n')
    write('content/levels/b.json', '{"b":2}\n')
    write('content/assets/t.png', 'png')
    write('content/assets/t.png.meta', '{"id":"x"}')

    const r = await commitPaths(repo, {
      paths: ['content/levels/a.json', 'content/assets/t.png', 'content/assets/t.png.meta'],
      author: A,
      committer: SERVER,
      message: 'Edit level a and 1 more',
    })
    expect(r.committed).toBe(true)
    expect(r.committed && r.paths.sort()).toEqual(['content/assets/t.png', 'content/assets/t.png.meta', 'content/levels/a.json'])

    const log = (await git(repo, ['log', '-1', '--format=%an|%ae|%cn|%s'])).trim()
    expect(log).toBe('Ada Lovelace|ada@example.com|Editor Server|Edit level a and 1 more')
    // b.json is still dirty and uncommitted: someone else's session.
    expect(await changedUnder(repo, ['content'])).toEqual(['content/levels/b.json'])
  })

  it('commits a deletion', async () => {
    rmSync(join(repo, 'content/levels/b.json'))
    const r = await commitPaths(repo, { paths: ['content/levels/b.json'], author: A, committer: SERVER, message: 'Edit level b' })
    expect(r.committed).toBe(true)
    expect((await git(repo, ['ls-files', 'content/levels'])).trim()).toBe('content/levels/a.json')
  })

  it('a folder path covers everything under it', async () => {
    write('content/assets/deep/x.png', 'x')
    write('content/assets/deep/y.png', 'y')
    const r = await commitPaths(repo, { paths: ['content/assets/deep'], author: A, committer: SERVER, message: 'm' })
    expect(r.committed && r.paths.length).toBe(2)
  })

  it('does nothing when the paths did not change', async () => {
    write('content/levels/a.json', '{"a":1}\n')
    const r = await commitPaths(repo, { paths: ['content/levels/a.json', 'content/levels/nope.json'], author: A, committer: SERVER, message: 'm' })
    expect(r).toEqual({ committed: false })
    expect((await git(repo, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1')
  })
})
