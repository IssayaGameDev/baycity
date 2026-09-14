import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { fingerprintLevel, firstDifference } from './fingerprint'
import { hydratePrefabs } from './prefabs'
import type { ComponentData, Level, Node } from './types'

const TYPES = { get: () => undefined }
const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })

/** The real shape of the case this exists for: a prefab whose pad node is called `p0` in the file. */
const trampolineFile = (): Node => ({
  id: 'root',
  name: 'Trampoline',
  transform: { position: vec3(0, 0, 0) },
  components: [],
  children: [{ id: 'p0', transform: { position: vec3(0, 0, 0) }, components: [comp('c1', 'Renderer', { material: '' }), comp('c2', 'Bumper', { power: 26 })] }],
})

/** The same prefab as a level interned it, with the pad node under a different id. */
const trampolineCopy = (): Node => {
  const root = trampolineFile()
  root.children![0]!.id = '91521042'
  return root
}

const withPlacement = (prefab: string, overrideKey: string): Level => ({
  id: 'lv',
  config: {},
  nodes: [
    {
      id: 'trampoline',
      name: 'trampoline',
      transform: { position: vec3(10, 0, 0) },
      components: [],
      prefab,
      overrides: { [overrideKey]: { transform: { position: vec3(24.5, 0, -5.5) }, params: { c2: { power: 60 } } } },
    },
  ],
})

describe('fingerprinting a level', () => {
  it('names every resolved node, its pose and every component parameter', () => {
    const level = withPlacement('Trampoline', '91521042')
    level.prefabs = { Trampoline: trampolineCopy() }
    const lines = fingerprintLevel(level, TYPES)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('trampoline#trampoline | p 10,0,0')
    expect(lines[1]).toContain('trampoline#trampoline/91521042')
    expect(lines[1], 'the override is in the fingerprint, which is the point').toContain('"power":60')
  })

  /**
   * The regression the fingerprint exists to catch. Re-pointing the placement at the prefab **file** without
   * remapping the node id leaves the override keyed on a node that is no longer there: it is inert, the pad
   * goes back to the prefab's `power: 26`, and nothing else in the level looks different.
   */
  it('catches an override orphaned by a node-id change, which is the migration hazard', () => {
    const before = withPlacement('Trampoline', '91521042')
    before.prefabs = { Trampoline: trampolineCopy() }

    const naive = withPlacement('aaaaaaaaaaaaaaaa', '91521042') // re-pointed, override key left alone
    hydratePrefabs(naive, { root: () => trampolineFile() })

    const diff = firstDifference(fingerprintLevel(before, TYPES), fingerprintLevel(naive, TYPES))
    expect(diff, 'a silent loss must be a visible difference').not.toBeNull()
    expect(diff!.before).toContain('"power":60')
    expect(diff!.after).toContain('"power":26')
  })

  it('a reference change with the override key remapped resolves identically', () => {
    const before = withPlacement('Trampoline', '91521042')
    before.prefabs = { Trampoline: trampolineCopy() }

    const migrated = withPlacement('aaaaaaaaaaaaaaaa', 'p0') // the remap the migration must apply
    hydratePrefabs(migrated, { root: () => trampolineFile() })

    // Only the node's own id differs, which is the prefab's business and not what the level looks like.
    const strip = (lines: string[]): string[] => lines.map((l) => l.replace(/91521042|p0/g, 'pad'))
    expect(firstDifference(strip(fingerprintLevel(before, TYPES)), strip(fingerprintLevel(migrated, TYPES)))).toBeNull()
  })

  it('a missing prefab is a visible difference, not a crash', () => {
    const level = withPlacement('gone', 'p0')
    const lines = fingerprintLevel(level, TYPES)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('inherited 0')
  })

  it('reports where two fingerprints part, and nothing when they agree', () => {
    expect(firstDifference(['a', 'b'], ['a', 'b'])).toBeNull()
    expect(firstDifference(['a', 'b'], ['a', 'c'])).toEqual({ at: 1, before: 'b', after: 'c' })
    expect(firstDifference(['a'], ['a', 'extra'])).toEqual({ at: 1, after: 'extra' })
  })
})
