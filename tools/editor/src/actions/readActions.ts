import type { ParamSpec } from '@mp/components'
import { ASSET_KINDS } from '@mp/content'

import type { Doc } from '../editorDoc'
import { ActionError, defineAction, type ActionCtx } from './actions'
import { list, object, oneOf, str } from './schema'

/**
 * The actions that look (ADR 0194): what is open, the scene, an object, the components and assets there are — what
 * a person reads off the Hierarchy, the Inspector and the Project window. They change nothing. Ids here are the ids
 * every other action takes.
 */

const id = (what: string) => str(`${what}: an object id, like n:1a2b3c4d`)

/** Most objects a scene read lists before it says to narrow it with `under`. */
const MAX_ROWS = 400
/** Most assets a list hands back. */
const MAX_ASSETS = 300

const r2 = (n: number): number => Math.round(n * 100) / 100
const DEG = 180 / Math.PI

/** A parameter's declaration, for a reader: its kind, and what it takes. */
const describe = (spec: ParamSpec): Record<string, unknown> => {
  const base = { kind: spec.kind, ...(spec.label === undefined ? {} : { label: spec.label }) }
  switch (spec.kind) {
    case 'number':
      return { ...base, default: spec.default, ...(spec.min === undefined ? {} : { min: spec.min }), ...(spec.max === undefined ? {} : { max: spec.max }) }
    case 'enum':
      return { ...base, options: spec.options, default: spec.default }
    case 'asset':
      return { ...base, of: spec.of, ...(spec.dataType === undefined ? {} : { dataType: spec.dataType }), default: spec.default }
    case 'componentRef':
      return { ...base, of: spec.of, takes: '{ object, component } or null' }
    case 'nodeRef':
      return { ...base, takes: 'an object id or null' }
    case 'list':
      return { ...base, item: Object.fromEntries(Object.entries(spec.item).map(([k, s]) => [k, describe(s)])) }
    case 'stages':
      return { ...base, note: 'a sequence’s steps: edited in the Inspector, not by actions yet' }
    case 'color':
      return { ...base, default: spec.default, ...(spec.optional === true ? { optional: 'an empty string is automatic' } : {}) }
    default:
      return { ...base, default: spec.default }
  }
}

/** Who else has this object selected, when someone does: an agent stays off it. */
const heldNote = (ctx: ActionCtx, doc: Doc, i: number): { heldBy?: string } => {
  const ref = doc.refAt(i)
  const holder = ref === null ? null : ctx.host.heldBy([ref])
  return holder === null ? {} : { heldBy: holder.name }
}

const getEditor = defineAction({
  name: 'get_editor',
  summary: 'What is open in this editor tab: the game, the level, a prefab open on top of it, and what is selected.',
  effect: 'read',
  input: object({}),
  run: (ctx) => {
    const where = ctx.host.where()
    const doc = ctx.host.doc()
    return { ...where, selected: doc === null ? [] : ctx.host.selection().map(ctx.idAt) }
  },
})

const getScene = defineAction({
  name: 'get_scene',
  summary: 'The objects of the open level or prefab, in Hierarchy order: id, name, parent, components, and who else has it selected.',
  effect: 'read',
  input: object({}, { under: id('only this object and what is under it') }),
  run: (ctx, input) => {
    const doc = ctx.doc()
    return doc.reading(() => {
      const top = input.under === undefined ? null : ctx.at(input.under)
      const rows: Record<string, unknown>[] = []
      let truncated = false
      for (let i = top ?? 0; i < doc.count(); i++) {
        if (top !== null && i > top && doc.depthOf(i) <= doc.depthOf(top)) break
        if (rows.length === MAX_ROWS) {
          truncated = true
          break
        }
        const parent = doc.parentOf(i)
        const prefab = doc.refOf(i)
        rows.push({
          id: ctx.idAt(i),
          name: doc.label(i),
          parent: parent === null ? null : ctx.idAt(parent),
          ...(doc.kindOf(i) === 'inherited' ? { inherited: true } : {}),
          ...(prefab === null ? {} : { prefab: ctx.host.assetEntry(prefab)?.name ?? prefab }),
          ...(doc.nodeEnabled(i) ? {} : { enabled: false }),
          components: doc.components(i).map((c) => c.type),
          ...heldNote(ctx, doc, i),
        })
      }
      return { objects: rows, ...(truncated ? { truncated: `more than ${MAX_ROWS}: read part of it with 'under'` } : {}) }
    })
  },
})

/** A field's value as a reader takes it: a reference as the object id the other actions take. */
const shownValue = (ctx: ActionCtx, doc: Doc, i: number, spec: ParamSpec | undefined, value: unknown): unknown => {
  if (spec?.kind === 'nodeRef' && typeof value === 'string') {
    const j = doc.refTarget(i, value)
    return j === null ? { missing: value } : ctx.idAt(j)
  }
  if (spec?.kind === 'componentRef' && typeof value === 'object' && value !== null) {
    const r = value as { node?: unknown; component?: unknown }
    const j = typeof r.node === 'string' ? doc.refTarget(i, r.node) : null
    return j === null ? { missing: value } : { object: ctx.idAt(j), component: r.component }
  }
  return value
}

