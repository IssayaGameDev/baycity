import { describe, expect, it } from 'vitest'

import { unlinkPrefab, type UnlinkDeps } from './prefabs'
import type { ComponentData, Level, Node } from './types'

/**
 * Unlinking a prefab's placements (ADR 0097) — what deleting a prefab does to the levels using it.
 *
 * The contract: the objects stay where they are and keep what they were drawing, they just stop being copies
 * of anything. The traps are all about the inherited half entering the level's id space.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const at = (x: number): { position: { x: number; y: number; z: number } } => ({ position: { x, y: 0, z: 0 } })

let minted = 0
const deps = (): UnlinkDeps => {
  minted = 0
  return {
    types: { get: (type) => (type === 'Renderer' ? { singleton: true } : undefined) },
    freshId: () => `n${++minted}`,
    // Only `Track` declares a nodeRef in these fixtures.
    refKeysOf: (type) => (type === 'Track' ? ['target'] : []),
  }
}

/** A prefab of a root and two children, one of which points at the other. */
const definition = (): Node => ({
  id: 'root',
  name: 'Pad',
  transform: at(0),
  components: [comp('c0', 'Collider')],
  children: [
    { id: 'lamp', transform: at(1), components: [comp('c1', 'Renderer')] },
    { id: 'mover', transform: at(2), components: [comp('c2', 'Track', { target: 'lamp' })] },
  ],
})

const levelWith = (nodes: Node[]): Level => ({ id: 'fx', config: {}, prefabs: { P: definition() }, nodes })

describe('unlinkPrefab', () => {
  it('keeps the placement where it is and gives it the contents it was drawing', () => {
    const level = levelWith([{ id: 'a', transform: at(7), components: [], prefab: 'P' }])
    expect(unlinkPrefab(level, 'P', deps())).toBe(1)
    const a = level.nodes[0]!
    expect(a.id, 'its own id survives, so every reference to the placement still resolves').toBe('a')
    expect(a.transform.position.x, 'and its own transform').toBe(7)
    expect(a.prefab, 'no longer a copy of anything').toBeUndefined()
    expect(a.name, 'took the name it was showing').toBe('Pad')
    expect(a.components.map((c) => c.type)).toEqual(['Collider'])
    expect(a.children?.length).toBe(2)
  })

  it('re-ids the inherited children, so two placements do not collide', () => {
    const level = levelWith([
      { id: 'a', transform: at(0), components: [], prefab: 'P' },
      { id: 'b', transform: at(9), components: [], prefab: 'P' },
    ])
    expect(unlinkPrefab(level, 'P', deps())).toBe(2)
    const ids = level.nodes.flatMap((n) => (n.children ?? []).map((k) => k.id))
    expect(new Set(ids).size, 'four children, four distinct ids').toBe(4)
    expect(ids).not.toContain('lamp')
  })

  it('re-points a reference between two inherited nodes at the copy, not the original', () => {
    const level = levelWith([
      { id: 'a', transform: at(0), components: [], prefab: 'P' },
      { id: 'b', transform: at(9), components: [], prefab: 'P' },
    ])
    unlinkPrefab(level, 'P', deps())
    for (const n of level.nodes) {
      const lamp = n.children![0]!.id
      const target = n.children![1]!.components[0]!.params.target
      expect(target, 'points at its own sibling').toBe(lamp)
    }
    // And the two placements do not point at each other.
    expect(level.nodes[0]!.children![1]!.components[0]!.params.target).not.toBe(level.nodes[1]!.children![0]!.id)
  })

  it('does not let two placements share a child object', () => {
    const level = levelWith([
      { id: 'a', transform: at(0), components: [], prefab: 'P' },
      { id: 'b', transform: at(9), components: [], prefab: 'P' },
    ])
    unlinkPrefab(level, 'P', deps())
    const first = level.nodes[0]!.children![0]!
    const second = level.nodes[1]!.children![0]!
    expect(first).not.toBe(second)
    // `bakeOverrides` hands back the prefab's own object when nothing changed, so this is the real risk.
    expect(first).not.toBe(definition().children![0])
    first.transform.position.x = 99
    expect(second.transform.position.x, 'editing one must not move the other').toBe(1)
  })

  it('bakes an override in, since there is nothing left to override', () => {
    const level = levelWith([
      {
        id: 'a',
        transform: at(0),
        components: [],
        prefab: 'P',
        overrides: { lamp: { name: 'Bright', params: { c1: { colour: 'red' } } } },
      },
    ])
    unlinkPrefab(level, 'P', deps())
    const a = level.nodes[0]!
    expect(a.overrides, 'the record goes with the reference').toBeUndefined()
    expect(a.children![0]!.name).toBe('Bright')
    expect(a.children![0]!.components[0]!.params.colour).toBe('red')
  })

  it("keeps the placement's own components layered over the inherited ones", () => {
    const level = levelWith([
      { id: 'a', transform: at(0), components: [comp('own', 'Renderer'), comp('own2', 'Hazard')], prefab: 'P' },
    ])
    unlinkPrefab(level, 'P', deps())
    // Renderer is a singleton, so the placement's replaces nothing inherited here; Hazard simply appends.
    expect(level.nodes[0]!.components.map((c) => c.id)).toEqual(['c0', 'own', 'own2'])
  })

  it("keeps the placement's own children after the inherited ones", () => {
    const own: Node = { id: 'mine', transform: at(5), components: [] }
    const level = levelWith([{ id: 'a', transform: at(0), components: [], prefab: 'P', children: [own] }])
    unlinkPrefab(level, 'P', deps())
    const kids = level.nodes[0]!.children!
    expect(kids.length).toBe(3)
    expect(kids[2]!.id, 'its own child keeps its own id — it was never in the prefab').toBe('mine')
  })

  it('reaches a placement nested under another node', () => {
    const level = levelWith([
      { id: 'top', transform: at(0), components: [], children: [{ id: 'a', transform: at(1), components: [], prefab: 'P' }] },
    ])
    expect(unlinkPrefab(level, 'P', deps())).toBe(1)
    expect(level.nodes[0]!.children![0]!.prefab).toBeUndefined()
  })

  it('leaves every other prefab alone', () => {
    const level: Level = {
      id: 'fx',
      config: {},
      prefabs: { P: definition(), Q: definition() },
      nodes: [
        { id: 'a', transform: at(0), components: [], prefab: 'P' },
        { id: 'b', transform: at(1), components: [], prefab: 'Q' },
      ],
    }
    expect(unlinkPrefab(level, 'P', deps())).toBe(1)
    expect(level.nodes[1]!.prefab, 'Q is not the one being deleted').toBe('Q')
  })

  it('reports nothing for a prefab no level places', () => {
    const level = levelWith([{ id: 'a', transform: at(0), components: [] }])
    expect(unlinkPrefab(level, 'P', deps())).toBe(0)
  })

  it('leaves a placement whose definition is already missing as it is', () => {
    // Nothing to inline, so it stays an empty object rather than becoming one silently — the same shape a
    // missing prefab has always degraded to (ADR 0091).
    const level: Level = { id: 'fx', config: {}, nodes: [{ id: 'a', name: 'ghost', transform: at(0), components: [], prefab: 'P' }] }
    expect(unlinkPrefab(level, 'P', deps())).toBe(1)
    const a = level.nodes[0]!
    expect(a.prefab).toBeUndefined()
    expect(a.name).toBe('ghost')
    expect(a.children).toEqual([])
  })
})
