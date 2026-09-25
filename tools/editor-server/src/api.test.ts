import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createContentApi, keyFor } from './api'
import { levelPath } from './live'
import { createChangeFeed, type ChangeFeed } from './changes'
import type { User } from './config'
import { createLive, docKey, type Live } from './live'
import type { LockTable } from './locks'
import { createAssetIndex } from './assetIndex'
import { liveAssetFiles } from './liveAssetFiles'
import { createLiveAssets, type LiveAssets } from './liveAssets'

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
let feed: ChangeFeed
let live: Live
let liveChanged: { users: string[]; path: string }[]
let liveAssets: LiveAssets

const LEVEL = { id: 'a', config: { mode: { name: 'parkour' } }, nodes: [] }
/** A level is named `<game>/<name>` and lives in its game's folder (ADR 0108). */
const LV = 'parkour/a'
const LEVEL_FILE_REL = 'parkour/levels/a.level.json'
const LEVEL_FILE = join('content', LEVEL_FILE_REL)

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mp-api-'))
  // A game is a folder holding `game.json` and `levels/` (ADR 0108); the level is `parkour/a`.
  mkdirSync(join(root, 'content/parkour/levels'), { recursive: true })
  writeFileSync(join(root, 'content/parkour/game.json'), `${JSON.stringify({ components: [], settings: {} })}\n`)
  writeFileSync(join(root, LEVEL_FILE), `${JSON.stringify(LEVEL)}\n`)
  now = 0
  locks = {}
  changed = []
  released = []
  feed = createChangeFeed()
  liveChanged = []
  live = createLive({
    readLevel: (name) => {
      const file = join(root, levelPath(name))
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null
    },
    writeLevel: (name, level) => writeFileSync(join(root, levelPath(name)), `${JSON.stringify(level, null, 2)}\n`),
    changed: (users, path) => liveChanged.push({ users: users.map((u) => u.name), path }),
    idleMs: 20,
    maxMs: 200,
  })
  const assetIndex = createAssetIndex(join(root, 'content'))
  liveAssets = createLiveAssets({
    ...liveAssetFiles(join(root, 'content'), assetIndex),
    changed: () => {},
    connection: (connId) => live.connection(connId),
    broadcast: (event, data) => live.broadcastAll(event, data),
  })
  const api = createContentApi({
    assets: assetIndex,
    liveAssets,
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
    changes: feed,
    live,
    keepaliveMs: 50,
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
    // `mode` comes from the folder now, not from a tag inside the file (ADR 0108).
    expect(await json(await call('ada', 'GET', '/api/levels'))).toEqual([{ name: LV, mode: 'parkour', components: [] }])
    const ok = await call('ada', 'PUT', `/api/levels/${LV}`, { ...LEVEL, nodes: [{ id: 'n', transform: { position: { x: 0, y: 0, z: 0 } }, components: [] }] })
    expect(ok.status).toBe(200)
    expect(changed).toEqual([{ user: 'Ada', paths: [keyFor.level(LV)] }])
    const bad = await call('ada', 'PUT', `/api/levels/${LV}`, { nodes: 'nope' })
    expect(bad.status).toBe(400)
    expect(JSON.parse(readFileSync(join(root, LEVEL_FILE), 'utf8')).nodes).toHaveLength(1)
  })

  /** Renaming and deleting a level (ADR 0110), the pair `/api/assets/move|delete` has always had. */
  describe('rename and delete', () => {
    const renamed = join('content', 'parkour/levels/b.level.json')

    it('renames the file and makes the id follow it', async () => {
      const r = await call('ada', 'POST', '/api/levels/move', { from: LV, to: 'parkour/b' })
      expect(r.status).toBe(200)
      expect(existsSync(join(root, LEVEL_FILE)), 'the old file is gone').toBe(false)
      // A level's `id` is its file name, so a rename that left it behind would ship a lie in the file.
      expect(JSON.parse(readFileSync(join(root, renamed), 'utf8')).id).toBe('b')
      expect(changed.at(-1)).toEqual({ user: 'Ada', paths: [keyFor.level(LV), keyFor.level('parkour/b')] })
    })

    it('renames into another game, because the folder is the game', async () => {
      mkdirSync(join(root, 'content/keyboard'), { recursive: true })
      writeFileSync(join(root, 'content/keyboard/game.json'), '{"components":[],"settings":{}}\n')
      expect((await call('ada', 'POST', '/api/levels/move', { from: LV, to: 'keyboard/a' })).status).toBe(200)
      expect(existsSync(join(root, 'content/keyboard/levels/a.level.json'))).toBe(true)
    })

    it('refuses to overwrite, and refuses a name that is not qualified', async () => {
      writeFileSync(join(root, renamed), `${JSON.stringify(LEVEL)}\n`)
      const clash = await call('ada', 'POST', '/api/levels/move', { from: LV, to: 'parkour/b' })
      expect(clash.status).toBe(400)
      expect((await json<{ error: string }>(clash)).error).toContain('already exists')
      // Both files still there: a refused move moves nothing.
      expect(existsSync(join(root, LEVEL_FILE))).toBe(true)
      expect((await call('ada', 'POST', '/api/levels/move', { from: 'a', to: 'parkour/c' })).status).toBe(400)
      expect((await call('ada', 'POST', '/api/levels/move', { from: LV, to: LV })).status).toBe(400)
    })

    it('404s a level that is not there', async () => {
      expect((await call('ada', 'POST', '/api/levels/move', { from: 'parkour/nope', to: 'parkour/x' })).status).toBe(404)
      expect((await call('ada', 'POST', '/api/levels/delete', { path: 'parkour/nope' })).status).toBe(404)
    })

    it('deletes the file', async () => {
      expect((await call('ada', 'POST', '/api/levels/delete', { path: LV })).status).toBe(200)
      expect(existsSync(join(root, LEVEL_FILE))).toBe(false)
      expect(changed.at(-1)).toEqual({ user: 'Ada', paths: [keyFor.level(LV)] })
    })

    it('refuses both while the level is open live, or the next flush would undo them', async () => {
      live.join(docKey('level', LV), { connId: 'c1', user: USERS['ada']!, send: () => {} })
      expect((await call('ada', 'POST', '/api/levels/move', { from: LV, to: 'parkour/b' })).status).toBe(409)
      expect((await call('ada', 'POST', '/api/levels/delete', { path: LV })).status).toBe(409)
      expect(existsSync(join(root, LEVEL_FILE))).toBe(true)
    })

    it('is gated by the lock table like every other write', async () => {
      await call('ada', 'POST', '/api/locks/acquire', { path: keyFor.level(LV) })
      expect((await call('bob', 'POST', '/api/levels/delete', { path: LV })).status).toBe(423)
      expect((await call('bob', 'POST', '/api/levels/move', { from: LV, to: 'parkour/b' })).status).toBe(423)
      expect(existsSync(join(root, LEVEL_FILE))).toBe(true)
    })

    it('answers 405 to anything but POST, rather than reading `move` as a level name', async () => {
      expect((await call('ada', 'GET', '/api/levels/move')).status).toBe(405)
    })
  })
})

