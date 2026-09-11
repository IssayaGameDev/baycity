import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createContentApi, keyFor } from './api'
import type { User } from './config'
import type { LockTable } from './locks'

/**
 * The API over a real socket in a scratch repo: identity comes from an `x-user` header the test sets, time from
 * a variable the test moves.
 */
const USERS: Record<string, User> = { ada: { name: 'Ada', email: 'ada@x' }, bob: { name: 'Bob', email: 'bob@x' } }

let root = ''
let server: Server
let base = ''
let now = 0
let locks: LockTable
let changed: { user: string; paths: string[] }[]
let released: string[]
let committedAll = 0

const LEVEL = { id: 'a', config: { mode: { name: 'parkour' } }, nodes: [] }

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mp-api-'))
  mkdirSync(join(root, 'content/levels'), { recursive: true })
  writeFileSync(join(root, 'content/levels/a.json'), `${JSON.stringify(LEVEL)}\n`)
  now = 0
  locks = {}
  changed = []
  released = []
  const api = createContentApi({
    repoRoot: root,
    identify: async (req) => USERS[String(req.headers['x-user'] ?? '')] ?? null,
    locks,
    rules: { staleMs: 1000, heartbeatMs: 100, maxUploadBytes: 64 },
    now: () => now,
    onChanged: (user, paths) => changed.push({ user: user.name, paths }),
    onLockReleased: (user) => released.push(user.name),
    admin: {
      token: 'secret',
      commitAll: async () => {
        committedAll++
      },
    },
  })
  server = createServer((req, res) => {
    void api(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

const call = (as: string | null, method: string, path: string, body?: unknown, raw?: Buffer): Promise<Response> => {
  const init: RequestInit = {
    method,
    headers: { ...(as === null ? {} : { 'x-user': as }), 'content-type': raw !== undefined ? 'application/octet-stream' : 'application/json' },
  }
  if (raw !== undefined) init.body = new Uint8Array(raw)
  else if (body !== undefined) init.body = JSON.stringify(body)
  return fetch(`${base}${path}`, init)
}
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T

describe('identity', () => {
  it('no identity is 401; /api/me says who you are and the rules', async () => {
    expect((await call(null, 'GET', '/api/levels')).status).toBe(401)
    const me = await json<{ user: User; heartbeatMs: number }>(await call('ada', 'GET', '/api/me'))
    expect(me.user).toEqual(USERS.ada)
    expect(me.heartbeatMs).toBe(100)
  })
})

describe('levels', () => {
  it('lists, reads, writes, and refuses a broken level', async () => {
    expect(await json(await call('ada', 'GET', '/api/levels'))).toEqual([{ name: 'a', mode: 'parkour' }])
    const ok = await call('ada', 'PUT', '/api/levels/a', { ...LEVEL, nodes: [{ id: 'n', transform: { position: { x: 0, y: 0, z: 0 } }, components: [] }] })
    expect(ok.status).toBe(200)
    expect(changed).toEqual([{ user: 'Ada', paths: [keyFor.level('a')] }])
    const bad = await call('ada', 'PUT', '/api/levels/a', { nodes: 'nope' })
    expect(bad.status).toBe(400)
    expect(JSON.parse(readFileSync(join(root, 'content/levels/a.json'), 'utf8')).nodes).toHaveLength(1)
  })
})

describe('locks', () => {
  it('a held file is read-only for everyone else until it goes stale', async () => {
    expect(await json(await call('ada', 'POST', '/api/locks/acquire', { path: keyFor.level('a') }))).toEqual({ ok: true })
    expect(await json(await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.level('a') }))).toEqual({ ok: false, owner: { name: 'Ada' } })
    const refused = await call('bob', 'PUT', '/api/levels/a', LEVEL)
    expect(refused.status).toBe(423)
    expect(await json(refused)).toEqual({ error: 'locked by Ada', owner: { name: 'Ada' } })
    expect((await call('ada', 'PUT', '/api/levels/a', LEVEL)).status).toBe(200)

    now = 900
    expect(await json(await call('ada', 'POST', '/api/locks/heartbeat', { paths: [keyFor.level('a'), 'x'] }))).toEqual({ lost: ['x'] })
    now = 1899
    expect((await call('bob', 'PUT', '/api/levels/a', LEVEL)).status).toBe(423)
    now = 1900
    expect((await call('bob', 'PUT', '/api/levels/a', LEVEL)).status).toBe(200)
    expect(await json(await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.level('a') }))).toEqual({ ok: true })
  })

  it('release reports back to the owner of sessions; status lists live locks', async () => {
    await call('ada', 'POST', '/api/locks/acquire', { path: keyFor.level('a') })
    const st = await json<{ locks: { path: string; owner: string }[] }>(await call('bob', 'GET', '/api/status'))
    expect(st.locks).toEqual([{ path: keyFor.level('a'), owner: 'Ada', since: 0 }])
    expect(await json(await call('bob', 'POST', '/api/locks/release', { path: keyFor.level('a') }))).toEqual({ ok: false })
    expect(await json(await call('ada', 'POST', '/api/locks/release', { path: keyFor.level('a') }))).toEqual({ ok: true })
    expect(released).toEqual(['Bob', 'Ada'])
    expect(locks[keyFor.level('a')]).toBeUndefined()
  })
})

