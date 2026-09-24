import { describe, expect, it } from 'vitest'

import { Bumper, Hazard } from './gameplay'
import { isSharedComponent, SHARED_COMPONENT_TYPES, sharedComponents } from './shared'

/** The shared-component lookup a game's data file resolves through (ADR 0077). */
describe('shared components', () => {
  it('is the gameplay set, by name', () => {
    expect(SHARED_COMPONENT_TYPES).toEqual(['Boss', 'Bumper', 'Checkpoint', 'Goal', 'Hazard', 'Sequence'])
  })

  it('resolves names to definitions, in the order given', () => {
    expect(sharedComponents(['Hazard', 'Bumper'])).toEqual([Hazard, Bumper])
  })

  // A data file naming something the build cannot supply must fail loudly, not leave a hole in the registry.
  it('refuses a name that is not shared — an engine, player or private component', () => {
    expect(() => sharedComponents(['Collider'])).toThrow(/not a shared component/)
    expect(() => sharedComponents(['Keyboard'])).toThrow(/not a shared component/)
    expect(isSharedComponent('Bumper')).toBe(true)
    expect(isSharedComponent('Keyboard')).toBe(false)
  })
})
