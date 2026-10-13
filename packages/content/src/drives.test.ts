import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { drivenComponents } from './drives'
import { instantiateLevel } from './loader'
import { COLLIDER, TEXT, type Drive, type TypeInfo } from './nodes'
import type { ComponentData, Level, Node } from './types'

/**
 * What a component sets on another it points at (ADR 0210), applied by the loader once the tree is built: the target
 * node's components carry it, and a driven text is drawn with it. An obstacle setting its pad's wins and its sign.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })

/** `Driver` writes its `words` into the Text its `sign` points at, and its `n` into a `Pad`'s `wins`. */
const TYPES: TypeInfo = {
  get: (type) =>
    type === 'Driver'
      ? {
          singleton: true,
          drives: (p): Drive[] => [
            { ref: (p.sign ?? null) as Drive['ref'], type: TEXT, params: { text: String(p.words) } },
            { ref: (p.pad ?? null) as Drive['ref'], type: 'Pad', params: { wins: p.n } },
          ],
        }
      : type === COLLIDER
        ? {}
        : { singleton: true },
}

const sign = (id: string, words = 'Text'): Node => ({ id, transform: { position: vec3(0, 2, 0) }, components: [comp(`${id}-t`, TEXT, { text: words })] })
const pad = (id: string): Node => ({ id, transform: { position: vec3(0, 0, 0) }, components: [comp(`${id}-p`, 'Pad', { wins: 1 })] })
const driver = (id: string, to: { sign?: string; pad?: string }, words: string, n = 5): Node => ({
  id,
  transform: { position: vec3(0, 0, 0) },
  components: [
    comp(`${id}-d`, 'Driver', {
      words,
      n,
      ...(to.sign === undefined ? {} : { sign: { node: to.sign, component: '' } }),
      ...(to.pad === undefined ? {} : { pad: { node: to.pad, component: '' } }),
    }),
  ],
})
const load = (nodes: Node[], prefabs?: Record<string, Node>) =>
  instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), { id: 'fx', config: {}, nodes, ...(prefabs === undefined ? {} : { prefabs }) } as Level, TYPES)

beforeAll(async () => {
  await initPhysics()
})

describe('a component setting another’s parameters', () => {
  it('sets them over the target’s own, in its components and in the text drawn — the target before or after it', () => {
    const loaded = load([sign('before'), driver('d', { sign: 'before', pad: 'after' }, 'Requires Level 12', 40), pad('after')])
    const before = loaded.allNodes.find((n) => n.id === 'before')!
    const after = loaded.allNodes.find((n) => n.id === 'after')!
    expect(before.components[0]!.params.text).toBe('Requires Level 12')
    expect(after.components[0]!.params.wins).toBe(40)
    expect(loaded.texts.find((t) => t.node === 'before')!.text).toBe('Requires Level 12')
  })

  it('leaves alone what nothing points at, and a reference that does not resolve', () => {
    const loaded = load([sign('s', 'mine'), driver('d', { sign: 'gone' }, 'lost')])
    expect(loaded.texts.find((t) => t.node === 's')!.text).toBe('mine')
  })

  it('reaches each placement’s own copy from inside a prefab', () => {
    const room: Node = { id: 'root', transform: { position: vec3(0, 0, 0) }, components: driver('root', { sign: 'board' }, 'x').components, children: [sign('board')] }
    const placement = (id: string, words: string): Node => ({
      id,
      transform: { position: vec3(0, 0, 0) },
      components: [],
      prefab: 'room',
      overrides: { root: { params: { 'root-d': { words } } } },
    } as Node)
    const loaded = load([placement('a', 'Level 1'), placement('b', 'Level 2')], { room })
    expect(loaded.texts.map((t) => t.text)).toEqual(['Level 1', 'Level 2'])
  })
})

describe('drivenComponents', () => {
  const two = [comp('t1', TEXT, { text: 'one', size: 2 }), comp('t2', TEXT, { text: 'two' })]
  it('patches the one with the reference’s id, or the first of the type for none, keeping the rest of its parameters', () => {
    expect(drivenComponents(two, [{ ref: { node: 'n', component: 't2' }, type: TEXT, params: { text: 'b' } }]).map((c) => c.params.text)).toEqual(['one', 'b'])
    const first = drivenComponents(two, [{ ref: { node: 'n', component: '' }, type: TEXT, params: { text: 'a' } }])
    expect(first[0]!.params).toEqual({ text: 'a', size: 2 })
    expect(two[0]!.params.text, 'a new array, new objects: the original is untouched').toBe('one')
  })
})
