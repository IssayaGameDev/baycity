import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Level, Node } from '../../../packages/content/src/types'
import { findInlinePrefabs, planInlineCleanup, prefabAssets, withoutEntries } from './inlinePrefabs'

/**
 * Finding the levels that carry a prefab definition rather than a reference (ADR 0124).
 *
 * The plan is what is worth testing: it decides what to do to Kodjo's content, and the one outcome that would
 * cost real work is dropping an entry nothing can replace.
 */

const PAD = 'aaaaaaaaaaaaaaaa'
const GHOST = 'bbbbbbbbbbbbbbbb'

const padRoot = (name = 'pad'): Node => ({ id: 'p0', name, transform: { position: { x: 0, y: 0, z: 0 } }, components: [] })

const placement = (prefab: string): Node => ({ id: 'n0', transform: { position: { x: 0, y: 0, z: 0 } }, components: [], prefab })

/** A content directory in the per-game layout (ADR 0108), with a prefab library. */
const world = (levels: Record<string, Level>, assets: Record<string, Node> = { [PAD]: padRoot() }): string => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-'))
  mkdirSync(join(dir, 'assets', 'prefabs'), { recursive: true })
  for (const [id, root] of Object.entries(assets)) {
    writeFileSync(join(dir, 'assets', 'prefabs', `${id}.prefab.json`), JSON.stringify(root))
    writeFileSync(join(dir, 'assets', 'prefabs', `${id}.prefab.json.meta`), JSON.stringify({ id }))
  }
  for (const [name, level] of Object.entries(levels)) {
    mkdirSync(join(dir, 'keyboard', 'levels'), { recursive: true })
    writeFileSync(join(dir, 'keyboard', 'levels', `${name}.level.json`), JSON.stringify(level, null, 2))
  }
  return dir
}

const level = (extra: Partial<Level>): Level => ({ id: 'lv', config: {}, nodes: [], ...extra })

describe('prefab assets by id', () => {
  it('reads the id from the .meta sidecar, not the filename', () => {
    const dir = world({}, { [PAD]: padRoot() })
    expect([...prefabAssets(dir).keys()]).toEqual([PAD])
  })

  it('is empty when there is no prefab library at all', () => {
    expect(prefabAssets(mkdtempSync(join(tmpdir(), 'bare-'))).size).toBe(0)
  })
})

describe('finding levels that carry a definition', () => {
  it('says nothing about a level that references its prefab', () => {
    const dir = world({ clean: level({ nodes: [placement(PAD)] }) })
    expect(findInlinePrefabs(dir)).toEqual([])
  })

  it('finds one whose table matches the asset', () => {
    const dir = world({ dirty: level({ prefabs: { [PAD]: padRoot() }, nodes: [placement(PAD)] }) })
    const found = findInlinePrefabs(dir)
    expect(found).toHaveLength(1)
    expect(found[0]!.file).toBe('keyboard/levels/dirty.level.json')
    expect(found[0]!.entries).toEqual([{ assetId: PAD, referenced: true, hasAsset: true, drifted: false }])
  })

  /** The one that changes what a level looks like, so it is reported on its own. */
  it('marks an entry that has drifted from its asset', () => {
    const dir = world({ dirty: level({ prefabs: { [PAD]: padRoot('stale') }, nodes: [placement(PAD)] }) })
    expect(findInlinePrefabs(dir)[0]!.entries[0]!.drifted).toBe(true)
  })

  it('marks an entry with no asset behind it', () => {
    const dir = world({ dirty: level({ prefabs: { [GHOST]: padRoot() }, nodes: [placement(GHOST)] }) })
    expect(findInlinePrefabs(dir)[0]!.entries[0]).toEqual({ assetId: GHOST, referenced: true, hasAsset: false, drifted: false })
  })

  it('notices an entry nothing in the level references', () => {
    const dir = world({ dirty: level({ prefabs: { [PAD]: padRoot() }, nodes: [] }) })
    expect(findInlinePrefabs(dir)[0]!.entries[0]!.referenced).toBe(false)
  })
})

describe('planning the cleanup', () => {
  const plan = (l: Level, assets?: Record<string, Node>) => planInlineCleanup(findInlinePrefabs(world({ dirty: l }, assets)))

  it('drops an entry whose asset exists', () => {
    const { drop, keep } = plan(level({ prefabs: { [PAD]: padRoot() }, nodes: [placement(PAD)] }))
    expect(drop.map((d) => d.assetId)).toEqual([PAD])
    expect(keep).toEqual([])
  })

  /**
   * The outcome that would cost real work. There the table genuinely is the only source — the case
   * `hydratePrefabs`'s skip was written for — and dropping it turns a placement that draws something into
   * one that draws nothing.
   */
  it('keeps an entry with no asset, and says why', () => {
    const { drop, keep } = plan(level({ prefabs: { [GHOST]: padRoot() }, nodes: [placement(GHOST)] }))
    expect(drop).toEqual([])
    expect(keep).toHaveLength(1)
    expect(keep[0]!.why).toContain('no prefab asset')
  })

  it('drops a drifted entry and flags it, since that level will change', () => {
    const { drop } = plan(level({ prefabs: { [PAD]: padRoot('stale') }, nodes: [placement(PAD)] }))
    expect(drop).toEqual([{ file: 'keyboard/levels/dirty.level.json', assetId: PAD, drifted: true }])
  })

  it('sorts the entries of one file into both piles', () => {
    const { drop, keep } = plan(level({ prefabs: { [PAD]: padRoot(), [GHOST]: padRoot() }, nodes: [placement(PAD), placement(GHOST)] }))
    expect(drop.map((d) => d.assetId)).toEqual([PAD])
    expect(keep.map((k) => k.assetId)).toEqual([GHOST])
  })
})

describe('the rewrite', () => {
  it('drops the table entirely when nothing is left', () => {
    const out = withoutEntries(level({ prefabs: { [PAD]: padRoot() }, nodes: [placement(PAD)] }), [PAD])
    expect(out.prefabs).toBeUndefined()
    expect(out.nodes[0]!.prefab, 'the reference stays').toBe(PAD)
  })

  it('keeps the entries it was not asked to drop', () => {
    const out = withoutEntries(level({ prefabs: { [PAD]: padRoot(), [GHOST]: padRoot('mine') }, nodes: [] }), [PAD])
    expect(Object.keys(out.prefabs ?? {})).toEqual([GHOST])
    expect(out.prefabs![GHOST]!.name).toBe('mine')
  })

  /** Only the table: a node rewritten by accident is the one outcome that would cost real work. */
  it('touches nothing but the table', () => {
    const before = level({ prefabs: { [PAD]: padRoot() }, nodes: [placement(PAD)], config: { mode: { name: 'keyboard' } } })
    const after = withoutEntries(before, [PAD])
    const strip = ({ prefabs: _p, ...rest }: Level): unknown => rest
    expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)))
  })

  it('leaves a level with no table alone', () => {
    const l = level({ nodes: [placement(PAD)] })
    expect(withoutEntries(l, [PAD])).toBe(l)
  })
})
