import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { importAssets } from './assetImporter'
import { AssetOpError, listFolders, makeFolder, movePath, removePath } from './assetOps'

/** The ops work on any root; the importer that writes the sidecars scans `content/`, whose shared library this is. */
let content = ''
let root = ''

const write = (rel: string, body = 'x'): void => {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}
const has = (rel: string): boolean => existsSync(join(root, rel))
const idOf = (rel: string): string => (JSON.parse(readFileSync(join(root, `${rel}.meta`), 'utf8')) as { id: string }).id

beforeEach(() => {
  content = mkdtempSync(join(tmpdir(), 'mp-ops-'))
  root = join(content, 'assets')
  mkdirSync(root)
})
afterEach(() => {
  rmSync(content, { recursive: true, force: true })
})

describe('listFolders', () => {
  it('lists every folder, including empty ones, sorted', () => {
    write('textures/stone/brick.png')
    mkdirSync(join(root, 'sfx'), { recursive: true })
    expect(listFolders(root)).toEqual(['sfx', 'textures', 'textures/stone'])
  })

  it('is empty for a root that is not there', () => {
    expect(listFolders(join(root, 'missing'))).toEqual([])
  })
})

describe('makeFolder', () => {
  it('creates nested folders in one go', () => {
    makeFolder(root, 'a/b/c')
    expect(listFolders(root)).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('refuses a name that is empty, or one that exists', () => {
    makeFolder(root, 'a')
    expect(() => makeFolder(root, 'a')).toThrow(AssetOpError)
    expect(() => makeFolder(root, '  ')).toThrow(AssetOpError)
  })

  it('refuses to escape the root', () => {
    expect(() => makeFolder(root, '../outside')).toThrow(/escapes/)
  })
})

describe('movePath', () => {
  // The point of the whole id scheme: a rename must not break a reference, which it only does not if the
  // sidecar moves with the file.
  it('carries the sidecar, so the id survives a rename', () => {
    write('textures/brick.png')
    importAssets(content)
    const before = idOf('textures/brick.png')

    movePath(root, 'textures/brick.png', 'textures/stone.png')

    expect(has('textures/brick.png')).toBe(false)
    expect(has('textures/brick.png.meta'), 'the old sidecar is gone too').toBe(false)
    expect(idOf('textures/stone.png'), 'same id, new name').toBe(before)
    expect(importAssets(content).created, 'nothing to reissue').toEqual([])
  })

  it('moves a file into another folder, creating it if needed', () => {
    write('brick.png')
    importAssets(content)
    const before = idOf('brick.png')

    movePath(root, 'brick.png', 'textures/stone/brick.png')

    expect(idOf('textures/stone/brick.png')).toBe(before)
  })

  it('moves a folder with everything in it', () => {
    write('textures/stone/brick.png')
    importAssets(content)
    const before = idOf('textures/stone/brick.png')

    movePath(root, 'textures/stone', 'stone')

    expect(has('textures/stone')).toBe(false)
    expect(idOf('stone/brick.png')).toBe(before)
  })

  it('refuses to overwrite', () => {
    write('a.png')
    write('b.png')
    expect(() => movePath(root, 'a.png', 'b.png')).toThrow(/already exists/)
    expect(has('a.png'), 'and leaves the source alone').toBe(true)
  })

  // Renaming into its own subtree would make the destination unresolvable and lose the contents.
  it('refuses a folder into itself', () => {
    write('textures/brick.png')
    expect(() => movePath(root, 'textures', 'textures/inner')).toThrow(/inside itself/)
    expect(has('textures/brick.png')).toBe(true)
  })

  it('refuses the root, a missing source, and an escape', () => {
    expect(() => movePath(root, '', 'x')).toThrow(AssetOpError)
    expect(() => movePath(root, 'nope.png', 'x.png')).toThrow(/not found/)
    expect(() => movePath(root, 'a.png', '../escape.png')).toThrow(/escapes/)
  })

  it('leaves a file with no sidecar alone rather than failing', () => {
    write('loose.png')
    movePath(root, 'loose.png', 'moved.png')
    expect(has('moved.png')).toBe(true)
  })
})

describe('removePath', () => {
  it('deletes a file and its sidecar', () => {
    write('textures/brick.png')
    importAssets(content)

    removePath(root, 'textures/brick.png')

    expect(has('textures/brick.png')).toBe(false)
    expect(has('textures/brick.png.meta'), 'no orphan sidecar left behind').toBe(false)
  })

  it('deletes a folder and everything under it', () => {
    write('textures/stone/brick.png')
    write('textures/loose.png')
    importAssets(content)

    removePath(root, 'textures')

    expect(has('textures')).toBe(false)
    expect(importAssets(content).entries).toEqual([])
  })

  it('refuses the root and an escape, and reports a missing path', () => {
    expect(() => removePath(root, '')).toThrow(/root/)
    expect(() => removePath(root, '../..')).toThrow(AssetOpError)
    expect(() => removePath(root, 'nope')).toThrow(/not found/)
  })
})
