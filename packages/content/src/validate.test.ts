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
  config: {},
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

  /**
   * The config block is the engine's now (ADR 0052): which game the level is for, and the environment. A
   * game's rules are components on nodes (ADR 0053), so there is no settings bag to check.
   */
  it('rejects a mode block it cannot resolve to a game', () => {
    expect(() => validateLevel({ id: 'l', config: { mode: {} }, nodes: [] })).toThrow(/mode\.name/)
    expect(() => validateLevel({ id: 'l', config: { mode: { name: '' } }, nodes: [] })).toThrow(/mode\.name/)
    expect(() => validateLevel({ id: 'l', config: { mode: 'parkour' }, nodes: [] })).toThrow(/config\.mode/)
  })

  it('accepts a level with no mode at all, which is what an unassigned one looks like', () => {
    expect(() => validateLevel({ id: 'l', config: {}, nodes: [] })).not.toThrow()
    expect(() => validateLevel({ id: 'l', config: { mode: { name: 'parkour' } }, nodes: [] })).not.toThrow()
  })

  it('rejects a missing node list, which is what a pre-component file looks like', () => {
    expect(() => validateLevel({ id: 'l', config: {}, instances: [] })).toThrow(/level\.nodes/)
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

  /**
   * A reference with no definition to resolve is inert, not invalid (ADR 0091): a level is validated where
   * nothing can resolve one — the content server has no asset database — and a deleted prefab file must leave
   * a gap rather than stop everyone opening the level.
   */
  it('accepts a reference to a prefab that is not there', () => {
    expect(() => validateLevel(level([placement({ prefab: 'ghost' })], { pad }))).not.toThrow()
    expect(() => validateLevel(level([placement()]))).not.toThrow()
  })

  it('still rejects a reference that is not a string', () => {
    expect(() => validateLevel(level([placement({ prefab: 7 })], { pad }))).toThrow(/expected a prefab asset id/)
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

  // What a placement added under a piece is part of the level's tree (ADR 0135), checked as such (ADR 0151).
  it('checks the children a placement added as nodes of the level, ids included', () => {
    expect(() => validateLevel(withOverrides({ p0: { addedChildren: [solid('flag')], childOrder: ['flag', 'p0'] } }))).not.toThrow()
    expect(() => validateLevel(withOverrides({ p0: { addedChildren: [solid('n0')] } })), 'an id the level already uses').toThrow(/used twice/)
    expect(() => validateLevel(withOverrides({ p0: { addedChildren: [{ id: 'x' }] } }))).toThrow(/addedChildren\[0\]\.transform/)
  })

  it('rejects an order or a removal that is not node ids', () => {
    expect(() => validateLevel(withOverrides({ p0: { childOrder: [3] } }))).toThrow(/childOrder\[0\]/)
    expect(() => validateLevel(withOverrides({ p0: { removedNodes: 'p0' } }))).toThrow(/removedNodes/)
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

/**
 * The environment block (ADR 0048): sun, ambient, sky, post-FX, all optional.
 *
 * Optionality is the load-bearing part. A level that pins only its sun must keep the renderer's sky, and a
 * level written before this existed must still load — so absent is never an error and malformed always is.
 */
describe('the environment block', () => {
  const withEnv = (environment: unknown): unknown => ({
    id: 'l',
    config: { environment },
    nodes: [],
  })
  const sun = { elevation: 30, azimuth: 38, intensity: 2.4, color: '#ffffff', shadows: true }
  const sky = {
    topColor: '#2f86cc',
    bottomColor: '#0a1424',
    gradientBias: 1.15,
    gain: 2.6,
    glowColor: '#ffe6c0',
    glowSharpness: 200,
    glowStrength: 0.25,
    sunDiskIntensity: 400,
  }

  const postfx = { ao: true, bloom: true, bloomStrength: 0.1 }

  it('accepts a full one', () => {
    expect(() => validateLevel(withEnv({ sun, ambient: { intensity: 0.2 }, sky, postfx }))).not.toThrow()
  })

  it('accepts a level with no environment at all', () => {
    expect(() => validateLevel({ id: 'l', config: {}, nodes: [] })).not.toThrow()
  })

  // The point of Partial: pinning the sun must not force you to restate a sky you have no opinion about.
  it('accepts any one part on its own', () => {
    expect(() => validateLevel(withEnv({ sun }))).not.toThrow()
    expect(() => validateLevel(withEnv({ ambient: { intensity: 0 } }))).not.toThrow()
    expect(() => validateLevel(withEnv({ sky }))).not.toThrow()
    expect(() => validateLevel(withEnv({ postfx }))).not.toThrow()
    expect(() => validateLevel(withEnv({}))).not.toThrow()
  })

  it('rejects a non-finite sun angle, which would aim the sun nowhere in silence', () => {
    expect(() => validateLevel(withEnv({ sun: { ...sun, elevation: Number.NaN } }))).toThrow(/environment\.sun\.elevation/)
    expect(() => validateLevel(withEnv({ sun: { ...sun, azimuth: 'south' } }))).toThrow(/environment\.sun\.azimuth/)
  })

  it('rejects a colour that is not #rrggbb, the same rule the component layer applies', () => {
    expect(() => validateLevel(withEnv({ sun: { ...sun, color: 'white' } }))).toThrow(/#rrggbb/)
    expect(() => validateLevel(withEnv({ sky: { ...sky, topColor: '#fff' } }))).toThrow(/topColor/)
  })

  it('rejects a non-boolean shadows flag', () => {
    expect(() => validateLevel(withEnv({ sun: { ...sun, shadows: 'on' } }))).toThrow(/environment\.sun\.shadows/)
  })

  it('rejects a bad sky number, naming which one', () => {
    expect(() => validateLevel(withEnv({ sky: { ...sky, gain: 'lots' } }))).toThrow(/environment\.sky\.gain/)
  })

  /**
   * Post-FX is level data because it is tuned against the light (ADR 0057). Every app used to hardcode its
   * own and they had drifted, so what matters is that a level saying otherwise is honoured at all.
   */
  it('rejects a post-FX switch that is not a boolean', () => {
    expect(() => validateLevel(withEnv({ postfx: { ...postfx, ao: 'on' } }))).toThrow(/environment\.postfx\.ao/)
    expect(() => validateLevel(withEnv({ postfx: { ...postfx, bloom: 1 } }))).toThrow(/environment\.postfx\.bloom/)
  })

  it('rejects a bad bloom strength', () => {
    expect(() => validateLevel(withEnv({ postfx: { ...postfx, bloomStrength: 'lots' } }))).toThrow(/postfx\.bloomStrength/)
  })

  it('rejects parts that are not objects', () => {
    expect(() => validateLevel(withEnv(30))).toThrow(/config\.environment/)
    expect(() => validateLevel(withEnv({ ambient: 0.2 }))).toThrow(/environment\.ambient/)
    expect(() => validateLevel(withEnv({ postfx: true }))).toThrow(/environment\.postfx/)
  })
})