describe('locks', () => {
  it('a held file is read-only for everyone else until it goes stale', async () => {
    expect(await json(await call('ada', 'POST', '/api/locks/acquire', { path: keyFor.level(LV) }))).toEqual({ ok: true })
    expect(await json(await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.level(LV) }))).toEqual({ ok: false, owner: { name: 'Ada' } })
    const refused = await call('bob', 'PUT', `/api/levels/${LV}`, LEVEL)
    expect(refused.status).toBe(423)
    expect(await json(refused)).toEqual({ error: 'locked by Ada', owner: { name: 'Ada' } })
    expect((await call('ada', 'PUT', `/api/levels/${LV}`, LEVEL)).status).toBe(200)

    now = 900
    expect(await json(await call('ada', 'POST', '/api/locks/heartbeat', { paths: [keyFor.level(LV), 'x'] }))).toEqual({ lost: ['x'] })
    now = 1899
    expect((await call('bob', 'PUT', `/api/levels/${LV}`, LEVEL)).status).toBe(423)
    now = 1900
    expect((await call('bob', 'PUT', `/api/levels/${LV}`, LEVEL)).status).toBe(200)
    expect(await json(await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.level(LV) }))).toEqual({ ok: true })
  })

  it('release reports back to the owner of sessions; status lists live locks', async () => {
    await call('ada', 'POST', '/api/locks/acquire', { path: keyFor.level(LV) })
    const st = await json<{ locks: { path: string; owner: string }[] }>(await call('bob', 'GET', '/api/status'))
    expect(st.locks).toEqual([{ path: keyFor.level(LV), owner: 'Ada', since: 0 }])
    expect(await json(await call('bob', 'POST', '/api/locks/release', { path: keyFor.level(LV) }))).toEqual({ ok: false })
    expect(await json(await call('ada', 'POST', '/api/locks/release', { path: keyFor.level(LV) }))).toEqual({ ok: true })
    expect(released).toEqual(['Bob', 'Ada'])
    expect(locks[keyFor.level(LV)]).toBeUndefined()
  })
})

