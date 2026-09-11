import { describe, expect, it } from 'vitest'

import { isRepoContent, planSync, readEnv } from './index'

describe('planSync', () => {
  it('downloads new and changed files, deletes vanished ones, leaves matches alone', () => {
    const plan = planSync(
      [
        { path: 'content/levels/a.json', size: 1, sha1: 'aa' },
        { path: 'content/levels/b.json', size: 1, sha1: 'bb' },
        { path: 'content/assets/t.png', size: 1, sha1: 'tt' },
      ],
      [
        { path: 'content/levels/a.json', sha1: 'aa' },
        { path: 'content/levels/b.json', sha1: 'old' },
        { path: 'content/levels/gone.json', sha1: 'gg' },
      ],
    )
    expect(plan).toEqual({ download: ['content/assets/t.png', 'content/levels/b.json'], delete: ['content/levels/gone.json'] })
  })
})

describe('readEnv', () => {
  const id = `${'a'.repeat(32)}.access`
  const secret = 'b'.repeat(64)
  const full = { MP_EDITOR_URL: 'https://editor.playgorbo.com/', MP_ACCESS_CLIENT_ID: id, MP_ACCESS_CLIENT_SECRET: secret }
  it('reads the four, defaults the root, trims the URL', () => {
    expect(readEnv(full)).toEqual({ url: 'https://editor.playgorbo.com', clientId: id, clientSecret: secret, root: '.content-live' })
    expect(readEnv({ ...full, MP_CONTENT_ROOT: 'mirror' }).root).toBe('mirror')
  })
  it('names the missing variable, and a value of the wrong shape without printing it', () => {
    expect(() => readEnv({ ...full, MP_ACCESS_CLIENT_SECRET: '' })).toThrow(/MP_ACCESS_CLIENT_SECRET/)
    expect(() => readEnv({ ...full, MP_ACCESS_CLIENT_ID: `CF-Access-Client-Id: ${id}` })).toThrow(/space or a colon/)
    expect(() => readEnv({ ...full, MP_ACCESS_CLIENT_SECRET: `${secret} ` })).toThrow(/space or a colon/)
    expect(() => readEnv({ ...full, MP_ACCESS_CLIENT_ID: 'abc' })).toThrow(/does not end in .access/)
  })
})

describe('isRepoContent', () => {
  it('spots the repo’s own content folder however it is written', () => {
    expect(isRepoContent('C:\\repo\\content', 'C:/repo')).toBe(true)
    expect(isRepoContent('/repo/content/', '/repo')).toBe(true)
    expect(isRepoContent('/repo/.content-live', '/repo')).toBe(false)
  })
})
