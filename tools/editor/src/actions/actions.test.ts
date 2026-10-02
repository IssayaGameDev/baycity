// @vitest-environment happy-dom
import { createRegistry, defineComponent, ENGINE_COMPONENTS } from '@mp/components'
import { applyBatch, COLLIDER, refKey, type Level, type Op } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc, type Doc } from '../editorDoc'
import { createHistoryStore, type HistoryHost } from '../historyStore'
import { ActionError, createEditorActions, defineAction, EDITOR_ACTIONS, type Action, type ActionHost, type Screenshot } from './index'
import { object } from './schema'

/**
 * The editor's actions (ADR 0194) against a real document and history: input checked strictly, one batch an action,
 * one undo a turn — leaving what someone changed since — an agent kept off what someone else has selected, and a
 * failed action taken back whole.
 */

const Spinner = defineComponent({
  type: 'Spinner',
  params: { speed: { kind: 'number', default: 1 }, axis: { kind: 'enum', options: ['x', 'y', 'z'], default: 'y' }, target: { kind: 'nodeRef' } },
})
const REG = createRegistry([...ENGINE_COMPONENTS, Spinner])

const level = (): Level => ({
  id: 'lv',
  config: {},
  nodes: [
    {
      id: 'a',
      name: 'Box',
      transform: { position: vec3(0, 0, 0) },
      components: [{ id: 'k', type: 'Spinner', params: { speed: 1 } }],
      children: [{ id: 'c', name: 'Child', transform: { position: vec3(0, 1, 0) }, components: [] }],
    },
    { id: 'b', name: 'Other', transform: { position: vec3(5, 0, 0) }, components: [] },
  ],
})

const rig = (extra: readonly Action[] = []) => {
  const lv = level()
  const submits: { ops: Op[] }[] = []
  const repaints: (readonly Op[])[] = []
  /** Who else holds what, by `refKey`: the room's holds, as another connection's. */
  const held = new Map<string, string>()
  /** The viewport's picture, as the shell would take it; `null` while Play runs. */
  let shot: Screenshot | null = { mediaType: 'image/jpeg', data: 'AAAA', width: 512, height: 288 }
  let doc: Doc = levelDoc(lv, REG)
  const historyHost: HistoryHost = {
    doc: () => doc,
    rootDoc: () => doc,
    rootLevel: () => lv,
    selection: () => [],
    selected: () => null,
    selectionRefs: () => [],
    selectionRoots: () => [],
    applySelection: () => {},
    deleteSelected: () => {},
    live: () => true,
    submit: (batch) => void submits.push(batch),
    rebuildViewport: () => {},
    repaint: () => {},
    loadNewReferencesThen: () => {},
    applyAsset: () => true,
    assetNow: () => undefined,
    notify: { ok: () => {}, warn: () => {}, error: () => {} },
    renderStatus: () => {},
    refreshUi: () => {},
  }
  const history = createHistoryStore(historyHost)
  doc = history.withOps(doc)
  const host: ActionHost = {
    doc: () => doc,
    rootLevel: () => lv,
    history,
    repaint: (ops) => void repaints.push(ops),
    heldBy: (refs) => {
      for (const ref of refs) {
        const name = held.get(refKey(ref))
        if (name !== undefined) return { name, ref }
      }
      return null
    },
    assetOpenBy: () => null,
    toPlace: async () => ({ refused: 'nothing to place in this test' }),
    reframe: () => undefined,
    assetEntry: () => undefined,
    usableAssets: () => [],
    assetRefusal: () => null,
    materialOf: () => undefined,
    shaderParams: () => undefined,
    dataOf: () => undefined,
    dataTypeOf: () => undefined,
    editMaterial: () => {},
    editData: () => {},
    adoptable: () => ['Bumper'],
    select: () => {},
    frame: () => {},
    selection: () => [],
    where: () => ({ game: null, level: 'lv', prefab: null }),
    problems: () => [],
    screenshot: () => shot,
  }
  const actions = createEditorActions(host, [...EDITOR_ACTIONS, ...extra])
  const speed = (): unknown => lv.nodes[0]!.components[0]!.params.speed
  return { lv, doc: () => doc, history, actions, submits, repaints, held, speed, noPicture: () => void (shot = null) }
}

describe('what an action takes', () => {
  it('refuses a field it does not take by name, and a missing one, before anything happens', async () => {
    const { actions, submits } = rig()
    expect(await actions.run('rename_object', { id: 'n:a', nmae: 'x' })).toEqual({ ok: false, error: 'input.nmae: expected nothing: the fields are id, name' })
    expect(await actions.run('rename_object', { id: 'n:a' })).toEqual({ ok: false, error: 'input.name: expected a value: it is required' })
    expect(await actions.run('rename_objekt', {})).toEqual({ ok: false, error: "no action 'rename_objekt'" })
    expect(submits).toEqual([])
  })

  it('says when an object is gone, so the caller reads the scene again', async () => {
    const { actions } = rig()
    const r = await actions.run('rename_object', { id: 'n:zzz', name: 'x' })
    expect(r).toEqual({ ok: false, error: 'no object n:zzz here: it may have been deleted — read the scene again' })
  })
})

