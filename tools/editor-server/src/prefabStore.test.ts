import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { importAssets } from './assetImporter'
import { movePath, removePath } from './assetOps'
import { createPrefabStore } from './prefabStore'

import type { Node } from '../../../packages/content/src/types'

/**
 * The prefab store answers for an id wherever its file has gone (ADR 0091). It used to remember a path for
 * ever, so a prefab moved while the server ran resolved to nothing and was written back to its old place.
 */

let root = ''
const pad = (name: string): Node => ({ id: 'root', name, transform: { position: { x: 0, y: 0, z: 0 } }, components: [] })
const write = (rel: string, node: Node): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), JSON.stringify(node))
}
const idOf = (rel: string): string => importAssets(root).entries.find((e) => e.path === rel)!.id

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-prefabs-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the prefab store', () => {
  it('follows a prefab moved into another folder, reading and writing it there', () => {
    write('prefabs/pad.prefab.json', pad('pad'))
    const id = idOf('prefabs/pad.prefab.json')
    const store = createPrefabStore(root)
    expect(store.root(id)?.name).toBe('pad')

    movePath(root, 'prefabs/pad.prefab.json', 'prefabs/Basic/pad.prefab.json')
    expect(store.pathOf(id)).toBe('prefabs/Basic/pad.prefab.json')
    expect(store.root(id)?.name, 'a level opened now still resolves it').toBe('pad')

    expect(store.write(id, pad('edited'))).toBe('prefabs/Basic/pad.prefab.json')
    expect((JSON.parse(readFileSync(join(root, 'prefabs/Basic/pad.prefab.json'), 'utf8')) as Node).name).toBe('edited')
    expect(existsSync(join(root, 'prefabs/pad.prefab.json')), 'nothing written back to where it was').toBe(false)
  })

  it('follows a renamed folder', () => {
    write('prefabs/Test/pad.prefab.json', pad('pad'))
    const id = idOf('prefabs/Test/pad.prefab.json')
    const store = createPrefabStore(root)
    expect(store.pathOf(id)).toBe('prefabs/Test/pad.prefab.json')
    movePath(root, 'prefabs/Test', 'prefabs/Trials')
    expect(store.root(id)?.name).toBe('pad')
    expect(store.write(id, pad('edited'))).toBe('prefabs/Trials/pad.prefab.json')
  })

  it('does not bring a deleted prefab back', () => {
    write('prefabs/pad.prefab.json', pad('pad'))
    const id = idOf('prefabs/pad.prefab.json')
    const store = createPrefabStore(root)
    expect(store.pathOf(id)).toBe('prefabs/pad.prefab.json')
    removePath(root, 'prefabs/pad.prefab.json')
    expect(store.root(id)).toBeUndefined()
    expect(store.write(id, pad('edited'))).toBeNull()
    expect(existsSync(join(root, 'prefabs/pad.prefab.json'))).toBe(false)
  })

  it('does not take another prefab that took the old place for this one', () => {
    write('prefabs/pad.prefab.json', pad('pad'))
    const id = idOf('prefabs/pad.prefab.json')
    const store = createPrefabStore(root)
    expect(store.pathOf(id)).toBe('prefabs/pad.prefab.json')
    movePath(root, 'prefabs/pad.prefab.json', 'prefabs/old-pad.prefab.json')
    write('prefabs/pad.prefab.json', pad('newcomer'))
    importAssets(root) // the newcomer gets its own sidecar, with its own id
    expect(store.root(id)?.name).toBe('pad')
    expect(store.pathOf(id)).toBe('prefabs/old-pad.prefab.json')
  })
})