describe('assets', () => {
  it('uploads a texture under the cap, replaces it keeping the id, refuses the rest', async () => {
    const png = Buffer.from('fake png bytes')
    const r = await call('ada', 'POST', '/api/assets/upload?path=assets/textures/warn.png', undefined, png)
    expect(r.status).toBe(200)
    const { entry } = await json<{ entry: { id: string; kind: string; path: string } }>(r)
    expect(entry.kind).toBe('texture')
    expect(entry.path).toBe('assets/textures/warn.png')
    expect(changed.flatMap((c) => c.paths)).toEqual([keyFor.asset('assets/textures/warn.png'), keyFor.asset('assets/textures/warn.png.meta')])

    const again = await json<{ entry: { id: string } }>(await call('ada', 'POST', '/api/assets/upload?path=assets/textures/warn.png', undefined, Buffer.from('v2')))
    expect(again.entry.id).toBe(entry.id)
    expect(readFileSync(join(root, 'content/assets/textures/warn.png'), 'utf8')).toBe('v2')

    expect((await call('ada', 'POST', '/api/assets/upload?path=assets/textures/x.gltf', undefined, png)).status).toBe(400)
    expect((await call('ada', 'POST', '/api/assets/upload?path=../x.png', undefined, png)).status).toBe(400)
    expect((await call('ada', 'POST', '/api/assets/upload?path=assets/big.png', undefined, Buffer.alloc(65))).status).toBe(413)
  })

  it('a JSON asset write is gated and gets its sidecar attributed', async () => {
    await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.asset('assets/materials/m.mat.json') })
    expect((await call('ada', 'PUT', '/content/assets/materials/m.mat.json', { shader: 'standard', params: {} })).status).toBe(423)
    expect((await call('bob', 'PUT', '/content/assets/materials/m.mat.json', { shader: 'standard', params: {} })).status).toBe(200)
    expect(changed.filter((c) => c.user === 'Bob').flatMap((c) => c.paths)).toEqual([
      keyFor.asset('assets/materials/m.mat.json'),
      keyFor.asset('assets/materials/m.mat.json.meta'),
    ])
  })

  it('move and delete are refused while the file — or anything in the folder — is held', async () => {
    await call('ada', 'PUT', '/content/assets/prefabs/p.prefab.json', { id: 'p', transform: { position: { x: 0, y: 0, z: 0 } }, components: [] })
    await call('ada', 'POST', '/api/locks/acquire', { path: keyFor.asset('assets/prefabs/p.prefab.json') })
    expect((await call('bob', 'POST', '/api/assets/move', { from: 'assets/prefabs/p.prefab.json', to: 'assets/prefabs/q.prefab.json' })).status).toBe(423)
    expect((await call('bob', 'POST', '/api/assets/delete', { path: 'assets/prefabs' })).status).toBe(423)
    expect((await call('ada', 'POST', '/api/assets/move', { from: 'assets/prefabs/p.prefab.json', to: 'assets/prefabs/q.prefab.json' })).status).toBe(200)
    expect(changed.at(-1)?.paths).toEqual([
      keyFor.asset('assets/prefabs/p.prefab.json'),
      keyFor.asset('assets/prefabs/p.prefab.json.meta'),
      keyFor.asset('assets/prefabs/q.prefab.json'),
      keyFor.asset('assets/prefabs/q.prefab.json.meta'),
    ])
  })
})

describe('several at once (ADR 0166)', () => {
  it('moves several into a folder, or none of them when one cannot go', async () => {
    for (const n of ['a', 'b', 'c']) await call('ada', 'PUT', `/content/assets/materials/${n}.mat.json`, { shader: 'standard', params: {} })
    mkdirSync(join(root, 'content/assets/old'), { recursive: true })
    writeFileSync(join(root, 'content/assets/old/c.mat.json'), '{"shader":"standard","params":{}}')
    const into = (n: string, dir: string) => ({ from: `assets/materials/${n}.mat.json`, to: `assets/${dir}/${n}.mat.json` })
    const clash = await call('ada', 'POST', '/api/assets/move', { moves: [into('a', 'old'), into('c', 'old')] })
    expect(clash.status, 'c is there already').toBe(400)
    expect(existsSync(join(root, 'content/assets/materials/a.mat.json')), 'so a stayed too').toBe(true)
    await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.asset('assets/materials/b.mat.json') })
    expect((await call('ada', 'POST', '/api/assets/move', { moves: [into('a', 'old'), into('b', 'old')] })).status, 'b is held').toBe(423)
    expect(existsSync(join(root, 'content/assets/materials/a.mat.json'))).toBe(true)
    await call('bob', 'POST', '/api/locks/release', { path: keyFor.asset('assets/materials/b.mat.json') })
    expect((await call('ada', 'POST', '/api/assets/move', { moves: [into('a', 'old'), into('b', 'old')] })).status).toBe(200)
    expect(['a', 'b'].map((n) => existsSync(join(root, `content/assets/old/${n}.mat.json`)))).toEqual([true, true])
  })

  it('deletes several, or none of them while anyone holds one', async () => {
    for (const n of ['a', 'b']) await call('ada', 'PUT', `/content/assets/materials/${n}.mat.json`, { shader: 'standard', params: {} })
    const paths = ['assets/materials/a.mat.json', 'assets/materials/b.mat.json']
    await call('bob', 'POST', '/api/locks/acquire', { path: keyFor.asset(paths[1]!) })
    expect((await call('ada', 'POST', '/api/assets/delete', { paths })).status).toBe(423)
    expect(existsSync(join(root, 'content', paths[0]!)), 'a stayed').toBe(true)
    await call('bob', 'POST', '/api/locks/release', { path: keyFor.asset(paths[1]!) })
    expect((await call('ada', 'POST', '/api/assets/delete', { paths })).status).toBe(200)
    expect(paths.map((p) => existsSync(join(root, 'content', p)))).toEqual([false, false])
  })
})