describe('a person’s action', () => {
  it('is one entry of its own and one message to the room, undone like a click', async () => {
    const { lv, actions, history, submits } = rig()
    expect(await actions.run('rename_object', { id: 'n:a', name: 'Crate' })).toEqual({ ok: true, result: null })
    expect(lv.nodes[0]!.name).toBe('Crate')
    expect(submits).toHaveLength(1)
    expect(history.labels().undo).toBe('rename')
    history.undo()
    expect(lv.nodes[0]!.name).toBe('Box')
  })
})

describe('a turn: one prompt to an agent', () => {
  it('is one undo for every action it ran, each sent as it ran', async () => {
    const { lv, actions, history, submits } = rig()
    const before = structuredClone(lv)
    const turn = history.startTurn('assistant: tidy up')
    const made = await actions.run('create_object', { kind: 'box', position: { x: 2, y: 0, z: 0 }, name: 'Crate' }, turn)
    expect(made.ok).toBe(true)
    await actions.run('set_component_fields', { id: 'n:a', componentId: 'k', values: { speed: 3, axis: 'x' } }, turn)
    await actions.run('rename_object', { id: 'n:b', name: 'Renamed' }, turn)
    history.endTurn(turn)
    expect(submits).toHaveLength(3)
    expect(history.depth().undo).toBe(1)
    expect(history.labels().undo).toBe('assistant: tidy up')
    history.undo()
    expect(lv).toEqual(before)
  })

  it('leaves what someone changed since when undone', async () => {
    const { lv, actions, history, speed } = rig()
    const turn = history.startTurn('assistant: faster')
    await actions.run('set_component_fields', { id: 'n:a', componentId: 'k', values: { speed: 3, axis: 'x' } }, turn)
    history.endTurn(turn)
    applyBatch(lv, [{ kind: 'setParams', id: 'a', componentId: 'k', patch: { speed: 9 } }]) // Bob, from another tab
    history.undo()
    expect(speed()).toBe(9)
    expect(lv.nodes[0]!.components[0]!.params.axis).toBeUndefined()
  })

  it('stays off an object someone else has selected, sending nothing, and says who', async () => {
    const { lv, actions, history, submits, held } = rig()
    held.set('n:a', 'Bob')
    const turn = history.startTurn('assistant: rename')
    expect(await actions.run('rename_object', { id: 'n:a', name: 'Mine' }, turn)).toEqual({ ok: false, error: 'Bob has “Box” selected, so it was left alone' })
    history.endTurn(turn)
    expect(lv.nodes[0]!.name).toBe('Box')
    expect(submits).toEqual([])
    expect(history.depth().undo).toBe(0)
  })

  it('stays off a parent whose child someone has selected: deleting it would take theirs', async () => {
    const { lv, actions, history, held } = rig()
    held.set('n:c', 'Bob')
    const turn = history.startTurn('assistant: clear')
    const r = await actions.run('delete_objects', { ids: ['n:a'] }, turn)
    expect(r.ok).toBe(false)
    expect(lv.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('does not hold a person back: holds are shown to people, never in their way (ADR 0158)', async () => {
    const { lv, actions, held } = rig()
    held.set('n:a', 'Bob')
    expect((await actions.run('rename_object', { id: 'n:a', name: 'Mine' })).ok).toBe(true)
    expect(lv.nodes[0]!.name).toBe('Mine')
  })
})

describe('an action that fails half-way', () => {
  it('is taken back whole and nothing of it is sent', async () => {
    const halfway = defineAction({
      name: 'halfway',
      summary: 'renames, then fails',
      effect: 'edit',
      input: object({}),
      run: (ctx) =>
        ctx.edit('halfway', (d) => {
          d.setName(0, 'Half')
          throw new ActionError('stopped')
        }),
    })
    const { lv, actions, submits, repaints, history } = rig([halfway])
    expect(await actions.run('halfway', {})).toEqual({ ok: false, error: 'stopped' })
    expect(lv.nodes[0]!.name).toBe('Box')
    expect(submits).toEqual([])
    expect(repaints).toHaveLength(1)
    expect(history.depth().undo).toBe(0)
  })

  it('cannot edit from an action declared as a read', async () => {
    const sneaky = defineAction({ name: 'sneaky', summary: 'reads, then edits', effect: 'read', input: object({}), run: (ctx) => ctx.edit('x', (d) => d.setName(0, 'x')) })
    const { lv, actions } = rig([sneaky])
    expect(await actions.run('sneaky', {})).toEqual({ ok: false, error: 'sneaky failed: sneaky is declared read and cannot edit' })
    expect(lv.nodes[0]!.name).toBe('Box')
  })
})

describe('setting a component’s fields', () => {
  it('names the fields there are when given one that is not', async () => {
    const { actions } = rig()
    const r = await actions.run('set_component_fields', { id: 'n:a', componentId: 'k', values: { sped: 2 } })
    expect(r).toEqual({ ok: false, error: "Spinner has no field 'sped': its fields are speed, axis, target" })
  })

  it('refuses a value its declaration does not take, changing nothing', async () => {
    const { actions, speed, submits } = rig()
    const r = await actions.run('set_component_fields', { id: 'n:a', componentId: 'k', values: { axis: 'w' } })
    expect(r).toEqual({ ok: false, error: "Spinner.axis: expected one of 'x' | 'y' | 'z'" })
    expect(speed()).toBe(1)
    expect(submits).toEqual([])
  })

  it('takes a reference as an object id, stores the node’s id, and reads it back as the object id', async () => {
    const { lv, actions } = rig()
    expect((await actions.run('set_component_fields', { id: 'n:a', componentId: 'k', values: { target: 'n:b' } })).ok).toBe(true)
    expect(lv.nodes[0]!.components[0]!.params.target).toBe('b')
    const read = await actions.run('get_object', { id: 'n:a' })
    const fields = (read as { result: { components: { fields: Record<string, unknown> }[] } }).result.components[0]!.fields
    expect(fields).toEqual({ speed: 1, axis: 'y', target: 'n:b' })
  })

  it('leaves a built-in shape’s collider locked, as the Inspector does', async () => {
    const { actions, doc } = rig()
    const made = await actions.run('create_object', { kind: 'box' })
    const id = (made as { result: { id: string } }).result.id
    const i = doc().indexOfRef({ id: id.slice(2) })!
    const collider = doc().components(i).find((c) => c.type === COLLIDER)!
    const r = await actions.run('set_component_fields', { id, componentId: collider.id, values: { shape: { kind: 'ball', radius: 1 } } })
    expect(r).toEqual({ ok: false, error: 'shape is locked to the built-in shape: its size is the object’s scale' })
  })
})

describe('adding a component', () => {
  it('refuses a type the game does not have, and says a shared one is for a person to add', async () => {
    const { actions } = rig()
    expect(await actions.run('add_component', { id: 'n:b', type: 'Nope' })).toEqual({ ok: false, error: "no component type 'Nope' in this game" })
    const shared = await actions.run('add_component', { id: 'n:b', type: 'Bumper' })
    expect(shared.ok).toBe(false)
    expect((shared as { error: string }).error).toContain('a person adds it')
  })

  it('adds one at its defaults and hands back its id', async () => {
    const { lv, actions } = rig()
    const r = await actions.run('add_component', { id: 'n:b', type: 'Spinner' })
    const componentId = (r as { result: { componentId: string } }).result.componentId
    expect(lv.nodes[1]!.components.find((c) => c.id === componentId)?.type).toBe('Spinner')
  })
})

describe('reading the scene', () => {
  it('lists every object in Hierarchy order with the ids the other actions take', async () => {
    const { actions, held } = rig()
    held.set('n:b', 'Bob')
    const r = await actions.run('get_scene', {})
    expect((r as { result: unknown }).result).toEqual({
      objects: [
        { id: 'n:a', name: 'Box', parent: null, components: ['Spinner'] },
        { id: 'n:c', name: 'Child', parent: 'n:a', components: [] },
        { id: 'n:b', name: 'Other', parent: null, components: [], heldBy: 'Bob' },
      ],
    })
  })

  it('reads part of it under one object', async () => {
    const { actions } = rig()
    const r = await actions.run('get_scene', { under: 'n:a' })
    expect((r as { result: { objects: { id: string }[] } }).result.objects.map((o) => o.id)).toEqual(['n:a', 'n:c'])
  })
})

describe('a picture of the viewport', () => {
  it('hands back the small JPEG the shell takes, and says why when there is none', async () => {
    const { actions, noPicture } = rig()
    expect(await actions.run('screenshot_view', {})).toEqual({ ok: true, result: { image: { mediaType: 'image/jpeg', data: 'AAAA' }, width: 512, height: 288 } })
    noPicture()
    expect(await actions.run('screenshot_view', {})).toEqual({ ok: false, error: 'nothing to picture: Play is running, or the viewport has no size' })
  })
})