describe('assets', () => {
  it('uploads a texture under the cap, replaces it keeping the id, refuses the rest', async () => {
    const png = Buffer.from('fake png bytes')
    const r = await call('ada', 'POST', '/api/assets/upload?path=textures/warn.png', undefined, png)
    expect(r.status).toBe(200)
    const { entry } = await json<{ entry: { id: string; kind: string; path: string } }>(r)
    expect(entry.kind).toBe('texture')
    expect(entry.path).toBe('textures/warn.png')
    expect(changed.flatMap((c) => c.paths)).toEqual([keyFor.asset('textures/warn.png'), keyFor.asset('textures/warn.png.meta')])

    const again = await json<{ entry: { id: string } }>(await call('ada', 'POST', '/api/assets/upload?path=textures/warn.png', undefined, Buffer.from('v2')))
    expect(again.entry.id).toBe(entry.id)
    expect(readFileSync(join(root, 'content/assets/textures/warn.png'), 'utf8')).toBe('v2')

    expect((await call('ada', 'POST', '/api/assets/upload?path=textures/x.gltf', undefined, png)).status).toBe(400)
    expect((await call('ada', 'POST', '/api/assets/upload?path=../x.png', undefined, png)).status).toBe(400)
    expect((await call('ada', 'POST', '/api/assets/upload?path=big.png', undefined, Buffer.alloc(65))).status).toBe(413)
  })

  it('a JSON asset write is gated and gets its sidecar attributed', async () => {
    await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.asset('materials/m.mat.json') })
    expect((await call('ada', 'PUT', '/assets/materials/m.mat.json', { shader: 'standard', params: {} })).status).toBe(423)
    expect((await call('bob', 'PUT', '/assets/materials/m.mat.json', { shader: 'standard', params: {} })).status).toBe(200)
    expect(changed.filter((c) => c.user === 'Bob').flatMap((c) => c.paths)).toEqual([
      keyFor.asset('materials/m.mat.json'),
      keyFor.asset('materials/m.mat.json.meta'),
    ])
  })

  it('move and delete are refused while the file — or anything in the folder — is held', async () => {
    await call('ada', 'PUT', '/assets/prefabs/p.prefab.json', { id: 'p', transform: { position: { x: 0, y: 0, z: 0 } }, components: [] })
    await call('ada', 'POST', '/api/locks/acquire', { path: keyFor.asset('prefabs/p.prefab.json') })
    expect((await call('bob', 'POST', '/api/assets/move', { from: 'prefabs/p.prefab.json', to: 'prefabs/q.prefab.json' })).status).toBe(423)
    expect((await call('bob', 'POST', '/api/assets/delete', { path: 'prefabs' })).status).toBe(423)
    expect((await call('ada', 'POST', '/api/assets/move', { from: 'prefabs/p.prefab.json', to: 'prefabs/q.prefab.json' })).status).toBe(200)
    expect(changed.at(-1)?.paths).toEqual([
      keyFor.asset('prefabs/p.prefab.json'),
      keyFor.asset('prefabs/p.prefab.json.meta'),
      keyFor.asset('prefabs/q.prefab.json'),
      keyFor.asset('prefabs/q.prefab.json.meta'),
    ])
  })
})

describe('admin', () => {
  it('commit-all needs the token and no user', async () => {
    expect((await call(null, 'POST', '/api/admin/commit-all')).status).toBe(401)
    const r = await fetch(`${base}/api/admin/commit-all`, { method: 'POST', headers: { authorization: 'Bearer secret' } })
    expect(r.status).toBe(200)
    expect(committedAll).toBe(1)
  })
})