describe('what the asset Inspector asks (ADR 0165)', () => {
  it('lists each file with its size and date, and says who uses an asset, directly or through another', async () => {
    await call('ada', 'PUT', '/content/assets/materials/m.mat.json', { shader: 'standard', params: {} })
    const listed = await json<{ entries: { id: string; path: string }[]; files: Record<string, { bytes: number; modified: number }> }>(await call('ada', 'GET', '/api/assets'))
    const material = listed.entries.find((e) => e.path === 'assets/materials/m.mat.json')!
    expect(listed.files['assets/materials/m.mat.json']!.bytes).toBe(readFileSync(join(root, 'content/assets/materials/m.mat.json')).length)
    expect(listed.files['assets/materials/m.mat.json']!.modified).toBeGreaterThan(0)

    const prefab = { id: 'p', transform: { position: { x: 0, y: 0, z: 0 } }, components: [{ id: 'r', type: 'Renderer', params: { material: material.id } }] }
    await call('ada', 'PUT', '/content/assets/prefabs/p.prefab.json', prefab)
    const pad = (await json<{ entries: { id: string; path: string }[] }>(await call('ada', 'GET', '/api/assets'))).entries.find((e) => e.path === 'assets/prefabs/p.prefab.json')!
    writeFileSync(join(root, LEVEL_FILE), `${JSON.stringify({ ...LEVEL, nodes: [{ id: 'n', prefab: pad.id, transform: { position: { x: 0, y: 0, z: 0 } }, components: [] }] })}
`)

    expect(await json(await call('ada', 'GET', `/api/assets/users?id=${material.id}`))).toEqual({ levels: [LV], assets: [pad.id] })
    expect(await json(await call('ada', 'GET', `/api/assets/users?id=${pad.id}`))).toEqual({ levels: [LV], assets: [] })
    expect((await call('ada', 'GET', '/api/assets/users?id=0000000000000000')).status).toBe(404)
  })
})

describe('a material edited live (ADR 0159)', () => {
  it('takes an edit on a room connection, sends it to everyone, serves the live copy and refuses a PUT over it', async () => {
    await call('ada', 'PUT', '/content/assets/materials/m.mat.json', { shader: 'standard', params: { color: { kind: 'color', value: '#ff0000' } } })
    const id = (await json<{ entries: { id: string; path: string }[] }>(await call('ada', 'GET', '/api/assets'))).entries.find((e) => e.path === 'assets/materials/m.mat.json')!.id
    const events: { event: string; data: unknown }[] = []
    live.join(LV, { connId: 'c-ada', user: USERS.ada!, send: (event, data) => void events.push({ event, data }) })

    const before = await call('bob', 'GET', '/content/assets/materials/m.mat.json')
    expect(before.headers.get('x-asset-seq'), 'the file, before any live edit').toBe('0')

    const r = await call('ada', 'POST', `/api/live/asset/${id}/ops`, { connId: 'c-ada', batchId: 'b1', ops: [{ kind: 'set', path: ['params', 'color', 'value'], value: '#00ff00' }] })
    expect(await json(r)).toEqual({ ok: true, seq: 1 })
    expect(events.at(-1)).toMatchObject({ event: 'asset', data: { assetId: id, seq: 1, from: 'c-ada', batchId: 'b1' } })

    const after = await call('bob', 'GET', '/content/assets/materials/m.mat.json')
    expect(after.headers.get('x-asset-seq')).toBe('1')
    expect((await json<{ params: { color: { value: string } } }>(after)).params.color.value, 'the live copy, ahead of the file').toBe('#00ff00')
    expect((await call('bob', 'PUT', '/content/assets/materials/m.mat.json', { shader: 'standard', params: {} })).status).toBe(409)

    expect((await call('ada', 'POST', `/api/live/asset/${id}/ops`, { connId: 'c-ada', batchId: 'b2', ops: [{ kind: 'nope' }] })).status, 'not asset ops').toBe(400)
    expect((await call('bob', 'POST', `/api/live/asset/${id}/ops`, { connId: 'c-ada', batchId: 'b3', ops: [] })).status, 'not Bob’s connection').toBe(400)
  })
})

