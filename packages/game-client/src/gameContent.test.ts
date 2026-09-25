import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { gameContentFiles, gameContentModule } from '../../../game-content'
import { SKY_TEXTURE } from './codeAssets'

/**
 * What a game carries of `content/` (ADR 0161): its own levels and its own library and Shared's — the whole of both
 * when served, only what its levels use when built — and never another game's.
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
const SKY = 'ffffffffffffffff'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-game-content-'))
  for (const g of ['keyboard', 'parkour']) write(`${g}/game.json`, { components: [] })
  // Keyboard's level places its own pad, drawn with a Shared material that has a Shared texture.
  write('keyboard/levels/default.level.json', { id: 'default', config: {}, nodes: [{ id: 'p', prefab: PAD, components: [] }] })
  write('parkour/levels/default.level.json', { id: 'default', config: {}, nodes: [] })
  asset('keyboard/assets/prefabs/pad.prefab.json', PAD, { id: 'root', components: [{ id: 'r', type: 'Renderer', params: { material: RED } }] })
  asset('assets/materials/red.mat.json', RED, { shader: 'standard', params: { map: { kind: 'texture', value: BRICK } } })
  asset('assets/textures/brick.png', BRICK)
  asset('assets/textures/unused.png', UNUSED)
  asset(SKY_TEXTURE, SKY)
  asset('parkour/assets/textures/other.png', OTHER)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('what a game carries', () => {
  it('served: its own levels, the whole of its own library and Shared’s, nothing of another game’s', () => {
    expect(gameContentFiles(root, 'keyboard', 'library')).toEqual({
      levels: ['keyboard/levels/default.level.json'],
      assets: ['assets/materials/red.mat.json', 'assets/textures/brick.png', SKY_TEXTURE, 'assets/textures/unused.png', 'keyboard/assets/prefabs/pad.prefab.json'].sort(),
    })
  })

  it('built: only what its levels use, through the prefab and the material, and what the code loads by path', () => {
    expect(gameContentFiles(root, 'keyboard', 'used').assets).toEqual(
      ['assets/materials/red.mat.json', 'assets/textures/brick.png', SKY_TEXTURE, 'keyboard/assets/prefabs/pad.prefab.json'].sort(),
    )
    expect(gameContentFiles(root, 'parkour', 'used').assets, 'a game using nothing still has its sky').toEqual([SKY_TEXTURE])
  })

  it('for the tests, everything: every library and every game’s levels', () => {
    const all = gameContentFiles(root, null, 'used')
    expect(all.levels).toEqual(['keyboard/levels/default.level.json', 'parkour/levels/default.level.json'])
    expect(all.assets).toContain('parkour/assets/textures/other.png')
  })

  it('writes one import per file, keyed by its path from content/', () => {
    const code = gameContentModule({ levels: ['keyboard/levels/default.level.json'], assets: ['assets/materials/red.mat.json', 'assets/textures/brick.png'] })
    expect(code).toContain('from "@content/keyboard/levels/default.level.json"')
    expect(code).toContain('from "@content/assets/materials/red.mat.json.meta?raw"')
    expect(code).toContain('from "@content/assets/textures/brick.png?url"')
    expect(code, 'a material is read, not fetched').not.toContain('red.mat.json?url')
    expect(code).toMatch(/export const MATERIALS = \{\n {2}"assets\/materials\/red\.mat\.json": c\d+,\n\}/)
  })
})
