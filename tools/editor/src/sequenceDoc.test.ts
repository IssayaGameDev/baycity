import { COLLIDER, SEQUENCE, validateLevel, type ComponentData, type Level, type Node, type Stage, type Step } from '@mp/content'
import { ENGINE_COMPONENTS, GAMEPLAY_COMPONENTS, createRegistry } from '@mp/components'
import { vec3, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc, type Doc } from './editorDoc'

/**
 * Sequences through the editor's document (ADR 0139), and the placement-root fix that came with them: a change
 * to a component on a placement's **root** was saved but counted, applied and reverted by nothing — and a
 * moving platform's sequence usually sits on its prefab's root.
 */

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
/** A game's registry: the engine's components and the shared ones, `Sequence` among them. */
const REG = createRegistry([...ENGINE_COMPONENTS, ...GAMEPLAY_COMPONENTS])
const PAD_ID = 'aaaaaaaaaaaaaaaa'
const move = (id: string, x: number, target?: string): Step => ({
  id,
  kind: 'move',
  to: vec3(x, 0, 0),
  timing: { by: 'seconds', seconds: 1 },
  ease: 'linear',
  ...(target === undefined ? {} : { target }),
})
const STAGES: readonly Stage[] = [
  { id: 's1', steps: [move('a', 1, 'left'), move('b', -1, 'right')] },
  { id: 's2', steps: [{ id: 'w', kind: 'wait', seconds: 2 }] },
]
const sequenceOn = (id: string, stages: readonly Stage[] = STAGES): ComponentData => ({ id, type: SEQUENCE, params: { name: 'open', stages } })
const box: ComponentData = { id: 'rc', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(1, 1, 1) } } }

/** A door: the root carries the sequence and a collider, and the two halves are its children. */
const doorPrefab = (): Node => ({
  id: 'root',
  name: 'door',
  transform: { position: ZERO },
  components: [box, sequenceOn('seq')],
  children: [
    { id: 'left', name: 'left', transform: { position: vec3(-1, 0, 0) }, components: [] },
    { id: 'right', name: 'right', transform: { position: vec3(1, 0, 0) }, components: [sequenceOn('kidseq', [{ id: 'k1', steps: [move('k', 3)] }])] },
  ],
})

const placedDoor = (): { level: Level; doc: Doc } => {
  const level: Level = { id: 'lv', config: {}, nodes: [] }
  const doc = levelDoc(level, REG)
  doc.placePrefab(PAD_ID, doorPrefab(), ZERO)
  return { level, doc }
}
const stagesAt = (doc: Doc, i: number, componentId: string): unknown => doc.components(i).find((c) => c.id === componentId)?.params.stages
const named = (doc: Doc, name: string): number => {
  for (let i = 0; i < doc.count(); i++) if (doc.label(i) === name) return i
  throw new Error(`no node named ${name}`)
}

describe('a change to a placement root’s own component', () => {
  it('is counted, applied to the prefab root and reverted', () => {
    const { level, doc } = placedDoor()
    doc.setParams(0, 'rc', { shape: { kind: 'ball', radius: 2 } })
    expect(doc.placementOverrides(0)).toEqual([{ index: 0, fields: ['Collider'] }])
    expect(doc.components(0).find((c) => c.id === 'rc')?.overridden).toEqual(['shape'])

    const plan = doc.placementOverrideOps(0)
    expect(plan?.assetId).toBe(PAD_ID)
    expect(plan?.ops).toEqual([{ kind: 'setParams', id: 'root', componentId: 'rc', patch: { shape: { kind: 'ball', radius: 2 } } }])

    doc.revertPlacement(0)
    expect(level.nodes[0]!.overrides).toBeUndefined()
    expect(doc.placementOverrides(0)).toEqual([])
  })
})