describe('a game’s data file edited live (ADR 0162)', () => {
  it('takes an edit on a room connection, sends it to everyone, serves the live copy, writes it behind and refuses a PUT over it', async () => {
    const events: { event: string; data: unknown }[] = []
    live.join(LV, { connId: 'c-ada', user: USERS.ada!, send: (event, data) => void events.push({ event, data }) })

    const before = await call('bob', 'GET', '/api/games/parkour')
    expect(before.headers.get('x-asset-seq'), 'the file, before any live edit').toBe('0')

    const r = await call('ada', 'POST', '/api/live/game/parkour/ops', { connId: 'c-ada', batchId: 'b1', ops: [{ kind: 'set', path: ['settings', 'speed'], value: 3 }] })
    expect(await json(r)).toEqual({ ok: true, seq: 1 })
    expect(events.at(-1)).toMatchObject({ event: 'asset', data: { assetId: 'game:parkour', seq: 1, from: 'c-ada', batchId: 'b1' } })

    const after = await call('bob', 'GET', '/api/games/parkour')
    expect(after.headers.get('x-asset-seq')).toBe('1')
    expect(await json(after), 'the live copy, ahead of the file').toEqual({ components: [], settings: { speed: 3 } })
    expect((await call('bob', 'PUT', '/api/games/parkour', { components: [] })).status).toBe(409)

    const bad = await call('ada', 'POST', '/api/live/game/parkour/ops', { connId: 'c-ada', batchId: 'b2', ops: [{ kind: 'set', path: ['settings', 'speed'], value: 'fast' }] })
    expect(bad.status, 'a file no game could read').toBe(400)
    expect((await call('ada', 'POST', '/api/live/game/nope/ops', { connId: 'c-ada', batchId: 'b3', ops: [] })).status, 'no such game').toBe(404)

    liveAssets.flushAll()
    expect(JSON.parse(readFileSync(join(root, 'content/parkour/game.json'), 'utf8'))).toEqual({ components: [], settings: { speed: 3 } })
  })
})

describe('the asset list and the feed (ADR 0156)', () => {
  it('says where the feed stood, so a watch from there sees the next write and nothing before it', async () => {
    await call('ada', 'POST', '/api/assets/upload?path=assets/textures/t.png', undefined, Buffer.from('png'))
    const list = await json<{ entries: { path: string }[]; seq: number }>(await call('bob', 'GET', '/api/assets'))
    expect(list.seq).toBe(feed.seq())
    expect(list.entries.map((e) => e.path)).toEqual(['assets/textures/t.png'])
    await call('ada', 'PUT', '/content/assets/materials/m.mat.json', { shader: 'standard', params: {} })
    const ch = await json<{ seq: number; paths: string[] }>(await call('bob', 'GET', `/api/changes?since=${list.seq}&timeout=10`))
    expect(ch.paths.sort()).toEqual([keyFor.asset('assets/materials/m.mat.json'), keyFor.asset('assets/materials/m.mat.json.meta')])
  })

  it('lists a file moved through the API where it went', async () => {
    await call('ada', 'POST', '/api/assets/upload?path=assets/textures/t.png', undefined, Buffer.from('png'))
    await call('ada', 'POST', '/api/assets/move', { from: 'assets/textures/t.png', to: 'assets/textures/old/t.png' })
    const list = await json<{ entries: { path: string }[] }>(await call('bob', 'GET', '/api/assets'))
    expect(list.entries.map((e) => e.path)).toEqual(['assets/textures/old/t.png'])
  })
})

describe('mirror feed', () => {
  it('tree lists every content file with a hash; changes fold writes; file serves bytes and 404s the gone', async () => {
    const t0 = await json<{ seq: number; files: { path: string; sha1: string; size: number }[] }>(await call('ada', 'GET', '/api/tree'))
    expect(t0.seq).toBe(0)
    expect(t0.files.map((f) => f.path)).toEqual(['content/parkour/game.json', `content/${LEVEL_FILE_REL}`])
    expect(t0.files[0]!.sha1).toHaveLength(40)

    await call('ada', 'PUT', `/api/levels/${LV}`, LEVEL)
    await call('ada', 'POST', '/api/assets/upload?path=assets/textures/t.png', undefined, Buffer.from('png'))
    const ch = await json<{ seq: number; paths: string[] }>(await call('bob', 'GET', '/api/changes?since=0&timeout=10'))
    expect(ch.seq).toBe(3)
    expect(ch.paths.sort()).toEqual([keyFor.asset('assets/textures/t.png'), keyFor.asset('assets/textures/t.png.meta'), keyFor.level(LV)])
    expect(await json(await call('bob', 'GET', `/api/changes?since=${ch.seq}&timeout=10`))).toEqual({ seq: 3, paths: [] })

    const f = await call('bob', 'GET', `/api/file?path=${encodeURIComponent(keyFor.asset('assets/textures/t.png'))}`)
    expect(f.status).toBe(200)
    expect(Buffer.from(await f.arrayBuffer()).toString()).toBe('png')
    expect((await call('bob', 'GET', '/api/file?path=content/parkour/levels/nope.level.json')).status).toBe(404)
    expect((await call('bob', 'GET', '/api/file?path=../package.json')).status).toBe(400)
    expect((await call('bob', 'GET', '/api/file?path=content/../package.json')).status).toBe(400)
  })

  it('a folder move or delete is reported as the files it touched', async () => {
    await call('ada', 'POST', '/api/assets/upload?path=assets/tex/a.png', undefined, Buffer.from('a'))
    await call('ada', 'POST', '/api/assets/upload?path=assets/tex/deep/b.png', undefined, Buffer.from('b'))
    const before = feed.seq()
    await call('ada', 'POST', '/api/assets/move', { from: 'assets/tex', to: 'assets/art' })
    const moved = feed.since(before)!
    expect(moved.paths.sort()).toEqual(
      ['tex/a.png', 'tex/a.png.meta', 'tex/deep/b.png', 'tex/deep/b.png.meta', 'art/a.png', 'art/a.png.meta', 'art/deep/b.png', 'art/deep/b.png.meta'].map((p) => keyFor.asset(`assets/${p}`)).sort(),
    )
    const mid = feed.seq()
    await call('ada', 'POST', '/api/assets/delete', { path: 'assets/art/deep' })
    expect(feed.since(mid)!.paths.sort()).toEqual([keyFor.asset('assets/art/deep/b.png'), keyFor.asset('assets/art/deep/b.png.meta')])
    // The tree agrees with what the feed said.
    const tree = await json<{ files: { path: string }[] }>(await call('ada', 'GET', '/api/tree'))
    expect(tree.files.map((f) => f.path).filter((p) => p.includes('art/'))).toEqual([keyFor.asset('assets/art/a.png'), keyFor.asset('assets/art/a.png.meta')])
  })
})

