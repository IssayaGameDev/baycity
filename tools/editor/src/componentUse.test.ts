import { describe, expect, it } from 'vitest'
import type { Node } from '@mp/content'

import { componentUse, removalRefusal } from './componentUse'

/** Where a game still uses a component (ADR 0175): what taking a shared component out of it is refused on. */

const node = (types: string[], children: Node[] = []): Node => ({
  id: types.join('-') || 'n',
  transform: { position: { x: 0, y: 0, z: 0 } },
  components: types.map((type, i) => ({ id: `c${i}`, type, params: {} })),
  children,
})

const LEVELS = [
  { name: 'keyboard/default', mode: 'keyboard', components: ['Collider', 'Hazard'] },
  { name: 'keyboard/Roblox', mode: 'keyboard', components: ['Collider', 'Bumper'] },
  { name: 'keyboard/broken', mode: 'keyboard' },
  { name: '_template/default', mode: '_template', components: ['Hazard'] },
]

const PREFABS = [
  { name: 'Spike', path: 'keyboard/assets/prefabs/Spike.prefab.json', root: node([], [node(['Hazard'])]) },
  { name: 'Crate', path: 'keyboard/assets/prefabs/Crate.prefab.json', root: node(['Collider']) },
  { name: 'Lava', path: 'assets/prefabs/Lava.prefab.json', root: node(['Hazard']) },
  { name: 'Trap', path: '_template/assets/prefabs/Trap.prefab.json', root: node(['Hazard']) },
]

describe('where a game uses a component', () => {
  it('finds its levels and its own prefabs, a child included — not another game’s, nor Shared’s', () => {
    expect(componentUse('Hazard', 'keyboard', LEVELS, PREFABS)).toEqual({ levels: ['default'], prefabs: ['Spike'], unreadable: ['broken'] })
  })

  it('refuses while anything uses it, and says where', () => {
    const use = componentUse('Hazard', 'keyboard', LEVELS, PREFABS)
    expect(removalRefusal('Hazard', use)).toBe('Hazard is still used in level default and prefab Spike: take it off those objects first')
  })

  // A level the server could not read may hold one: removing on a guess would leave the game unable to load it.
  it('refuses when a level of the game could not be read', () => {
    const use = componentUse('Checkpoint', 'keyboard', LEVELS, PREFABS)
    expect(use).toEqual({ levels: [], prefabs: [], unreadable: ['broken'] })
    expect(removalRefusal('Checkpoint', use)).toBe('broken could not be read, so Checkpoint may still be in it')
  })

  it('lets it go when nothing uses it', () => {
    const levels = LEVELS.filter((l) => l.name !== 'keyboard/broken')
    expect(removalRefusal('Checkpoint', componentUse('Checkpoint', 'keyboard', levels, PREFABS))).toBeNull()
  })

  it('names a few places, and how many more', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: `keyboard/${n}`, mode: 'keyboard', components: ['Bumper'] }))
    expect(removalRefusal('Bumper', componentUse('Bumper', 'keyboard', many, []))).toBe(
      'Bumper is still used in levels a, b, c and 2 more: take it off those objects first',
    )
  })
})
