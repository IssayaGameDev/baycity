import { readParams, type ParamSpec } from '@mp/components'
import { isBuiltinModel, PRIMITIVE_LABELS, PRIMITIVE_ORDER, type MaterialAsset, type MaterialValue, type Transform } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

import type { Doc } from '../editorDoc'
import { rootsOf } from '../selection'
import { roundAngle } from '../snap'
import { ActionError, defineAction, type ActionCtx } from './actions'
import { closest, componentTypeHint, didYouMean } from './hints'
import { anyValue, bool, list, nullable, num, object, oneOf, record, str, vec3 as vec3In } from './schema'
import { assetIdHint, assetView, viewOf } from './views'

/**
 * The actions that change things (ADR 0194): the core of what a person does to a level or a prefab, and to a
 * material or a data asset. Each one is what the editor's own controls do, through the same document calls.
 *
 * Left out on purpose, until each can be undone as one: anything that writes a file (create, rename, move or delete
 * an asset, a folder or a level, an upload), Apply to prefab and Save as prefab, and adding a shared component to the
 * game's list (Kodjo's call). An action asked for one says so rather than half-doing it.
 *
 * Each answers with what it changed as a read shows it — the object, its components and their ids; the asset — so the
 * next call needs no read first. A refusal names what would have worked.
 */

/** Most copies a duplicate answers with whole; past that, their ids. */
const MAX_VIEWS = 5

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
const DEG = Math.PI / 180

/** One object id, as the reads hand them out. */
const id = (what: string) => str(`${what}: an object id from get_scene, like n:1a2b3c4d`)
const ids = list(id('an object'), { min: 1, max: 100, description: 'object ids' })

/** The roots of these objects, deepest index first: deleting or duplicating a parent takes its children along. */
const rootsDeepestFirst = (doc: Doc, indices: readonly number[]): number[] => rootsOf([...new Set(indices)], (i) => doc.depthOf(i)).sort((a, b) => b - a)

const KINDS = ['empty', ...PRIMITIVE_ORDER] as const

const createObject = defineAction({
  name: 'create_object',
  summary: 'Create an empty object or a built-in shape (box, platform, sphere…) at a local position, optionally under a parent and named.',
  effect: 'edit',
  input: object({ kind: oneOf(KINDS, 'empty, or a built-in shape at its preset size') }, { parent: id('the object to put it under; the top level when absent'), position: vec3In('local position in metres; the origin when absent'), name: str('its name') }),
  run: (ctx, input) => ({
    object: viewOf(
      ctx,
      ctx.edit(`create ${input.kind === 'empty' ? 'empty' : PRIMITIVE_LABELS[input.kind].toLowerCase()}`, (doc) => {
      const parent = input.parent === undefined ? null : ctx.at(input.parent)
      const where = input.position ?? vec3(0, 0, 0)
      const i = input.kind === 'empty' ? doc.placeEmpty(where, parent) : doc.placePrimitive(input.kind, where, parent)
      if (i < 0) throw new ActionError('nowhere to put that here')
      if (input.name !== undefined) doc.setName(i, input.name)
      return ctx.idAt(i)
      }),
    ),
  }),
})

const placeAsset = defineAction({
  name: 'place_asset',
  summary: 'Place a prefab (as a reference to it) or a model at a world position, as dragging it from the Project window does.',
  effect: 'edit',
  input: object({ asset: str('the asset id of a prefab or a model, from list_assets'), position: vec3In('where, in metres') }, { name: str('its name') }),
  run: async (ctx, input) => {
    if (isBuiltinModel(input.asset)) throw new ActionError(`${input.asset} is a built-in shape: make one with create_object, kind ${input.asset.slice('builtin:'.length)}`)
    if (ctx.host.assetEntry(input.asset) === undefined) throw new ActionError(`no asset '${input.asset}'${assetIdHint(ctx, undefined, input.asset)}`)
    const ready = await ctx.host.toPlace(input.asset)
    if ('refused' in ready) throw new ActionError(ready.refused)
    const id = ctx.edit('place', (doc) => {
      const i = ready.kind === 'model' ? doc.placeModel(input.asset, input.position) : doc.placePrefab(input.asset, ready.root, input.position)
      if (i < 0) throw new ActionError('that did not place: its prefab may use a component this game does not have')
      if (input.name !== undefined) doc.setName(i, input.name)
      return ctx.idAt(i)
    })
    return { object: viewOf(ctx, id) }
  },
})