/** One reader per stream: SSE frames are taken off it as tests need them. */
const sseReader = (r: Response): { take: (count: number) => Promise<{ event: string; data: unknown; id?: number }[]> } => {
  const reader = r.body!.getReader()
  let buf = ''
  const queue: { event: string; data: unknown; id?: number }[] = []
  const pump = async (): Promise<boolean> => {
    const { value, done } = await reader.read()
    if (done) return false
    buf += new TextDecoder().decode(value)
    let at: number
    while ((at = buf.indexOf(String.fromCharCode(10, 10))) >= 0) {
      const frame = buf.slice(0, at)
      buf = buf.slice(at + 2)
      if (frame.startsWith(':')) continue
      // Who is in which room goes to everyone on every join and leave (ADR 0162); tested on its own in live.test.ts.
      if (frame.includes('event: rooms')) continue
      const fields = Object.fromEntries(frame.split(String.fromCharCode(10)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]))
      const e: { event: string; data: unknown; id?: number } = { event: fields.event ?? '', data: JSON.parse(fields.data ?? 'null') }
      if (fields.id !== undefined) e.id = Number(fields.id)
      queue.push(e)
    }
    return true
  }
  return {
    take: async (count) => {
      while (queue.length < count) if (!(await pump())) break
      return queue.splice(0, count)
    },
  }
}

