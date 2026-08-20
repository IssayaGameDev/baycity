import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { validateLevel } from './validate'

const valid = {
  id: 'level1',
  config: { fallBehavior: 'respawn-checkpoint', fallY: -5 },
  prefabs: {
    pad: {
      id: 'pad',
      pieces: [{ collider: { kind: 'box', halfExtents: { x: 1, y: 0.2, z: 1 } }, transform: { position: { x: 0, y: 0, z: 0 } } }],
    },
  },
  instances: [{ prefab: 'pad', transform: { position: { x: 0, y: 0, z: 0 } } }],
}

describe('validateLevel', () => {
  it('accepts a well-formed level', () => {
    expect(validateLevel(structuredClone(valid)).id).toBe('level1')
  })

  it('rejects a bad fallBehavior', () => {
    expect(() => validateLevel({ ...valid, config: { fallBehavior: 'nope', fallY: 0 } })).toThrow()
  })

  it('rejects an instance referencing an unknown prefab', () => {
    expect(() => validateLevel({ ...valid, instances: [{ prefab: 'ghost', transform: { position: { x: 0, y: 0, z: 0 } } }] })).toThrow()
  })

  it('rejects an instance missing its transform', () => {
    expect(() => validateLevel({ ...valid, instances: [{ prefab: 'pad' }] })).toThrow()
  })
})

describe('trigger validation (ADR 0032)', () => {
  const withTrigger = (trigger: unknown): unknown => ({
    id: 'l',
    config: { fallBehavior: 'physical-fall', fallY: -10 },
    instances: [
      {
        prefab: { id: 'p', pieces: [{ collider: { kind: 'box', halfExtents: vec3(1, 1, 1) }, transform: { position: vec3(0, 0, 0) }, trigger }] },
        transform: { position: vec3(0, 0, 0) },
      },
    ],
  })

  it('accepts the four kinds', () => {
    for (const kind of ['checkpoint', 'goal', 'hazard']) expect(() => validateLevel(withTrigger({ kind })), kind).not.toThrow()
    expect(() => validateLevel(withTrigger({ kind: 'bumper', power: 26 }))).not.toThrow()
  })

  it('accepts a piece with no trigger at all', () => {
    expect(() => validateLevel(withTrigger(undefined))).not.toThrow()
  })

  // The pre-ADR-0032 shape. Saying so beats a piece that silently never fires.
  it('rejects the old bare-string form by name', () => {
    expect(() => validateLevel(withTrigger('hazard'))).toThrow(/not a bare string/)
  })

  it('rejects an unknown kind', () => {
    expect(() => validateLevel(withTrigger({ kind: 'lava' }))).toThrow(/expected 'checkpoint'/)
  })

  /**
   * The reason `power` is validated rather than defaulted: it reaches `CharacterState.launch` and then `vy`,
   * so a missing or nonsense value puts the player at `NaN` with nothing to explain it.
   */
  it('rejects a bumper whose power is missing or not a usable number', () => {
    expect(() => validateLevel(withTrigger({ kind: 'bumper' }))).toThrow(/power/)
    expect(() => validateLevel(withTrigger({ kind: 'bumper', power: '26' }))).toThrow(/power/)
    expect(() => validateLevel(withTrigger({ kind: 'bumper', power: 0 }))).toThrow(/above zero/)
    expect(() => validateLevel(withTrigger({ kind: 'bumper', power: -5 }))).toThrow(/above zero/)
    expect(() => validateLevel(withTrigger({ kind: 'bumper', power: Number.NaN }))).toThrow(/power/)
  })
})