const deleteObjects = defineAction({
  name: 'delete_objects',
  summary: 'Delete objects, and everything under them.',
  effect: 'edit',
  input: object({ ids }),
  run: (ctx, input) => {
    const doc = ctx.doc()
    const roots = rootsDeepestFirst(doc, input.ids.map(ctx.at))
    return ctx.edit(roots.length > 1 ? `delete ${roots.length}` : 'delete', (d) => {
      for (const i of roots) d.remove(i)
      return { deleted: roots.length }
    })
  },
})

const duplicateObjects = defineAction({
  name: 'duplicate_objects',
  summary: 'Duplicate objects with everything under them, each copy beside its original. Returns the copies’ ids.',
  effect: 'edit',
  input: object({ ids }),
  run: (ctx, input) => {
    const roots = rootsDeepestFirst(ctx.doc(), input.ids.map(ctx.at))
    const copies = ctx.edit(roots.length > 1 ? `duplicate ${roots.length}` : 'duplicate', (doc) => {
      const made: number[] = []
      for (const i of roots) {
        const before = doc.count()
        const at = doc.duplicate(i)
        // Working downward, each copy shifts the ones already made by however many nodes it inserted.
        const inserted = doc.count() - before
        for (let n = 0; n < made.length; n++) made[n]! += inserted
        made.push(at)
      }
      return made.reverse().map(ctx.idAt)
    })
    return copies.length <= MAX_VIEWS ? { objects: copies.map((c) => viewOf(ctx, c)) } : { ids: copies }
  },
})

const renameObject = defineAction({
  name: 'rename_object',
  summary: 'Rename an object. An empty name goes back to the one made from what it is.',
  effect: 'edit',
  input: object({ id: id('the object'), name: str('the new name') }),
  run: (ctx, input) => {
    ctx.edit('rename', (doc) => void doc.setName(ctx.at(input.id), input.name))
    return { object: viewOf(ctx, input.id) }
  },
})

const reparentObject = defineAction({
  name: 'reparent_object',
  summary: 'Move an object under another (or to the top level), keeping where it is in the world, as dragging it in the Hierarchy does.',
  effect: 'edit',
  input: object({ id: id('the object to move'), parent: nullable(id('its new parent')) }, { index: num('its place among the new parent’s children, from 0; last when absent') }),
  run: (ctx, input) => {
    const doc = ctx.doc()
    const i = ctx.at(input.id)
    const parent = input.parent === null ? null : ctx.at(input.parent)
    if (!doc.canReparent(i, parent)) throw new ActionError('it cannot go there: not inside itself, and not into a prefab’s piece')
    const reframed = ctx.host.reframe(i, parent)
    const last = parent === null ? Array.from({ length: doc.count() }, (_, n) => n).filter((n) => doc.depthOf(n) === 0).length : doc.childCount(parent)
    const moved = ctx.edit('reparent', (d) => ctx.idAt(d.reparent(i, parent, Math.max(0, Math.round(input.index ?? last)), reframed)))
    return { object: viewOf(ctx, moved) }
  },
})