describe('live editing over the wire', () => {
  /**
   * Hiding travels the room (ADR 0132), and the route is a **fixed alternation** of actions at the end of
   * the path, which is how a level name carrying a slash is told from the action after it. Adding the
   * handler without adding the word to that alternation shipped a 404 to the box: the switch was right and
   * the URL never reached it. This walks the whole way, which is the only level that would have caught it.
   */
  it('hides nodes for everyone, and says so on the stream', async () => {
    const ctrl = new AbortController()
    const stream = await fetch(`${base}/api/live/level/${LV}/events`, { headers: { 'x-user': 'ada' }, signal: ctrl.signal })
    const sse = sseReader(stream)
    const [hello, snapshot] = await sse.take(2)
    const connId = (hello!.data as { connId: string }).connId
    expect((snapshot!.data as { hidden?: string[] }).hidden, 'the snapshot carries it, so the first paint is right').toEqual([])

    const hide = await call('ada', 'POST', `/api/live/level/${LV}/hidden`, { connId, keys: ['n:n1', 'i:p1:n2'], hidden: true })
    expect(hide.status, 'a 404 here is the route alternation, not the handler').toBe(200)
    const [event] = await sse.take(1)
    expect(event!.event).toBe('hidden')
    expect((event!.data as { hidden: string[] }).hidden).toEqual(['n:n1', 'i:p1:n2'])
    expect(event!.id, 'a view of the level takes no sequence number').toBeUndefined()

    const show = await call('ada', 'POST', `/api/live/level/${LV}/hidden`, { connId, keys: ['n:n1'], hidden: false })
    expect(show.status).toBe(200)
    const [back] = await sse.take(1)
    expect((back!.data as { hidden: string[] }).hidden, 'the whole set every time, never a delta').toEqual(['i:p1:n2'])
    ctrl.abort()
  })
  it('streams hello + snapshot, applies a batch and echoes it with the seq, serves the live copy, refuses a PUT', async () => {
    const ctrl = new AbortController()
    const stream = await fetch(`${base}/api/live/level/${LV}/events`, { headers: { 'x-user': 'ada' }, signal: ctrl.signal })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const sse = sseReader(stream)
    const [hello, snapshot] = await sse.take(2)
    expect(hello!.event).toBe('hello')
    const connId = (hello!.data as { connId: string }).connId
    expect(snapshot!.event).toBe('snapshot')
    expect((snapshot!.data as { seq: number }).seq).toBe(0)

    const r = await call('ada', 'POST', `/api/live/level/${LV}/ops`, { connId, batchId: 'b1', ops: [{ kind: 'setName', id: 'a', name: 'A' }] })
    expect(r.status).toBe(400) // 'a' is the level id, not a node: the fixture has no nodes
    const put = await call('ada', 'PUT', `/api/levels/${LV}`, LEVEL)
    expect(put.status).toBe(409)

    const ok = await call('ada', 'POST', `/api/live/level/${LV}/ops`, {
      connId,
      batchId: 'b2',
      ops: [{ kind: 'insertNode', parent: null, index: 0, node: { id: 'n1', transform: { position: { x: 0, y: 0, z: 0 } }, components: [] } }],
    })
    expect(await json(ok)).toEqual({ ok: true, seq: 1 })
    const [echo] = await sse.take(1)
    expect(echo!.event).toBe('ops')
    expect(echo!.id).toBe(1)
    expect((echo!.data as { from: string; batchId: string }).batchId).toBe('b2')
    const served = await json<{ nodes: unknown[] }>(await call('bob', 'GET', `/api/levels/${LV}`))
    expect(served.nodes).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(root, LEVEL_FILE), 'utf8')).nodes, 'not on disk yet').toHaveLength(0)

    // Foreign connection, wrong person.
    expect((await call('bob', 'POST', `/api/live/level/${LV}/ops`, { connId, batchId: 'x', ops: [] })).status).toBe(400)

    // Flush writes and reports the contributor; the mirror's tree flushes too.
    await call('ada', 'POST', `/api/live/level/${LV}/flush`, { connId })
    expect(JSON.parse(readFileSync(join(root, LEVEL_FILE), 'utf8')).nodes).toHaveLength(1)
    expect(liveChanged).toEqual([{ users: ['Ada'], path: `content/${LEVEL_FILE_REL}` }])

    const status = await json<{ docs: { name: string; peers: { name: string }[] }[] }>(await call('bob', 'GET', '/api/live'))
    expect(status.docs[0]!.peers.map((p) => p.name)).toEqual(['Ada'])

    ctrl.abort()
    await new Promise((r) => setTimeout(r, 30))
    expect(live.isOpen('a'), 'the stream closing is the leave').toBe(false)
  })

  it('a level that is not there is a 404, not a stream', async () => {
    const r = await call('ada', 'GET', '/api/live/level/parkour/nope/events')
    expect(r.status).toBe(404)
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

describe('asset libraries (ADR 0161)', () => {
  it('reaches only paths inside a library: never a level, a game.json, or a library’s own folder', async () => {
    const png = Buffer.from('png')
    expect((await call('ada', 'POST', '/api/assets/upload?path=parkour/levels/x.png', undefined, png)).status).toBe(400)
    expect((await call('ada', 'POST', '/api/assets/upload?path=textures/x.png', undefined, png)).status, 'no library at all').toBe(400)
    expect((await call('ada', 'GET', '/content/parkour/game.json')).status).toBe(404)
    expect((await call('ada', 'GET', `/content/${LEVEL_FILE_REL}`)).status).toBe(404)
    expect((await call('ada', 'POST', '/api/assets/delete', { path: 'parkour' })).status).toBe(400)
    expect((await call('ada', 'POST', '/api/assets/delete', { path: 'assets' })).status, 'a library itself').toBe(400)
    expect((await call('ada', 'POST', '/api/assets/mkdir', { path: 'nope/assets/x' })).status, 'a game that does not exist').toBe(400)
    expect(existsSync(join(root, LEVEL_FILE)), 'the level is untouched').toBe(true)
  })

  it('gives a game its own library beside the shared one', async () => {
    expect((await call('ada', 'POST', '/api/assets/mkdir', { path: 'parkour/assets/textures' })).status).toBe(200)
    const up = await json<{ entry: { path: string } }>(await call('ada', 'POST', '/api/assets/upload?path=parkour/assets/textures/p.png', undefined, Buffer.from('png')))
    expect(up.entry.path).toBe('parkour/assets/textures/p.png')
    expect(await (await call('bob', 'GET', '/content/parkour/assets/textures/p.png')).text()).toBe('png')
    const list = await json<{ libraries: string[]; folders: string[] }>(await call('ada', 'GET', '/api/assets'))
    expect(list.libraries).toEqual(['assets', 'parkour/assets'])
    expect(list.folders).toContain('parkour/assets/textures')
    expect(changed.flatMap((c) => c.paths)).toContain('content/parkour/assets/textures/p.png')
  })

  it('moves between libraries only when nothing is left using what it may not', async () => {
    // A Shared texture, a Shared material drawn with it, and the parkour level using the material.
    await call('ada', 'POST', '/api/assets/upload?path=assets/textures/t.png', undefined, Buffer.from('png'))
    const idOf = async (path: string): Promise<string> =>
      (await json<{ entries: { id: string; path: string }[] }>(await call('ada', 'GET', '/api/assets'))).entries.find((e) => e.path === path)!.id
    const t = await idOf('assets/textures/t.png')
    await call('ada', 'PUT', '/content/assets/materials/m.mat.json', { shader: 'standard', params: { map: { kind: 'texture', value: t } } })
    const m = await idOf('assets/materials/m.mat.json')
    const usingM = { ...LEVEL, nodes: [{ id: 'n', transform: { position: { x: 0, y: 0, z: 0 } }, components: [{ id: 'r', type: 'Renderer', params: { material: m } }] }] }
    writeFileSync(join(root, LEVEL_FILE), JSON.stringify(usingM))
    mkdirSync(join(root, 'content/keyboard'), { recursive: true })
    writeFileSync(join(root, 'content/keyboard/game.json'), '{"components":[]}')

    const intoKeyboard = await call('ada', 'POST', '/api/assets/move', { from: 'assets/materials/m.mat.json', to: 'keyboard/assets/materials/m.mat.json' })
    expect(intoKeyboard.status).toBe(409)
    expect((await json<{ error: string }>(intoKeyboard)).error).toBe('not moved into keyboard: used by 1 parkour level')
    const texture = await call('ada', 'POST', '/api/assets/move', { from: 'assets/textures/t.png', to: 'keyboard/assets/textures/t.png' })
    expect((await json<{ error: string }>(texture)).error, 'through the material').toBe('not moved into keyboard: used by 1 parkour level')

    // Into the game whose level it is: the texture it uses stays in Shared, which any game may use.
    expect((await call('ada', 'POST', '/api/assets/move', { from: 'assets/materials/m.mat.json', to: 'parkour/assets/materials/m.mat.json' })).status).toBe(200)
    expect(await idOf('parkour/assets/materials/m.mat.json'), 'the id went with it').toBe(m)
    // The texture may follow it: everything using it is Parkour's now.
    expect((await call('ada', 'POST', '/api/assets/move', { from: 'assets/textures/t.png', to: 'parkour/assets/textures/t.png' })).status).toBe(200)
    // Back to Shared alone, it would need Parkour's texture: refused.
    expect((await call('ada', 'POST', '/api/assets/move', { from: 'parkour/assets/materials/m.mat.json', to: 'assets/materials/m.mat.json' })).status, "uses Parkour's texture").toBe(409)
    expect((await call('ada', 'POST', '/api/assets/move', { from: 'parkour/assets', to: 'assets/from-parkour' })).status, 'a library itself does not move').toBe(400)
  })
})

describe('moving a level to another game (ADR 0162)', () => {
  it('moves the file, keeps the tag in step, and refuses while it uses its old game’s own assets', async () => {
    mkdirSync(join(root, 'content/keyboard'), { recursive: true })
    writeFileSync(join(root, 'content/keyboard/game.json'), '{"components":[]}')
    // A texture in Parkour's own library, and the level using it by id.
    await call('ada', 'POST', '/api/assets/upload?path=parkour/assets/textures/own.png', undefined, Buffer.from('png'))
    const own = (await json<{ entries: { id: string; path: string }[] }>(await call('ada', 'GET', '/api/assets'))).entries.find((e) => e.path === 'parkour/assets/textures/own.png')!.id
    const using = { ...LEVEL, config: { mode: { name: 'parkour' }, sky: own } }
    writeFileSync(join(root, LEVEL_FILE), JSON.stringify(using))

    const refused = await call('ada', 'POST', '/api/levels/move', { from: LV, to: 'keyboard/a' })
    expect(refused.status).toBe(409)
    expect((await json<{ error: string }>(refused)).error).toBe("parkour/a not moved to keyboard: it uses parkour's own texture own: move it into Shared first")

    writeFileSync(join(root, LEVEL_FILE), JSON.stringify(LEVEL))
    expect((await call('ada', 'POST', '/api/levels/move', { from: LV, to: 'keyboard/a' })).status).toBe(200)
    const moved = JSON.parse(readFileSync(join(root, 'content/keyboard/levels/a.level.json'), 'utf8')) as { config: { mode: { name: string } } }
    expect(moved.config.mode.name, 'the tag says what the folder says').toBe('keyboard')
    expect(existsSync(join(root, LEVEL_FILE))).toBe(false)
  })

  it('lists the component types a level uses, through its prefabs too', async () => {
    const withTypes = { ...LEVEL, nodes: [{ id: 'n', transform: { position: { x: 0, y: 0, z: 0 } }, components: [{ id: 'c', type: 'Hazard', params: {} }] }] }
    writeFileSync(join(root, LEVEL_FILE), JSON.stringify(withTypes))
    expect(await json(await call('ada', 'GET', '/api/levels'))).toEqual([{ name: LV, mode: 'parkour', components: ['Hazard'] }])
  })
})
