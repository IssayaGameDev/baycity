import { describe, expect, it } from 'vitest'
import { ComponentError, defaultsOf, readParams, visibleParams, type ParamDecls } from './params'
import { Bumper } from './shared/bumper'
import { Sequence } from './shared/sequence'
import { Collider } from './engine/collider'
import { Renderer } from './engine/renderer'

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
    r: { kind: 'nodeRef' },
    c: { kind: 'componentRef', of: 'Collider' },
  } satisfies ParamDecls

  it('defaults every declared key, and forces the one that has no default of its own', () => {
    expect(defaultsOf(decls)).toEqual({ n: 7, b: true, s: 'hi', e: 'a', v: { x: 0, y: 1, z: 0 }, m: '', r: null, c: null })
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

  it('takes a component ref as a node and a component, or null (ADR 0177)', () => {
    expect(readParams(decls, { c: { node: 'zone', component: 'col' } }, at).c).toEqual({ node: 'zone', component: 'col' })
    expect(readParams(decls, { c: null }, at).c).toBeNull()
    expect(() => readParams(decls, { c: { node: 'zone' } }, at)).toThrow(/expected \{ node, component \} or null/)
    expect(() => readParams(decls, { c: 3 }, at)).toThrow(/expected \{ node, component \} or null/)
  })

  // The old shape, until the box's content is migrated: the node's first component of the type.
  it('reads a component ref saved as a bare node id as that node’s first of the type', () => {
    expect(readParams(decls, { c: 'zone' }, at).c).toEqual({ node: 'zone', component: '' })
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

describe('the declaration drives the value type', () => {
  /**
   * Compile-time assertions: `tsc --noEmit` covers `src/**`, so these annotations fail the typecheck if
   * the `const` type parameter on `defineComponent` ever stops preserving the declaration. `power` widening
   * to `unknown` or `loop` widening to `string` is exactly the regression that would make every component's
   * own code need casts.
   */
  it('keeps a number a number and an enum its own literal union', () => {
    const power: number = readParams(Bumper.params, { power: 30 }, at).power
    const clock: 'shared' | 'local' = readParams(Sequence.params, {}, at).clock
    const material: string = readParams(Renderer.params, {}, at).material
    expect([power, clock, material]).toEqual([30, 'shared', ''])
  })
})

describe('which parameters are worth showing', () => {
  const decls = {
    source: { kind: 'enum', options: ['collider', 'model'], default: 'collider' },
    model: { kind: 'asset', of: 'model', default: '', when: { param: 'source', is: ['model'] } },
    material: { kind: 'asset', of: 'material', default: '' },
  } satisfies ParamDecls

  it('hides a parameter its condition rules out', () => {
    expect(visibleParams(decls, { source: 'collider' })).toEqual(['source', 'material'])
  })

  it('shows it once the condition holds', () => {
    expect(visibleParams(decls, { source: 'model' })).toEqual(['source', 'model', 'material'])
  })

  it('reads the condition against the default when nothing is stored', () => {
    expect(visibleParams(decls, {})).toEqual(['source', 'material'])
  })

  // Hiding is presentation only. The value stays, so switching back finds it where it was left.
  it('says nothing about the data: a hidden parameter is still read and defaulted', () => {
    expect(readParams(decls, { source: 'collider', model: 'mesh1' }, at).model).toBe('mesh1')
  })

  // A typo in a declaration should not make a control vanish with no explanation.
  it('shows a parameter whose condition names something that does not exist', () => {
    const bad = { a: { kind: 'bool', default: true }, b: { kind: 'bool', default: true, when: { param: 'ghost', is: [true] } } } satisfies ParamDecls
    expect(visibleParams(bad, {})).toEqual(['a', 'b'])
  })
})

/** The `color` kind, added for `Light` (ADR 0047). */
describe('a colour parameter', () => {
  const decls = { tint: { kind: 'color', default: '#ffffff' } } as const

  it('accepts #rrggbb', () => {
    expect(readParams(decls, { tint: '#ff8800' }, 'at').tint).toBe('#ff8800')
  })

  // The failure a plain string allows: a bad value reaching a shader as black, with nothing said.
  it('rejects anything that is not a hex colour', () => {
    for (const bad of ['reddish', '#fff', 'ff8800', '#gggggg', '#ff88000', 12]) {
      expect(() => readParams(decls, { tint: bad }, 'at')).toThrow(/#rrggbb/)
    }
  })

  it('falls back to its default when absent', () => {
    expect(readParams(decls, {}, 'at').tint).toBe('#ffffff')
  })
})