const setTransform = defineAction({
  name: 'set_transform',
  summary: 'Set an object’s local position (metres), rotation (degrees, XYZ) and scale. What is left out stays as it is.',
  effect: 'edit',
  input: object({ id: id('the object') }, { position: vec3In('local position, metres'), rotation: vec3In('local rotation, degrees'), scale: vec3In('local scale; 1 is its own size') }),
  run: (ctx, input) => {
    ctx.edit('transform', (doc) => {
      const i = ctx.at(input.id)
      const now = doc.transformOf(i)
      const p = input.position ?? now.position
      const r = input.rotation === undefined ? (now.rotation ?? vec3(0, 0, 0)) : vec3(input.rotation.x * DEG, input.rotation.y * DEG, input.rotation.z * DEG)
      const s = input.scale ?? now.scale ?? vec3(1, 1, 1)
      // Stored as the gizmo stores it: rounded, a zero rotation and a unit scale left out.
      const zero = Math.abs(r.x) < 1e-5 && Math.abs(r.y) < 1e-5 && Math.abs(r.z) < 1e-5
      const one = Math.abs(s.x - 1) < 1e-4 && Math.abs(s.y - 1) < 1e-4 && Math.abs(s.z - 1) < 1e-4
      const next: Transform = {
        position: vec3(r4(p.x), r4(p.y), r4(p.z)),
        ...(zero ? {} : { rotation: vec3(roundAngle(r.x), roundAngle(r.y), roundAngle(r.z)) }),
        ...(one ? {} : { scale: vec3(r4(s.x), r4(s.y), r4(s.z)) }),
      }
      doc.setTransform(i, next)
    })
    return { object: viewOf(ctx, input.id) }
  },
})

const addComponent = defineAction({
  name: 'add_component',
  summary: 'Add a component of this game to an object, at its defaults. Returns its componentId.',
  effect: 'edit',
  input: object({ id: id('the object'), type: str('the component type, from list_component_types') }),
  run: (ctx, input) => {
    const doc = ctx.doc()
    const i = ctx.at(input.id)
    if (!doc.registry.has(input.type)) {
      if (ctx.host.adoptable().includes(input.type)) throw new ActionError(`${input.type} is a shared component this game has not added: adding one to a game is not done by an action, so a person adds it`)
      throw new ActionError(`no component type '${input.type}' in this game${componentTypeHint(doc.registry, input.type)}`)
    }
    if (!doc.canAdd(i, input.type)) throw new ActionError(`${input.type} cannot go on this object: it has one already, or it is not one to add by hand`)
    const componentId = ctx.edit('add component', (d) => {
      const added = d.addComponent(i, input.type)
      if (added === null) throw new ActionError(`${input.type} was refused here`)
      return added
    })
    return { componentId, object: viewOf(ctx, input.id) }
  },
})

/** A component on an object, or a refusal naming the ones it has. */
const componentOn = (doc: Doc, i: number, componentId: string) => {
  const all = doc.components(i)
  const c = all.find((x) => x.id === componentId)
  if (c === undefined) throw new ActionError(`no component ${componentId} on this object: it has ${all.map((x) => `${x.type} (${x.id})`).join(', ') || 'none'}`)
  return c
}

const removeComponent = defineAction({
  name: 'remove_component',
  summary: 'Remove a component from an object.',
  effect: 'edit',
  input: object({ id: id('the object'), componentId: str('the component’s id, from get_object') }),
  run: (ctx, input) => {
    const i = ctx.at(input.id)
    componentOn(ctx.doc(), i, input.componentId)
    ctx.edit('remove component', (doc) => void doc.removeComponent(i, input.componentId))
    return { object: viewOf(ctx, input.id) }
  },
})

/**
 * A field's value as the document stores it, from what an agent gave: a reference named by object id becomes the
 * id the field stores, an asset is refused the way the Inspector refuses it. The rest is checked whole afterwards,
 * against the component's declaration.
 */
