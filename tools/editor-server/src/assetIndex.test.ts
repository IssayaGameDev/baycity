import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAssetIndex } from './assetIndex'

/**
 * The asset list in memory (ADR 0156): walked once, then read; walked again only when asked, and every sidecar
 * a walk writes is reported once, so each reaches a commit.
 */

let root = ''
const write = (rel: string, body = 'x'): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-index-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the asset index', () => {
  it('answers from one walk until it is told to look again', () => {
    write('textures/a.png')
    const index = createAssetIndex(root)
    const a = index.byPath('textures/a.png')!
    expect(index.byId(a.id)?.path).toBe('textures/a.png')
    write('textures/b.png')
    expect(index.byPath('textures/b.png'), 'not walked again by a lookup').toBeUndefined()
    index.rescan()
    expect(index.byPath('textures/b.png')?.kind).toBe('texture')
    expect(index.entries().map((e) => e.path)).toEqual(['textures/a.png', 'textures/b.png'])
  })

  it('reports every sidecar it wrote once, those of a lookup’s walk included', () => {
    write('textures/a.png')
    const index = createAssetIndex(root)
    index.byPath('textures/a.png') // the first walk, which nobody reports
    write('textures/b.png')
    index.refresh()
    expect(existsSync(join(root, 'textures/b.png.meta'))).toBe(true)
    expect(index.rescan().sort()).toEqual(['textures/a.png.meta', 'textures/b.png.meta'])
    expect(index.rescan(), 'reported once').toEqual([])
  })
})
