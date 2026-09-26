import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { diskContent, diskResponse, gameContent } from '../../../game-content'

/**
 * A game's content as its page reads it (ADR 0169): one level's list at a time, from the game's own library and
 * Shared's only; the dev server answering from disk; a build writing the same addresses as files.
 */

let root = ''
const write = (path: string, body: unknown = 'x'): void => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body))
}
/** An asset and its sidecar. */
const asset = (path: string, id: string, body: unknown = 'x'): void => {
  write(path, body)
  write(`${path}.meta`, { id, kind: 'texture' })
}

const RED = 'aaaaaaaaaaaaaaaa'
const BRICK = 'bbbbbbbbbbbbbbbb'
const PAD = 'cccccccccccccccc'
const UNUSED = 'dddddddddddddddd'
const OTHER = 'eeeeeeeeeeeeeeee'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-game-content-'))
  for (const g of ['keyboard', 'parkour']) write(`${g}/game.json`, { components: [] })
  // Keyboard's `default` places its own pad, drawn with a Shared material that has a Shared texture; `bare` uses nothing.
  write('keyboard/levels/default.level.json', { id: 'default', config: {}, nodes: [{ id: 'p', prefab: PAD, components: [] }] })
  write('keyboard/levels/bare.level.json', { id: 'bare', config: {}, nodes: [] })
  write('parkour/levels/default.level.json', { id: 'default', config: {}, nodes: [] })
  asset('keyboard/assets/prefabs/pad.prefab.json', PAD, { id: 'root', components: [{ id: 'r', type: 'Renderer', params: { material: RED } }] })
  asset('assets/materials/red.mat.json', RED, { shader: 'standard', params: { map: { kind: 'texture', value: BRICK } } })
  asset('assets/textures/brick.png', BRICK)
  asset('assets/textures/unused.png', UNUSED)
  asset('parkour/assets/textures/other.png', OTHER)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const at = (path: string): string => `content/${path}`

describe('a game’s content on disk', () => {
  it('indexes its own levels, default first', () => {
    expect(diskContent(root, 'keyboard').index()).toEqual({ levels: ['default', 'bare'], default: 'default' })
    expect(diskContent(root, 'parkour').index().levels).toEqual(['default'])
  })

  it('lists for a level what it uses, through the prefab and the material', () => {
    const needs = diskContent(root, 'keyboard').needs('default', at)
    expect(needs.level).toBe('content/keyboard/levels/default.level.json')
    expect(needs.assets.map((a) => a.path)).toEqual(['assets/materials/red.mat.json', 'assets/textures/brick.png', 'keyboard/assets/prefabs/pad.prefab.json'])
  })

  it('lists nothing of another level’s', () => {
    expect(diskContent(root, 'keyboard').needs('bare', at).assets).toEqual([])
  })

  it('knows only its own library and Shared’s', () => {
    const paths = [...diskContent(root, 'keyboard').assets().values()].map((e) => e.path)
    expect(paths).toContain('assets/textures/unused.png')
    expect(paths).not.toContain('parkour/assets/textures/other.png')
  })
})

describe('what the local dev server answers', () => {
  const text = (rel: string): string | null => {
    const r = diskResponse(root, 'keyboard', rel)
    return r === null ? null : r.body.toString()
  }

  it('the index, a list and a level', () => {
    expect(JSON.parse(text('keyboard/levels.json') ?? 'null')).toEqual({ levels: ['default', 'bare'], default: 'default' })
    expect(JSON.parse(text('keyboard/levels/bare.needs.json') ?? 'null')).toEqual({ level: 'content/keyboard/levels/bare.level.json', assets: [] })
    expect(JSON.parse(text('keyboard/levels/default.needs.json') ?? 'null').assets).toContainEqual(expect.objectContaining({ id: BRICK, url: at('assets/textures/brick.png') }))
    expect(JSON.parse(text('keyboard/levels/bare.level.json') ?? 'null')).toEqual({ id: 'bare', config: {}, nodes: [] })
    expect(diskResponse(root, 'keyboard', 'assets/materials/red.mat.json')?.type).toBe('application/json')
  })

  it('a file in its own library or Shared’s, with its type', () => {
    expect(diskResponse(root, 'keyboard', 'assets/textures/brick.png')?.type).toBe('image/png')
    expect(text('keyboard/assets/prefabs/pad.prefab.json')).toContain('Renderer')
  })

  it('nothing of another game’s, nothing outside a library, nothing that is not there', () => {
    for (const rel of [
      'parkour/levels.json',
      'parkour/levels/default.needs.json',
      'parkour/levels/default.level.json',
      'parkour/assets/textures/other.png',
      'keyboard/game.json',
      'keyboard/levels/nope.needs.json',
      'assets/textures/nope.png',
      'assets/../keyboard/game.json',
    ]) {
      expect(diskResponse(root, 'keyboard', rel), rel).toBeNull()
    }
  })
})

describe('what a build writes', () => {
  /** Runs the plugin's two build hooks against a stand-in for Rollup, which names a file `assets/<name>-h`. */
  const build = (): Map<string, string | Uint8Array> => {
    const plugin = gameContent('keyboard', { root })
    const out = new Map<string, string | Uint8Array>()
    const names = new Map<string, string>()
    const ctx = {
      emitFile: (f: { name?: string; fileName?: string; source: string | Uint8Array }) => {
        const fileName = f.fileName ?? `assets/${f.name ?? 'file'}-h`
        out.set(fileName, f.source)
        names.set(fileName, fileName)
        return fileName
      },
      getFileName: (ref: string) => names.get(ref) ?? '',
      error: (message: string): never => {
        throw new Error(message)
      },
    }
    plugin.configResolved({ command: 'build', base: './' })
    plugin.buildStart.call(ctx)
    plugin.generateBundle.call(ctx)
    return out
  }

  it('every level and every file some level uses, and nothing else', () => {
    const files = [...build().keys()].filter((f) => f.startsWith('assets/')).sort()
    expect(files).toEqual(['assets/bare.level.json-h', 'assets/brick.png-h', 'assets/default.level.json-h', 'assets/pad.prefab.json-h', 'assets/red.mat.json-h'])
  })

  it('the index and each level’s list at the addresses the page asks for, pointing at the written files', () => {
    const out = build()
    expect(JSON.parse(String(out.get('content/keyboard/levels.json')))).toEqual({ levels: ['default', 'bare'], default: 'default' })
    const needs = JSON.parse(String(out.get('content/keyboard/levels/default.needs.json'))) as { level: string; assets: { path: string; url: string }[] }
    expect(needs.level).toBe('assets/default.level.json-h')
    expect(needs.assets.find((a) => a.path === 'assets/textures/brick.png')?.url).toBe('assets/brick.png-h')
  })

  it('refuses to build a level that will not parse', () => {
    write('keyboard/levels/broken.level.json', '{ nope')
    expect(() => build()).toThrow(/broken\.level\.json will not parse/)
  })
})