const storedValue = (ctx: ActionCtx, doc: Doc | null, i: number | null, key: string, spec: ParamSpec, raw: unknown): unknown => {
  const where = doc === null || i === null ? 'a data asset' : 'this object'
  switch (spec.kind) {
    case 'stages':
      throw new ActionError(`${key} is a sequence’s steps, which an action does not set yet`)
    case 'collider':
      if (doc === null || i === null) throw new ActionError(`${key} means nothing in ${where}`)
      if (doc.builtinOf(i) !== null) throw new ActionError(`${key} is locked to the built-in shape: its size is the object’s scale`)
      return raw
    case 'asset': {
      if (raw === '' || typeof raw !== 'string') return raw
      // The built-in shapes a model field offers beside the uploaded ones (ADR 0090): no file holds them.
      if (spec.of === 'model' && isBuiltinModel(raw)) return raw
      if (ctx.host.assetEntry(raw) === undefined) throw new ActionError(`${key}: no asset '${raw}'${assetIdHint(ctx, spec.of, raw)}`)
      const why = ctx.host.assetRefusal(spec.of, raw, spec.dataType)
      if (why !== null) throw new ActionError(`${key}: ${why}`)
      return raw
    }
    case 'nodeRef': {
      if (doc === null || i === null) throw new ActionError(`${key} means nothing in ${where}`)
      if (raw === null) return null
      if (typeof raw !== 'string') throw new ActionError(`${key}: expected an object id or null`)
      const stored = doc.refTo(i, ctx.at(raw))
      if (stored === null) throw new ActionError(`${key}: that object is out of this field’s reach`)
      return stored
    }
    case 'componentRef': {
      if (doc === null || i === null) throw new ActionError(`${key} means nothing in ${where}`)
      if (raw === null) return null
      const r = raw as { object?: unknown; component?: unknown }
      if (typeof raw !== 'object' || typeof r.object !== 'string' || typeof r.component !== 'string') throw new ActionError(`${key}: expected { object, component } or null`)
      const j = ctx.at(r.object)
      const target = componentOn(doc, j, r.component)
      if (target.type !== spec.of) throw new ActionError(`${key} takes a ${spec.of}, not a ${target.type}`)
      const stored = doc.refTo(i, j)
      if (stored === null) throw new ActionError(`${key}: that object is out of this field’s reach`)
      return { node: stored, component: r.component }
    }
    default:
      return raw
  }
}

const setComponentFields = defineAction({
  name: 'set_component_fields',
  summary:
    'Set some of a component’s fields, by name. Values as get_object shows them; a reference to an object is its id, to a component { object, component }, an asset its id.',
  effect: 'edit',
  input: object({ id: id('the object'), componentId: str('the component’s id'), values: record(anyValue('the field’s new value'), 'field name → value') }),
  run: (ctx, input) => {
    const doc = ctx.doc()
    const i = ctx.at(input.id)
    const c = componentOn(doc, i, input.componentId)
    const def = doc.registry.get(c.type)
    if (def === undefined) throw new ActionError(`${c.type} is not a component this game has`)
    const keys = Object.keys(input.values)
    if (keys.length === 0) throw new ActionError('no fields given')
    const patch: Record<string, unknown> = {}
    for (const key of keys) {
      const spec = def.params[key]
      if (spec === undefined) {
        const near = closest(key, Object.keys(def.params))
        throw new ActionError(`${c.type} has no field '${key}'${near.length > 0 ? didYouMean(near).replace('?', ';') : ':'} its fields are ${Object.keys(def.params).join(', ')}`)
      }
      patch[key] = storedValue(ctx, doc, i, key, spec, input.values[key])
    }
    // The whole component checked as it would be after, the way a level is when it loads.
    doc.registry.checkParams(c.type, { ...doc.registry.defaults(c.type), ...c.params, ...patch }, c.type)
    ctx.edit(`${def.label ?? c.type} ${keys.join(', ')}`, (d) => void d.setParams(i, input.componentId, patch))
    return { object: viewOf(ctx, input.id) }
  },
})