describe('editing a sequence', () => {
  const opened: readonly Stage[] = [{ id: 's1', steps: [move('a', 4, 'left'), move('b', -1, 'right')] }, STAGES[1]!]

  it('writes its own node’s stages as a parameter', () => {
    const level: Level = { id: 'lv', config: {}, nodes: [{ id: 'n', transform: { position: ZERO }, components: [sequenceOn('seq')] }] }
    const doc = levelDoc(level, REG)
    doc.setSequenceStages(0, 'seq', opened)
    expect(level.nodes[0]!.components[0]!.params.stages).toEqual(opened)
  })

  it('records only what differs on a placement’s root, and shows the result', () => {
    const { level, doc } = placedDoor()
    doc.setSequenceStages(0, 'seq', opened)
    expect(level.nodes[0]!.overrides?.root?.sequences?.seq).toEqual({ steps: { a: { to: vec3(4, 0, 0) } } })
    expect(stagesAt(doc, 0, 'seq')).toEqual(opened)
    expect(doc.overridesOf(0)).toEqual(['Sequence (stages)'])
    validateLevel(JSON.parse(JSON.stringify(level)))
  })

  it('records a structural change on a piece the same way', () => {
    const { level, doc } = placedDoor()
    const right = named(doc, 'right')
    const want: readonly Stage[] = [{ id: 'k1', steps: [move('k', 3)] }, { id: 'mine', steps: [{ id: 'z', kind: 'wait', seconds: 1 }] }]
    doc.setSequenceStages(right, 'kidseq', want)
    expect(stagesAt(doc, right, 'kidseq')).toEqual(want)
    // No order recorded: an added stage goes last and an added step into the last stage, which is where these are.
    expect(level.nodes[0]!.overrides?.right?.sequences?.kidseq).toEqual({ addedSteps: [{ id: 'z', kind: 'wait', seconds: 1 }], addedStages: ['mine'] })
  })

  it('writes nothing when the stages are what the prefab already has', () => {
    const { level, doc } = placedDoor()
    const before = JSON.stringify(level)
    doc.setSequenceStages(0, 'seq', STAGES)
    expect(JSON.stringify(level)).toBe(before)
  })

  it('applies to the prefab as the stages the placement shows', () => {
    const { doc } = placedDoor()
    doc.setSequenceStages(0, 'seq', opened)
    expect(doc.placementOverrideOps(0)?.ops).toEqual([{ kind: 'setParams', id: 'root', componentId: 'seq', patch: { stages: opened } }])
  })

  it('reverts to the prefab’s sequence, alone or with everything else', () => {
    const { doc } = placedDoor()
    doc.setSequenceStages(0, 'seq', opened)
    doc.revert(0, 'seq')
    expect(stagesAt(doc, 0, 'seq')).toEqual(STAGES)
    doc.setSequenceStages(0, 'seq', opened)
    doc.revertPlacement(0)
    expect(stagesAt(doc, 0, 'seq')).toEqual(STAGES)
  })

  it('drops the record when the component is removed from the placement', () => {
    const { level, doc } = placedDoor()
    doc.setSequenceStages(0, 'seq', opened)
    doc.removeComponent(0, 'seq')
    expect(level.nodes[0]!.overrides?.root?.sequences).toBeUndefined()
    expect(level.nodes[0]!.overrides?.root?.removed).toEqual(['seq'])
  })
})

/** A step's target is a node reference: a copy's sequence must move the copy's children, not the original's. */
describe('duplicating an object with a sequence', () => {
  it('points the copy’s steps at the copy’s children', () => {
    const level: Level = {
      id: 'lv',
      config: {},
      nodes: [
        {
          id: 'door',
          name: 'door',
          transform: { position: ZERO },
          components: [sequenceOn('seq')],
          children: [
            { id: 'left', name: 'left', transform: { position: ZERO }, components: [] },
            { id: 'right', name: 'right', transform: { position: ZERO }, components: [] },
          ],
        },
      ],
    }
    const doc = levelDoc(level, REG)
    doc.duplicate(0)
    const copy = level.nodes[1]!
    const kids = (copy.children ?? []).map((k) => k.id)
    const targets = (copy.components[0]!.params.stages as Stage[])[0]!.steps.map((s) => s.target)
    expect(targets).toEqual(kids)
    expect(kids).not.toContain('left')
    expect((level.nodes[0]!.components[0]!.params.stages as Stage[])[0]!.steps.map((s) => s.target), 'the original is untouched').toEqual(['left', 'right'])
  })
})

describe('what the Inspector reads about a placement', () => {
  it('reports the sequence record a placement holds, and nothing when it holds none', () => {
    const { doc } = placedDoor()
    expect(doc.sequenceOverrideOf(0, 'seq')).toBeUndefined()
    doc.setSequenceStages(0, 'seq', [{ id: 's1', steps: [move('a', 4, 'left'), move('b', -1, 'right')] }, STAGES[1]!])
    expect(doc.sequenceOverrideOf(0, 'seq')).toEqual({ steps: { a: { to: vec3(4, 0, 0) } } })
  })

  /** Otherwise its ⋯ offered "Reset to defaults", which writes an override for every parameter. */
  it('calls a root’s components from the prefab inherited, and its own not', () => {
    const { doc } = placedDoor()
    const own = doc.addComponent(0, COLLIDER)!
    const kinds = Object.fromEntries(doc.components(0).map((c) => [c.id, c.inherited]))
    expect(kinds).toEqual({ rc: true, seq: true, [own]: false })
  })
})
