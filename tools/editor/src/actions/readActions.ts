import { ASSET_KINDS } from '@mp/content'

import { ActionError, defineAction } from './actions'
import { componentTypeHint } from './hints'
import { list, object, oneOf, str } from './schema'
import { assetView, builtInModels, describeSpec, heldNote, objectView } from './views'

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

const getObject = defineAction({
  name: 'get_object',
  summary: 'One object as the Inspector shows it: its transform (rotation in degrees), and each component’s id, type and every field’s value.',
  effect: 'read',
  input: object({ id: id('the object') }),
  run: (ctx, input) => objectView(ctx, ctx.doc(), ctx.at(input.id)),
})

const listComponentTypes = defineAction({
  name: 'list_component_types',
  summary: 'The component types this game has, by type (what add_component takes) and label. Name one type for its fields: their kind, default, range or options.',
  effect: 'read',
  input: object({}, { type: str('one type, for its fields') }),
  run: (ctx, input) => {
    const registry = ctx.doc().registry
    if (input.type === undefined) return { types: registry.all().map((d) => ({ type: d.type, ...(d.label === undefined ? {} : { label: d.label }) })) }
    const def = registry.get(input.type)
    if (def === undefined) throw new ActionError(`no component type '${input.type}' in this game${componentTypeHint(registry, input.type)}`)
    return { type: def.type, ...(def.label === undefined ? {} : { label: def.label }), fields: Object.fromEntries(Object.entries(def.params).map(([k, spec]) => [k, describeSpec(spec)])) }
  },
})

const listAssets = defineAction({
  name: 'list_assets',
  summary: 'Assets the open level or prefab may use — prefabs, models (the built-in shapes among them), materials, textures, data assets… — by id, name and path.',
  effect: 'read',
  input: object({}, { kind: oneOf(ASSET_KINDS, 'only this kind'), search: str('only names or paths containing this') }),
  run: (ctx, input) => {
    const q = input.search?.toLowerCase()
    // The built-in shapes are models no file holds: the model picker lists them first, and so does this.
    const all = [...(input.kind === undefined || input.kind === 'model' ? builtInModels() : []), ...ctx.host.usableAssets(input.kind)]
    const found = all.filter((a) => q === undefined || a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q))
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
  run: (ctx, input) => assetView(ctx, input.asset),
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
