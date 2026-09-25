import { buildDatabase, type AssetEntry, type MaterialAsset, type Node } from '@mp/content'
import { describe, expect, it } from 'vitest'

import type { AssetLibrary } from './assetsApi'
import { assetPathsOf, libraryChanges, watchAssets } from './assetWatch'

/**
 * Other people's asset changes, as they happen (ADR 0156): which feed paths are assets, what differs between two
 * libraries, and the long poll that follows the feed through restarts and outages.
 */

const lib = (entries: AssetEntry[], materials: Record<string, MaterialAsset> = {}, prefabs: Record<string, Node> = {}, folders: string[] = []): AssetLibrary => ({
  db: buildDatabase(entries),
  folders,
  seq: 0,
  urlOf: (p) => p,
  urlOfId: () => null,
  materialOf: (id) => materials[id],
  prefabOf: (id) => prefabs[id],
  refreshPrefab: async () => undefined,
  originOf: () => undefined,
  setMaterial: () => undefined,
  fetchLive: async () => null,
  savePrefab: async () => undefined,
  createPrefab: async () => undefined,
  mkdir: async () => undefined,
  move: async () => undefined,
  remove: async () => undefined,
  createMaterial: async () => undefined,
})
const e = (id: string, kind: AssetEntry['kind'], path: string): AssetEntry => ({ id, kind, path, name: id })
const red: MaterialAsset = { shader: 'standard', params: { color: { kind: 'color', value: '#ff0000' } } }
const blue: MaterialAsset = { shader: 'standard', params: { color: { kind: 'color', value: '#0000ff' } } }

describe('what the feed names', () => {
  it('keeps the assets, as paths inside the assets folder, a sidecar as its asset', () => {
    expect(assetPathsOf(['content/keyboard/levels/a.level.json', 'content/assets/t.png', 'content/assets/t.png.meta', 'content/keyboard/game.json'])).toEqual(['t.png'])
  })
})

describe('what changed between two libraries', () => {
  const tex = e('t', 'texture', 'textures/t.png')
  const mat = e('m', 'material', 'materials/m.mat.json')

  it('nothing, when the fresh one is the same — this tab’s own write coming back', () => {
    expect(libraryChanges(lib([tex, mat], { m: red }), lib([tex, mat], { m: red }), ['materials/m.mat.json'])).toEqual({ list: false, ids: [] })
  })

  it('a material whose contents differ, and the list when an asset moved', () => {
    expect(libraryChanges(lib([mat], { m: red }), lib([mat], { m: blue }), ['materials/m.mat.json'])).toEqual({ list: false, ids: ['m'] })
    expect(libraryChanges(lib([tex]), lib([e('t', 'texture', 'textures/old/t.png')]), ['textures/t.png'])).toEqual({ list: true, ids: [] })
  })

  it('a texture the feed named at the same path, since an upload replaced its bytes', () => {
    expect(libraryChanges(lib([tex]), lib([tex]), ['textures/t.png'])).toEqual({ list: false, ids: ['t'] })
    expect(libraryChanges(lib([tex]), lib([tex]), []).ids, 'not one it did not name').toEqual([])
  })

  it('the list for a new folder or a new asset', () => {
    expect(libraryChanges(lib([]), lib([], {}, {}, ['sfx']), []).list).toBe(true)
    expect(libraryChanges(lib([]), lib([tex]), ['textures/t.png']).list).toBe(true)
  })
})

describe('following the feed', () => {
  /** A fake server: each call answers with the next scripted reply, recording what it was asked. */
  const rig = (replies: ({ status: number; body?: unknown } | Error)[]) => {
    const asked: string[] = []
    const changed: string[][] = []
    const slept: number[] = []
    let lost = 0
    let seq = 5
    let watch: { stop: () => void } | null = null
    const done = new Promise<void>((resolve) => {
      watch = watchAssets({
        seq: () => seq,
        changed: async (paths) => void changed.push(paths),
        lost: async () => {
          lost += 1
          seq = 1
        },
        fetch: async (url) => {
          asked.push(url.replace(/&timeout=\d+/, ''))
          const next = replies.shift()
          if (next === undefined) {
            watch?.stop()
            resolve()
            return new Promise(() => undefined) // a poll that never answers: the watch is over
          }
          if (next instanceof Error) throw next
          return { ok: next.status === 200, status: next.status, json: async () => next.body }
        },
        sleep: async (ms) => void slept.push(ms),
      })
    })
    return { done, asked, changed, slept, lost: () => lost }
  }

  it('asks from where the list was read, hands on asset paths only, and carries on from each answer', async () => {
    const r = rig([
      { status: 200, body: { seq: 6, paths: ['content/keyboard/levels/a.level.json'] } },
      { status: 200, body: { seq: 8, paths: ['content/assets/m.mat.json', 'content/assets/m.mat.json.meta'] } },
    ])
    await r.done
    expect(r.asked).toEqual(['/api/changes?since=5', '/api/changes?since=6', '/api/changes?since=8'])
    expect(r.changed).toEqual([['m.mat.json']])
  })

  it('reloads everything when the feed lost track, and follows on from the fresh list', async () => {
    const r = rig([{ status: 410 }, { status: 200, body: { seq: 2, paths: [] } }])
    await r.done
    expect(r.lost()).toBe(1)
    expect(r.asked).toEqual(['/api/changes?since=5', '/api/changes?since=1', '/api/changes?since=2'])
  })

  it('backs off on errors, longer each time, and starts short again after an answer', async () => {
    const r = rig([new Error('offline'), { status: 502 }, { status: 200, body: { seq: 5, paths: [] } }, new Error('offline')])
    await r.done
    expect(r.slept).toEqual([2000, 4000, 2000])
  })
})
