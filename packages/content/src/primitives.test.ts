import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { builtinShape, isBuiltinModel, scaleCollider, unitColliderFor } from './primitives'

describe('built-in shapes', () => {
  it('knows its ids and nothing else', () => {
    expect(isBuiltinModel('builtin:box')).toBe(true)
    expect(isBuiltinModel('builtin:cylinder')).toBe(false)
    expect(isBuiltinModel('a1b2c3d4e5f6a7b8')).toBe(false)
    expect(isBuiltinModel(undefined)).toBe(false)
  })

  it('a built-in at a scale is its unit collider scaled, and only the rounded box rounds', () => {
    expect(builtinShape('builtin:rounded-box', vec3(3, 0.3, 3))).toEqual({ collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, rounded: true })
    expect(builtinShape('builtin:box', vec3(2, 2, 2)).rounded).toBe(false)
    expect(builtinShape('builtin:sphere', vec3(2, 2, 2)).collider).toEqual({ kind: 'ball', radius: 1 })
    expect(builtinShape('builtin:capsule', vec3(1, 2, 1)).collider).toEqual({ kind: 'capsule', halfHeight: 1, radius: 0.5 })
  })

  /** A quad (ADR 0189): a 1 × 1 face, colliding as a centimetre-thick box its scale sizes. */
  it('a quad collides as a thin square its scale sizes', () => {
    expect(isBuiltinModel('builtin:quad')).toBe(true)
    expect(builtinShape('builtin:quad', vec3(4, 2, 1)).collider).toEqual({ kind: 'box', halfExtents: vec3(2, 1, 0.005) })
  })

  it('scales a box exactly and averages a ball, as the loader always has', () => {
    expect(scaleCollider(unitColliderFor('builtin:box'), vec3(4, 1, 2))).toEqual({ kind: 'box', halfExtents: vec3(2, 0.5, 1) })
    expect(scaleCollider(unitColliderFor('builtin:sphere'), vec3(1, 2, 3))).toEqual({ kind: 'ball', radius: 1 })
  })
})