const setComponentEnabled = defineAction({
  name: 'set_component_enabled',
  summary: 'Switch a component on or off.',
  effect: 'edit',
  input: object({ id: id('the object'), componentId: str('the component’s id'), enabled: bool() }),
  run: (ctx, input) => {
    const i = ctx.at(input.id)
    componentOn(ctx.doc(), i, input.componentId)
    ctx.edit(input.enabled ? 'component on' : 'component off', (doc) => void doc.setComponentEnabled(i, input.componentId, input.enabled))
    return { object: viewOf(ctx, input.id) }
  },
})

const setObjectEnabled = defineAction({
  name: 'set_object_enabled',
  summary: 'Switch an object, and everything under it, on or off: off, it is not in the level at all.',
  effect: 'edit',
  input: object({ id: id('the object'), enabled: bool() }),
  run: (ctx, input) => {
    ctx.edit(input.enabled ? 'enabled' : 'disabled', (doc) => void doc.setNodeEnabled(ctx.at(input.id), input.enabled))
    return { object: viewOf(ctx, input.id) }
  },
})

const moveComponent = defineAction({
  name: 'move_component',
  summary: 'Move a component one place up or down its object’s list. The order is the order they run in.',
  effect: 'edit',
  input: object({ id: id('the object'), componentId: str('the component’s id'), direction: oneOf(['up', 'down'] as const) }),
  run: (ctx, input) => {
    const i = ctx.at(input.id)
    if (componentOn(ctx.doc(), i, input.componentId).inherited) throw new ActionError('this component is the prefab’s: its order is the prefab’s to change')
    ctx.edit('move component', (doc) => void doc.moveComponent(i, input.componentId, input.direction === 'up' ? -1 : 1))
    return { object: viewOf(ctx, input.id) }
  },
})

/** Refused while someone else has the asset open in their Inspector: an agent stays off what someone has selected. */
const notOpenByOthers = (ctx: ActionCtx, assetId: string): void => {
  if (ctx.turn === null) return
  const who = ctx.host.assetOpenBy(assetId)
  if (who !== null) throw new ActionError(`${who} has this asset open, so it was left alone`)
}

const isVec2 = (v: unknown): v is { x: number; y: number } => typeof v === 'object' && v !== null && Number.isFinite((v as { x?: unknown }).x) && Number.isFinite((v as { y?: unknown }).y)
const isVec3 = (v: unknown): v is Vec3 => isVec2(v) && Number.isFinite((v as { z?: unknown }).z)

/** A material parameter's value, tagged with its kind as the file keeps it, or why not. */
const materialValue = (ctx: ActionCtx, key: string, kind: MaterialValue['kind'], raw: unknown): MaterialValue => {
  switch (kind) {
    case 'color':
      if (typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw)) return { kind, value: raw }
      break
    case 'number':
      if (typeof raw === 'number' && Number.isFinite(raw)) return { kind, value: raw }
      break
    case 'boolean':
      if (typeof raw === 'boolean') return { kind, value: raw }
      break
    case 'vec2':
      if (isVec2(raw)) return { kind, value: { x: raw.x, y: raw.y } }
      break
    case 'vec3':
      if (isVec3(raw)) return { kind, value: vec3(raw.x, raw.y, raw.z) }
      break
    case 'texture': {
      if (raw === null || raw === '') return { kind, value: null }
      if (typeof raw !== 'string') break
      const entry = ctx.host.assetEntry(raw)
      if (entry === undefined) throw new ActionError(`${key}: no asset '${raw}'${assetIdHint(ctx, 'texture', raw)}`)
      if (entry.kind !== 'texture') throw new ActionError(`${key}: ${entry.name} is a ${entry.kind}, not a texture`)
      const why = ctx.host.assetRefusal('texture', raw, undefined)
      if (why !== null) throw new ActionError(`${key}: ${why}`)
      return { kind, value: raw }
    }
  }
  const expected = { color: 'a colour as #rrggbb', number: 'a number', boolean: 'true or false', vec2: '{ x, y }', vec3: '{ x, y, z }', texture: 'a texture id or null' }[kind]
  throw new ActionError(`${key}: expected ${expected}`)
}

