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
