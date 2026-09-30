import { describe, expect, it } from 'vitest'
import { createRegistry } from './registry'
import { defineComponent } from './define'
import { ComponentError } from './params'
import { DEFAULT_REGISTRY } from './defaults'
import { Bumper } from './shared/bumper'
import { Sequence } from './shared/sequence'
import { Collider } from './engine/collider'
import { Renderer } from './engine/renderer'

const Fake = defineComponent({ type: 'Fake', params: { n: { kind: 'number', default: 1 } } })
const Other = defineComponent({ type: 'Other', params: {} })

describe('the registry', () => {
  it('finds what was registered and nothing else', () => {
    const reg = createRegistry([Fake, Other])
    expect(reg.has('Fake')).toBe(true)
    expect(reg.get('Other')).toBe(Other)
    expect(reg.has('Nope')).toBe(false)
    expect(reg.get('Nope')).toBeUndefined()
  })

  it('lists in declaration order, which is the order the add menu shows', () => {
    expect(createRegistry([Fake, Other]).all().map((d) => d.type)).toEqual(['Fake', 'Other'])
  })

  // A shadowed registration is silent at runtime and shows up as a component whose fields are the other
  // one's. Same reason `createShortcuts` throws on a duplicate chord.
  it('refuses a duplicate type instead of letting the second one win', () => {
    expect(() => createRegistry([Fake, Fake])).toThrow(/duplicate component type 'Fake'/)
  })

  it('hands out defaults for a fresh component', () => {
    expect(createRegistry([Fake]).defaults('Fake')).toEqual({ n: 1 })
    expect(DEFAULT_REGISTRY.defaults('Bumper')).toEqual({ power: 26 })
  })

  it('checks parameters against the declaration, and says where', () => {
    const reg = createRegistry([Fake])
    expect(() => reg.checkParams('Fake', { n: 3 }, 'at')).not.toThrow()
    expect(() => reg.checkParams('Fake', { n: 'three' }, 'nodes[2]')).toThrow(/nodes\[2\]\.n: expected a number/)
  })

  it('treats an unknown component type as an error, with the path that named it', () => {
    expect(() => createRegistry([Fake]).checkParams('Ghost', {}, 'nodes[4]')).toThrow(/nodes\[4\]: unknown component type 'Ghost'/)
    expect(() => createRegistry([Fake]).defaults('Ghost')).toThrow(ComponentError)
  })
})

describe('the built-in registry', () => {
  it('holds the built-in components, engine first', () => {
    expect(DEFAULT_REGISTRY.all().map((d) => d.type)).toEqual([
      'Collider',
      'Renderer',
      'MaterialOverride',
      'Spawn',
      'Light',
      'Checkpoint',
      'Hazard',
      'Bumper',
      'Sequence',
      'Boss',
    ])
  })

  it('makes colliders and sequences repeatable, and everything else at most one per node', () => {
    // A node can genuinely have two colliders, and several sequences on one node each loop on their own and
    // combine (ADR 0137).
    expect(Collider.singleton).toBeUndefined()
    expect(DEFAULT_REGISTRY.get('Sequence')?.singleton).toBeUndefined()
    for (const type of ['Renderer', 'MaterialOverride', 'Spawn', 'Checkpoint', 'Hazard', 'Bumper'])
      expect(DEFAULT_REGISTRY.get(type)?.singleton, type).toBe(true)
  })

  it('defaults a bumper to above a jump, which is the only reason the number is 26', () => {
    // Jump leaves the ground at sqrt(2 * 55 * 3) = 18.17 m/s, so anything below that is a soft catch.
    expect(DEFAULT_REGISTRY.defaults('Bumper').power).toBeGreaterThan(Math.sqrt(2 * 55 * 3))
  })

  // No model and unsurfaced: a fresh Mesh Renderer draws the node's colliders in grey, which is what greybox
  // means (ADR 0153).
  it('starts a Mesh Renderer drawing its colliders, unsurfaced', () => {
    expect(DEFAULT_REGISTRY.defaults('Renderer')).toEqual({ model: '', material: '' })
    expect(Renderer.label).toBe('Mesh Renderer')
  })

  it('offers only model assets where a model belongs, and material assets where a material does', () => {
    expect(Renderer.params.model.of).toBe('model')
    expect(Renderer.params.material.of).toBe('material')
  })

  // Folded into the Mesh Renderer on every file (ADR 0153): a file still carrying one no longer loads.
  it('has no Mesh any more', () => {
    expect(DEFAULT_REGISTRY.has('Mesh')).toBe(false)
  })

  it('carries the bumper default in the schema, not in the editor', () => {
    expect(Bumper.params.power.default).toBe(26)
  })
})

describe('assetParamIds (ADR 0082)', async () => {
  const { assetParamIds } = await import('./read')
  const { defineComponent } = await import('./define')
  const { createRegistry } = await import('./registry')
  const Pad = defineComponent({
    type: 'Pad',
    params: {
      active: { kind: 'asset', of: 'material', default: '' },
      idle: { kind: 'asset', of: 'material', default: '' },
      look: { kind: 'asset', of: 'model', default: '' },
      n: { kind: 'number', default: 1 },
    },
  })
  const reg = createRegistry([Pad])
  const nodes = [
    { components: [{ id: 'a', type: 'Pad', params: { active: 'm1', idle: '', look: 'mod1', n: 3 } }] },
    { components: [{ id: 'b', type: 'Pad', params: { active: 'm2', idle: 'm1' } }] },
    { components: [{ id: 'c', type: 'Unknown', params: { active: 'zzz' } }] },
  ]

  it('collects every named asset once, skipping empties and unknown components', () => {
    expect(assetParamIds(nodes, reg).sort()).toEqual(['m1', 'm2', 'mod1'])
  })

  it('filters by kind', () => {
    expect(assetParamIds(nodes, reg, 'material').sort()).toEqual(['m1', 'm2'])
    expect(assetParamIds(nodes, reg, 'model')).toEqual(['mod1'])
  })
})

/** A sequence's stages are checked whole at load (ADR 0137), where a broken one would otherwise reach the frame tree. */
describe('the Sequence component', () => {
  const reg = createRegistry([Sequence])
  const move = { id: 'm', kind: 'move', to: { x: 0, y: 1, z: 0 }, timing: { by: 'speed', speed: 2 }, ease: 'in-out-sine' }

  it('starts with no stages and the shared clock', () => {
    expect(reg.defaults('Sequence')).toEqual({ name: '', clock: 'shared', axes: 'object', loop: 'restart', times: 0, offset: 0, stages: [] })
  })

  it('accepts stages that check out', () => {
    expect(() => reg.checkParams('Sequence', { stages: [{ id: 's', steps: [move] }] }, 'nodes[0].components[1]')).not.toThrow()
  })

  it('refuses a broken step, saying where', () => {
    expect(() => reg.checkParams('Sequence', { stages: [{ id: 's', steps: [{ ...move, ease: 'wobble' }] }] }, 'nodes[0].components[1]')).toThrow(
      /nodes\[0\]\.components\[1\]\.stages\[0\]\.steps\[0\]\.ease/,
    )
  })
})