const setMaterialValues = defineAction({
  name: 'set_material_values',
  summary: 'Set some of a material’s values by parameter name (its shader’s: colour, roughness…). Every object using the material changes.',
  effect: 'edit',
  input: object({ asset: str('the material’s asset id'), values: record(anyValue('the parameter’s new value'), 'parameter key → value') }),
  run: (ctx, input) => {
    const material = ctx.host.materialOf(input.asset)
    const entry = ctx.host.assetEntry(input.asset)
    if (material === undefined || entry === undefined) throw new ActionError(`no material '${input.asset}'${assetIdHint(ctx, 'material', input.asset)}`)
    notOpenByOthers(ctx, input.asset)
    const params = ctx.host.shaderParams(material.shader)
    if (params === undefined) throw new ActionError(`its shader '${material.shader}' is not one this editor has`)
    const next: MaterialAsset = { ...material, params: { ...material.params } }
    for (const [key, raw] of Object.entries(input.values)) {
      const param = params.find((p) => p.key === key)
      if (param === undefined) {
        const near = closest(key, params.map((p) => p.key))
        throw new ActionError(`${material.shader} has no parameter '${key}'${near.length > 0 ? didYouMean(near).replace('?', ';') : ':'} its parameters are ${params.map((p) => p.key).join(', ')}`)
      }
      next.params[key] = materialValue(ctx, key, param.kind, raw)
    }
    ctx.host.editMaterial(input.asset, next, `${entry.name} ${Object.keys(input.values).join(', ')}`, ctx.turn)
    return { asset: assetView(ctx, input.asset) }
  },
})

const setDataFields = defineAction({
  name: 'set_data_fields',
  summary: 'Set some of a data asset’s fields by name (a Keyboard Style’s keys…). Everything using the asset changes.',
  effect: 'edit',
  input: object({ asset: str('the data asset’s id'), values: record(anyValue('the field’s new value'), 'field name → value') }),
  run: (ctx, input) => {
    const data = ctx.host.dataOf(input.asset)
    const entry = ctx.host.assetEntry(input.asset)
    if (data === undefined || entry === undefined) throw new ActionError(`no data asset '${input.asset}'${assetIdHint(ctx, 'data', input.asset)}`)
    notOpenByOthers(ctx, input.asset)
    const type = ctx.host.dataTypeOf(input.asset)
    if (type === undefined) throw new ActionError(`its type '${data.type}' is not one this game declares`)
    const fields: Record<string, unknown> = { ...data.fields }
    for (const [key, raw] of Object.entries(input.values)) {
      const spec = type.fields[key]
      if (spec === undefined) {
        const near = closest(key, Object.keys(type.fields))
        throw new ActionError(`${type.label ?? type.type} has no field '${key}'${near.length > 0 ? didYouMean(near).replace('?', ';') : ':'} its fields are ${Object.keys(type.fields).join(', ')}`)
      }
      fields[key] = storedValue(ctx, null, null, key, spec, raw)
    }
    // The whole asset checked as it would be after, the way the game reads it.
    readParams(type.fields, fields, type.type)
    ctx.host.editData(input.asset, { ...data, fields }, `${entry.name} ${Object.keys(input.values).join(', ')}`, ctx.turn)
    return { asset: assetView(ctx, input.asset) }
  },
})

export const EDIT_ACTIONS = [
  createObject,
  placeAsset,
  deleteObjects,
  duplicateObjects,
  renameObject,
  reparentObject,
  setTransform,
  addComponent,
  removeComponent,
  setComponentFields,
  setComponentEnabled,
  setObjectEnabled,
  moveComponent,
  setMaterialValues,
  setDataFields,
]
