import { describe, expect, it } from 'vitest'
import { createRegistry } from './registry'
import { defineComponent } from './define'
import { ComponentError } from './params'
import { DEFAULT_REGISTRY } from './defaults'
import { Bumper, GAMEPLAY_COMPONENTS, RULE_KINDS, Track } from './gameplay'
import { Collider, Visual } from './engine'

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
  it('holds the nine components C1 migrates onto, engine first', () => {
    expect(DEFAULT_REGISTRY.all().map((d) => d.type)).toEqual([
      'Collider',
      'Visual',
      'MaterialOverride',
      'Spawn',
      'Checkpoint',
      'Goal',
      'Hazard',
      'Bumper',
      'Track',
    ])
  })

  it('makes a collider repeatable and everything else at most one per node', () => {
    expect(Collider.singleton).toBeUndefined()
    for (const type of ['Visual', 'MaterialOverride', 'Spawn', 'Checkpoint', 'Goal', 'Hazard', 'Bumper', 'Track'])
      expect(DEFAULT_REGISTRY.get(type)?.singleton, type).toBe(true)
  })

  it('defaults a bumper to above a jump, which is the only reason the number is 26', () => {
    // Jump leaves the ground at sqrt(2 * 55 * 3) = 18.17 m/s, so anything below that is a soft catch.
    expect(DEFAULT_REGISTRY.defaults('Bumper').power).toBeGreaterThan(Math.sqrt(2 * 55 * 3))
  })

  it('starts a visual unsurfaced and drawing its collider, which is what greybox means', () => {
    expect(DEFAULT_REGISTRY.defaults('Visual')).toEqual({ source: 'collider', model: '', material: '' })
  })

  it('starts a track empty and looping, so adding one moves nothing until keys exist', () => {
    expect(DEFAULT_REGISTRY.defaults('Track')).toEqual({ keys: [], loop: 'loop', phaseMs: 0 })
    expect(Track.params.keys.kind).toBe('keys')
  })

  it('offers only material assets where a material belongs', () => {
    expect(Visual.params.material.of).toBe('material')
    expect(Visual.params.model.of).toBe('model')
  })

  it('carries the bumper default in the schema, not in the editor', () => {
    expect(Bumper.params.power.default).toBe(26)
  })

  // The gizmo table is keyed by strings, so nothing but this stops it drifting from the definitions.
  it('has a gizmo colour for every rule component and for nothing else', () => {
    const rules = GAMEPLAY_COMPONENTS.filter((d) => d !== Track).map((d) => d.type)
    expect(Object.keys(RULE_KINDS).sort()).toEqual([...rules].sort())
  })
})
