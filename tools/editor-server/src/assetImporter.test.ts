import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { entriesFrom, type AssetMeta } from '@mp/content'

import { importAssets } from './assetImporter'

/** The content folder: the shared library is `assets/` in it, a game's own `<game>/assets/` (ADR 0161). */
let root = ''

/** Write a file into the shared library, by its path inside it. */
const write = (rel: string, body = 'x'): string => writeAt(`assets/${rel}`, body)
/** Write a file anywhere under `content/`, by its content-relative path. */
const writeAt = (path: string, body = 'x'): string => {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  return full
}

const metaOf = (rel: string): { id: string; kind: string } =>
  JSON.parse(readFileSync(join(root, 'assets', `${rel}.meta`), 'utf8')) as { id: string; kind: string }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-assets-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('importAssets', () => {
  it('gives every asset an id and a sidecar', () => {
    write('textures/brick.png')
    write('props/crate.glb')

    const { entries, created } = importAssets(root)

    expect(entries.map((e) => e.kind).sort()).toEqual(['model', 'texture'])
    expect(created.sort(), 'paths from content/, starting with the library').toEqual(['assets/props/crate.glb.meta', 'assets/textures/brick.png.meta'])
    expect(metaOf('textures/brick.png').kind).toBe('texture')
    expect(metaOf('textures/brick.png').id).toMatch(/^[0-9a-f]{16}$/)
  })

  // The whole reason ids exist: the reference has to survive the file being renamed.
  it('keeps an id across a rescan, and across a rename', () => {
    write('textures/brick.png')
    const first = importAssets(root).entries[0]!.id

    expect(importAssets(root).created, 'nothing to write the second time').toEqual([])
    expect(importAssets(root).entries[0]!.id).toBe(first)

    // Rename the asset and its sidecar, as any file manager would.
    const meta = readFileSync(join(root, 'assets/textures/brick.png.meta'), 'utf8')
    rmSync(join(root, 'assets/textures/brick.png'))
    rmSync(join(root, 'assets/textures/brick.png.meta'))
    write('textures/stone.png')
    writeFileSync(join(root, 'assets/textures/stone.png.meta'), meta)

    expect(importAssets(root).entries[0]!.id, 'same asset, new name').toBe(first)
  })

  it('reissues an id that two files claim, so a reference is never ambiguous', () => {
    write('textures/brick.png')
    importAssets(root)
    const original = metaOf('textures/brick.png')

    // Copy-pasting an asset usually copies its sidecar too.
    write('textures/brick_copy.png')
    writeFileSync(join(root, 'assets/textures/brick_copy.png.meta'), JSON.stringify(original))

    const { entries } = importAssets(root)
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size, 'two assets, two ids').toBe(2)
    expect(ids).toContain(original.id) // the first one keeps it
  })

  it('lets the extension decide the kind, and repairs a sidecar that disagrees', () => {
    write('props/crate.glb')
    writeFileSync(join(root, 'assets/props/crate.glb.meta'), JSON.stringify({ id: 'abc123', kind: 'texture' }))

    const { entries } = importAssets(root)
    expect(entries[0]!.kind).toBe('model')
    expect(metaOf('props/crate.glb'), 'repaired in place, id kept').toEqual({ id: 'abc123', kind: 'model' })
  })

  it('rewrites a corrupt sidecar rather than failing the scan', () => {
    write('textures/brick.png')
    writeFileSync(join(root, 'assets/textures/brick.png.meta'), '{ not json')

    const { entries } = importAssets(root)
    expect(entries).toHaveLength(1)
    expect(metaOf('textures/brick.png').id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('ignores files that are not assets, and never gives a sidecar a sidecar', () => {
    write('README.md')
    write('notes.txt')
    write('textures/brick.png')

    const { entries } = importAssets(root)
    expect(entries.map((e) => e.path)).toEqual(['assets/textures/brick.png'])
    expect(importAssets(root).created, 'the .meta itself is not an asset').toEqual([])
  })

  it('recognises materials and shaders by compound extension', () => {
    write('materials/brick.mat.json', '{"shader":"standard","params":{}}')
    write('shaders/water.shader.json', '{}')

    const kinds = importAssets(root).entries.map((e) => `${e.name}:${e.kind}`)
    expect(kinds.sort()).toEqual(['brick:material', 'water:shader'])
  })

  it('scans every game’s own library with the shared one, one id each across all of them (ADR 0161)', () => {
    write('textures/brick.png')
    writeAt('keyboard/game.json', '{}')
    writeAt('keyboard/assets/textures/key.png')
    writeAt('keyboard/levels/default.level.json', '{}') // a level is not an asset
    writeAt('parkour/materials/loose.mat.json', '{}') // not in a library: a game's assets are in its assets/
    importAssets(root)
    // Copied from Shared into Keyboard's library with its sidecar: two files, so two ids.
    writeAt('keyboard/assets/textures/brick.png')
    writeFileSync(join(root, 'keyboard/assets/textures/brick.png.meta'), JSON.stringify(metaOf('textures/brick.png')))

    const { entries } = importAssets(root)
    expect(entries.map((e) => e.path)).toEqual(['assets/textures/brick.png', 'keyboard/assets/textures/brick.png', 'keyboard/assets/textures/key.png'])
    expect(new Set(entries.map((e) => e.id)).size, 'the same name in two libraries is two assets').toBe(3)
    expect(entries.find((e) => e.path === 'assets/textures/brick.png')!.id, 'the one scanned first keeps its id').toBe(metaOf('textures/brick.png').id)
  })

  it('creates the root if it is not there yet, rather than throwing', () => {
    const missing = join(root, 'not', 'made', 'yet')
    expect(importAssets(missing).entries).toEqual([])
  })

  /**
   * The drift test. Two things build an asset database: this importer, walking the filesystem, and the
   * game, enumerating a build-time glob. Finding the files differs by necessity; *deriving an entry* from
   * one must not, or the editor lists an asset the game cannot resolve.
   *
   * Both now assemble through `entriesFrom`, so this asserts the importer really does, and that its walk
   * finds exactly the assets its own sidecars describe.
   */
  it('agrees with the shared assembler over the same tree', () => {
    write('textures/brick.png')
    write('textures/nested/deep/stone.jpg')
    write('props/crate.glb')
    write('materials/brick.mat.json', '{"shader":"standard","params":{}}')
    write('shaders/water.shader.json', '{}')
    write('sfx/jump.wav')
    write('ui/Inter.ttf')
    write('README.md') // not an asset
    write('notes.txt') // nor this

    const { entries } = importAssets(root)

    // Rebuild the way the game does: from the sidecars on disk, keyed by the asset's path.
    const pairs: [string, AssetMeta][] = []
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(root, rel))) {
        const childRel = rel === '' ? name : `${rel}/${name}`
        if (statSync(join(root, childRel)).isDirectory()) walk(childRel)
        else if (name.endsWith('.meta')) {
          const meta = JSON.parse(readFileSync(join(root, childRel), 'utf8')) as AssetMeta
          pairs.push([childRel.slice(0, -'.meta'.length), meta])
        }
      }
    }
    walk('')

    expect(entriesFrom(pairs)).toEqual(entries)
    // Path order, not kind order: `sfx/` sorts before `shaders/`.
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'material:brick',
      'model:crate',
      'sound:jump',
      'shader:water',
      'texture:brick',
      'texture:stone',
      'font:Inter',
    ])
  })

  it('returns a stable order between scans', () => {
    write('b/two.png')
    write('a/one.png')
    write('a/three.png')
    const first = importAssets(root).entries.map((e) => e.path)
    expect(importAssets(root).entries.map((e) => e.path)).toEqual(first)
    expect(first[0]).toBe('assets/a/one.png')
  })
})