const getObject = defineAction({
  name: 'get_object',
  summary: 'One object as the Inspector shows it: its transform (rotation in degrees), and each component’s id, type and every field’s value.',
  effect: 'read',
  input: object({ id: id('the object') }),
  run: (ctx, input) => {
    const doc = ctx.doc()
    return doc.reading(() => {
      const i = ctx.at(input.id)
      const t = doc.transformOf(i)
      const rot = t.rotation
      const parent = doc.parentOf(i)
      const prefab = doc.refOf(i)
      const children: string[] = []
      for (let j = i + 1; j < doc.count() && doc.depthOf(j) > doc.depthOf(i); j++) if (doc.parentOf(j) === i) children.push(ctx.idAt(j))
      return {
        id: input.id,
        name: doc.label(i),
        parent: parent === null ? null : ctx.idAt(parent),
        children,
        ...(doc.kindOf(i) === 'inherited' ? { inherited: 'a piece of a prefab placement: an edit is an override on this placement' } : {}),
        ...(prefab === null ? {} : { prefab: { asset: prefab, name: ctx.host.assetEntry(prefab)?.name ?? null } }),
        enabled: doc.nodeEnabled(i),
        transform: {
          position: t.position,
          rotation: rot === undefined ? { x: 0, y: 0, z: 0 } : { x: r2(rot.x * DEG), y: r2(rot.y * DEG), z: r2(rot.z * DEG) },
          scale: t.scale ?? { x: 1, y: 1, z: 1 },
        },
        components: doc.components(i).map((c) => {
          const def = doc.registry.get(c.type)
          const values = def === undefined ? c.params : { ...doc.registry.defaults(c.type), ...c.params }
          return {
            componentId: c.id,
            type: c.type,
            enabled: c.enabled,
            ...(c.inherited ? { inherited: true } : {}),
            ...(c.overridden.length > 0 ? { overridden: c.overridden } : {}),
            fields: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, shownValue(ctx, doc, i, def?.params[k], v)])),
          }
        }),
        ...heldNote(ctx, doc, i),
      }
    })
  },
})

const listComponentTypes = defineAction({
  name: 'list_component_types',
  summary: 'The component types this game has, each with its fields: their kind, default, range or options.',
  effect: 'read',
  input: object({}),
  run: (ctx) =>
    ctx
      .doc()
      .registry.all()
      .map((def) => ({
        type: def.type,
        ...(def.label === undefined ? {} : { label: def.label }),
        fields: Object.fromEntries(Object.entries(def.params).map(([k, s]) => [k, describe(s)])),
      })),
})

const listAssets = defineAction({
  name: 'list_assets',
  summary: 'Assets the open level or prefab may use — prefabs, models, materials, textures, data assets… — by id, name and path.',
  effect: 'read',
  input: object({}, { kind: oneOf(ASSET_KINDS, 'only this kind'), search: str('only names or paths containing this') }),
  run: (ctx, input) => {
    const q = input.search?.toLowerCase()
    const found = ctx.host.usableAssets(input.kind).filter((a) => q === undefined || a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q))
    return {
      assets: found.slice(0, MAX_ASSETS).map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: a.path })),
      ...(found.length > MAX_ASSETS ? { truncated: `${found.length} in all: narrow it with kind or search` } : {}),
    }
  },
})

const getAsset = defineAction({
  name: 'get_asset',
  summary: 'One asset: a material’s shader, values and parameters; a data asset’s type, fields and their declarations.',
  effect: 'read',
  input: object({ asset: str('the asset id') }),
  run: (ctx, input) => {
    const entry = ctx.host.assetEntry(input.asset)
    if (entry === undefined) throw new ActionError(`no asset ${input.asset}`)
    const base = { id: entry.id, name: entry.name, kind: entry.kind, path: entry.path }
    const material = entry.kind === 'material' ? ctx.host.materialOf(entry.id) : undefined
    if (material !== undefined) {
      return {
        ...base,
        shader: material.shader,
        values: Object.fromEntries(Object.entries(material.params).map(([k, v]) => [k, v.value])),
        parameters: ctx.host.shaderParams(material.shader) ?? null,
      }
    }
    const data = entry.kind === 'data' ? ctx.host.dataOf(entry.id) : undefined
    if (data !== undefined) {
      const type = ctx.host.dataTypeOf(entry.id)
      return { ...base, type: data.type, fields: data.fields, declared: type === undefined ? null : Object.fromEntries(Object.entries(type.fields).map(([k, s]) => [k, describe(s)])) }
    }
    return base
  },
})

const getProblems = defineAction({
  name: 'get_problems',
  summary: 'The latest warnings and errors this editor tab has shown, oldest first.',
  effect: 'read',
  input: object({}),
  run: (ctx) => ({ problems: ctx.host.problems() }),
})

const screenshotView = defineAction({
  name: 'screenshot_view',
  summary: 'A small picture of the viewport as this tab shows it — the camera where the person has it — to check what an edit looks like.',
  effect: 'read',
  input: object({}),
  run: (ctx) => {
    const shot = ctx.host.screenshot()
    if (shot === null) throw new ActionError('nothing to picture: Play is running, or the viewport has no size')
    return { image: { mediaType: shot.mediaType, data: shot.data }, width: shot.width, height: shot.height }
  },
})

const ids = list(id('an object'), { max: 100, description: 'object ids' })

const selectObjects = defineAction({
  name: 'select_objects',
  summary: 'Select objects in this tab, as clicking them does — the person sees it. An empty list selects nothing.',
  effect: 'view',
  input: object({ ids }),
  run: (ctx, input) => void ctx.host.select(input.ids.map(ctx.at)),
})

const focusObjects = defineAction({
  name: 'focus_objects',
  summary: 'Move this tab’s camera to frame objects, as Focus does.',
  effect: 'view',
  input: object({ ids: list(id('an object'), { min: 1, max: 100 }) }),
  run: (ctx, input) => void ctx.host.frame(input.ids.map(ctx.at)),
})

export const READ_ACTIONS = [getEditor, getScene, getObject, listComponentTypes, listAssets, getAsset, getProblems, screenshotView]
export const VIEW_ACTIONS = [selectObjects, focusObjects]
