import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { validateLevel } from './validate'
import { COLLIDER, RENDERER } from './nodes'

/**
 * Level validation.
 *
 * The structural half is tested here. The **parameter** half needs a registry, which lives in
 * `@mp/components` — so a fake one is used rather than the real registry, both to keep the dependency one-way
 * and to prove the seam is a capability and not a hidden import.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): unknown => ({ id, type, params })

const level = (nodes: unknown[], prefabs?: Record<string, unknown>): unknown => ({
  id: 'level1',
  config: { fallBehavior: 'respawn-checkpoint', fallY: -5 },
  ...(prefabs !== undefined ? { prefabs } : {}),
  nodes,
})

const solid = (id: string): unknown => ({
  id,
  transform: { position: vec3(0, 0, 0) },
  components: [comp(`${id}c0`, COLLIDER, { shape: { kind: 'box', halfExtents: vec3(1, 0.2, 1) } }), comp(`${id}c1`, RENDERER, { material: '' })],
})

describe('the level itself', () => {
  it('accepts a well-formed one and hands it back', () => {
    expect(validateLevel(level([solid('n0')])).id).toBe('level1')
  })

  it('rejects a bad fallBehavior', () => {
    expect(() => validateLevel({ id: 'l', config: { fallBehavior: 'nope', fallY: 0 }, nodes: [] })).toThrow(/fallBehavior/)
  })

  it('rejects a missing node list, which is what a pre-component file looks like', () => {
    expect(() => validateLevel({ id: 'l', config: { fallBehavior: 'physical-fall', fallY: -1 }, instances: [] })).toThrow(/level\.nodes/)
  })

  it('rejects a node with no transform', () => {
    expect(() => validateLevel(level([{ id: 'n', components: [] }]))).toThrow(/transform\.position/)
  })

  it('rejects a node with no id, since an override names one', () => {
    expect(() => validateLevel(level([{ transform: { position: vec3(0, 0, 0) }, components: [] }]))).toThrow(/\.id/)
  })

  // Overrides key by node id at any depth, so a duplicate would silently patch two things.
  it('rejects the same node id twice in one tree', () => {
    expect(() => validateLevel(level([solid('same'), solid('same')]))).toThrow(/used twice in this tree/)
  })

  it('reports where in the tree the problem is', () => {
    const nested = { id: 'root', transform: { position: vec3(0, 0, 0) }, components: [], children: [{ id: 'kid', components: [] }] }
    expect(() => validateLevel(level([nested]))).toThrow(/level\.nodes\[0\]\.children\[0\]/)
  })
})

describe('components on a node', () => {
  it('rejects one with no id or no type', () => {
    expect(() => validateLevel(level([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [{ type: 'Collider', params: {} }] }]))).toThrow(/\.id/)
    expect(() => validateLevel(level([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [{ id: 'c', params: {} }] }]))).toThrow(/\.type/)
  })

  // An override names a component by id *within its node*, and nothing else tells two colliders apart.
  it('rejects the same component id twice on one node', () => {
    const node = { id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER), comp('c0', RENDERER)] }
    expect(() => validateLevel(level([node]))).toThrow(/used twice on this node/)
  })

  it('rejects a non-boolean enabled', () => {
    const node = { id: 'n', transform: { position: vec3(0, 0, 0) }, components: [{ id: 'c0', type: COLLIDER, params: {}, enabled: 'yes' }] }
    expect(() => validateLevel(level([node]))).toThrow(/enabled/)
  })
})

describe('prefab references', () => {
  const pad = { id: 'root', name: 'pad', transform: { position: vec3(0, 0, 0) }, components: [], children: [solid('p0')] }
  const placement = (extra: Record<string, unknown> = {}): unknown => ({ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'pad', ...extra })

  it('accepts a placement of a prefab in the table', () => {
    expect(() => validateLevel(level([placement()], { pad }))).not.toThrow()
  })

  it('rejects a reference to a prefab that is not there', () => {
    expect(() => validateLevel(level([placement({ prefab: 'ghost' })], { pad }))).toThrow(/is not in level\.prefabs/)
  })

  /** Prefab-in-prefab needs cycle detection a tree of plain nodes does not (ADR 0023, ADR 0035). */
  it('rejects a prefab reference *inside* a prefab', () => {
    const nested = { ...pad, children: [{ id: 'inner', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'pad' }] }
    expect(() => validateLevel(level([], { pad: nested }))).toThrow(/cannot reference another prefab/)
  })

  it('validates the prefab table as well as the nodes that use it', () => {
    expect(() => validateLevel(level([], { pad: { id: 'root', components: [] } }))).toThrow(/level\.prefabs\['pad'\]\.transform/)
  })
})

describe('overrides', () => {
  const pad = { id: 'root', transform: { position: vec3(0, 0, 0) }, components: [], children: [solid('p0')] }
  const withOverrides = (overrides: unknown): unknown =>
    level([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'pad', overrides }], { pad })

  it('accepts every part of one', () => {
    const full = { p0: { transform: { position: vec3(1, 2, 3) }, name: 'moved', params: { p0c1: { material: 'm' } }, enabled: { p0c0: false }, added: [comp('a0', RENDERER)], removed: ['p0c1'] } }
    expect(() => validateLevel(withOverrides(full))).not.toThrow()
  })

  it('rejects a removal list that is not strings', () => {
    expect(() => validateLevel(withOverrides({ p0: { removed: [7] } }))).toThrow(/removed\[0\]/)
  })

  it('rejects a non-boolean in the enabled map', () => {
    expect(() => validateLevel(withOverrides({ p0: { enabled: { p0c0: 'off' } } }))).toThrow(/enabled\['p0c0'\]/)
  })

  it('validates an added component like any other', () => {
    expect(() => validateLevel(withOverrides({ p0: { added: [{ type: RENDERER, params: {} }] } }))).toThrow(/added\[0\]\.id/)
  })

  /**
   * An override for a node the prefab no longer has is **inert, not an error**. That is what lets a prefab lose
   * a node without every placement that had touched it failing to load (ADR 0033).
   */
  it('accepts an override keyed by a node that does not exist', () => {
    expect(() => validateLevel(withOverrides({ ghost: { name: 'nobody' } }))).not.toThrow()
  })
})

describe('parameters, when a registry is supplied', () => {
  /** A stand-in for `@mp/components`' registry: this package must not import it (ADR 0035). */
  const checker = {
    checkParams: (type: string, raw: Record<string, unknown> | undefined, at: string): void => {
      if (type !== COLLIDER) throw new Error(`${at}: unknown component type '${type}'`)
      if (typeof raw?.shape !== 'object') throw new Error(`${at}.shape: expected a collider shape`)
    },
  }

  it('checks nothing without one, so a structural pass stays structural', () => {
    expect(() => validateLevel(level([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', 'Whatever', { nonsense: 1 })] }]))).not.toThrow()
  })

  it('reports a bad parameter through the checker, with its path', () => {
    const node = { id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, {})] }
    expect(() => validateLevel(level([node]), checker)).toThrow(/level\.nodes\[0\]\.components\[0\]\.params\.shape/)
  })

  it('reports a component type this build does not have', () => {
    const node = { id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', 'Ghost')] }
    expect(() => validateLevel(level([node]), checker)).toThrow(/unknown component type 'Ghost'/)
  })

  it('checks the prefab table and the added components in an override too', () => {
    const pad = { id: 'root', transform: { position: vec3(0, 0, 0) }, components: [comp('rc0', COLLIDER, {})] }
    expect(() => validateLevel(level([], { pad }), checker)).toThrow(/level\.prefabs\['pad'\]\.components\[0\]/)
  })
})
