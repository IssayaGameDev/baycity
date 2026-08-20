import { describe, expect, it } from 'vitest'
import { ComponentError, defaultsOf, readParams, type ParamDecls } from './params'
import { Bumper, Track } from './gameplay'
import { Collider, Visual } from './engine'

const at = 'node[0].components[0]'
const vec = (n: number): { x: number; y: number; z: number } => ({ x: n, y: n, z: n })

describe('declared parameters', () => {
  const decls = {
    n: { kind: 'number', default: 7 },
    b: { kind: 'bool', default: true },
    s: { kind: 'string', default: 'hi' },
    e: { kind: 'enum', options: ['a', 'b'], default: 'a' },
    v: { kind: 'vec3', default: { x: 0, y: 1, z: 0 } },
    m: { kind: 'asset', of: 'material', default: '' },
    k: { kind: 'keys' },
    r: { kind: 'nodeRef' },
  } satisfies ParamDecls

  it('defaults every declared key, and forces the two that have no default of their own', () => {
    expect(defaultsOf(decls)).toEqual({ n: 7, b: true, s: 'hi', e: 'a', v: { x: 0, y: 1, z: 0 }, m: '', k: [], r: null })
  })

  it('fills what is absent and keeps what is authored', () => {
    expect(readParams(decls, { n: 2 }, at)).toMatchObject({ n: 2, b: true, s: 'hi' })
  })

  // Adding a parameter to a component must not invalidate the levels that already use it.
  it('accepts an empty object, so a new parameter is not a content migration', () => {
    expect(readParams(decls, {}, at)).toEqual(defaultsOf(decls))
    expect(readParams(decls, undefined, at)).toEqual(defaultsOf(decls))
  })

  it('drops an unknown key rather than failing, the way a stale parameter should behave', () => {
    expect(readParams(decls, { n: 1, gone: 'stale' }, at)).not.toHaveProperty('gone')
  })

  it('names the offending parameter in the error, not just the component', () => {
    expect(() => readParams(decls, { n: 'lots' }, at)).toThrow(/node\[0\]\.components\[0\]\.n: expected a number/)
  })

  it('rejects NaN, because it reaches the character as a position and disappears it', () => {
    expect(() => readParams(decls, { n: Number.NaN }, at)).toThrow(ComponentError)
    expect(() => readParams(decls, { n: Number.POSITIVE_INFINITY }, at)).toThrow(ComponentError)
  })

  it('rejects an option outside the enum, and lists what was expected', () => {
    expect(() => readParams(decls, { e: 'c' }, at)).toThrow(/expected one of 'a' \| 'b'/)
  })

  it('rejects a partial Vec3', () => {
    expect(() => readParams(decls, { v: { x: 1, y: 2 } }, at)).toThrow(/expected a Vec3/)
  })

  it('takes a node ref as a string or null, and nothing else', () => {
    expect(readParams(decls, { r: 'node-7' }, at).r).toBe('node-7')
    expect(readParams(decls, { r: null }, at).r).toBeNull()
    expect(() => readParams(decls, { r: 3 }, at)).toThrow(/expected a node id or null/)
  })

  // min/max drive the Inspector's slider. Enforcing them at load would make a bound a schema change.
  it('does not enforce min or max', () => {
    expect(readParams(Bumper.params, { power: 500 }, at).power).toBe(500)
  })
})

describe('collider shapes, which nothing validated before this', () => {
  const read = (shape: unknown): unknown => readParams(Collider.params, { shape }, at).shape

  it('accepts each authored shape', () => {
    expect(read({ kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } })).toBeDefined()
    expect(read({ kind: 'ball', radius: 0.5 })).toBeDefined()
    expect(read({ kind: 'capsule', halfHeight: 1, radius: 0.4 })).toBeDefined()
    expect(read({ kind: 'cylinder', halfHeight: 1, radius: 0.4 })).toBeDefined()
    expect(read({ kind: 'convex', points: [vec(0), vec(1), vec(2), vec(3)] })).toBeDefined()
  })

  it('catches a box with no half extents, which used to reach Rapier as undefined', () => {
    expect(() => read({ kind: 'box' })).toThrow(/halfExtents: expected a Vec3/)
  })

  it('catches a shape kind that does not exist', () => {
    expect(() => read({ kind: 'trimesh' })).toThrow(/expected 'box' \| 'cylinder' \| 'capsule' \| 'ball' \| 'convex'/)
  })

  it('needs four points for a hull, since three cannot enclose a volume', () => {
    expect(() => read({ kind: 'convex', points: [vec(0), vec(1), vec(2)] })).toThrow(/at least 4 points/)
  })

  it('names the bad point', () => {
    expect(() => read({ kind: 'convex', points: [vec(0), vec(1), vec(2), 'nope'] })).toThrow(/\.points\[3\]/)
  })
})

describe('keyframe tracks as a parameter', () => {
  it('accepts a keyed track and defaults to an empty one', () => {
    expect(readParams(Track.params, {}, at).keys).toEqual([])
    expect(readParams(Track.params, { keys: [{ t: 0 }, { t: 500, position: vec(1) }] }, at).keys).toHaveLength(2)
  })

  it('rejects a key with no time', () => {
    expect(() => readParams(Track.params, { keys: [{ position: vec(1) }] }, at)).toThrow(/keys\[0\]\.t/)
  })
})

describe('the declaration drives the value type', () => {
  /**
   * Compile-time assertions: `tsc --noEmit` covers `src/**`, so these annotations fail the typecheck if
   * the `const` type parameter on `defineComponent` ever stops preserving the declaration. `power` widening
   * to `unknown` or `loop` widening to `string` is exactly the regression that would make every component's
   * own code need casts.
   */
  it('keeps a number a number and an enum its own literal union', () => {
    const power: number = readParams(Bumper.params, { power: 30 }, at).power
    const loop: 'loop' | 'pingPong' | 'once' = readParams(Track.params, {}, at).loop
    const source: 'collider' | 'model' = readParams(Visual.params, {}, at).source
    expect([power, loop, source]).toEqual([30, 'loop', 'collider'])
  })
})
