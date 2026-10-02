import type { ParamSpec } from '@mp/components'
import { BUILTIN_LABELS, BUILTIN_MODELS, isBuiltinModel, type AssetEntry } from '@mp/content'

import type { Doc } from '../editorDoc'
import { ActionError, type ActionCtx } from './actions'
import { closest } from './hints'

/**
 * How the actions show what they read and what they changed (ADR 0194): an object as the Inspector shows it, an asset
 * as the asset Inspector does. One shape for a read and for an edit's answer, so a model that has made a change has
 * what it changed in front of it, ids and all, without reading it again.
 */

const r2 = (n: number): number => Math.round(n * 100) / 100
const DEG = 180 / Math.PI

/** A parameter's declaration, for a reader: its kind, and what it takes. */
export const describeSpec = (spec: ParamSpec): Record<string, unknown> => {
  const base = { kind: spec.kind, ...(spec.label === undefined ? {} : { label: spec.label }) }
  switch (spec.kind) {
    case 'number':
      return { ...base, default: spec.default, ...(spec.min === undefined ? {} : { min: spec.min }), ...(spec.max === undefined ? {} : { max: spec.max }) }
    case 'enum':
      return { ...base, options: spec.options, default: spec.default }
    case 'asset':
      return { ...base, of: spec.of, ...(spec.dataType === undefined ? {} : { dataType: spec.dataType }), default: spec.default, ...(spec.of === 'model' ? { builtIn: [...BUILTIN_MODELS] } : {}) }
    case 'componentRef':
      return { ...base, of: spec.of, takes: '{ object, component } or null' }
    case 'nodeRef':
      return { ...base, takes: 'an object id or null' }
    case 'list':
      return { ...base, item: Object.fromEntries(Object.entries(spec.item).map(([k, s]) => [k, describeSpec(s)])) }
    case 'stages':
      return { ...base, note: 'stages of steps — move, turn, scale, fade, collider, enabled, wait — set with set_sequence_stages; stages play one after another, the steps in a stage together' }
    case 'color':
      return { ...base, default: spec.default, ...(spec.optional === true ? { optional: 'an empty string is automatic' } : {}) }
    default:
      return { ...base, default: spec.default }
  }
}

/** Who else has this object selected, when someone does: an agent stays off it. */
export const heldNote = (ctx: ActionCtx, doc: Doc, i: number): { heldBy?: string } => {
  const ref = doc.refAt(i)
  const holder = ref === null ? null : ctx.host.heldBy([ref])
  return holder === null ? {} : { heldBy: holder.name }
}

/** A field's value as a reader takes it: a reference as the object id the other actions take. */
const shownValue = (ctx: ActionCtx, doc: Doc, i: number, spec: ParamSpec | undefined, value: unknown): unknown => {
  if (spec?.kind === 'nodeRef' && typeof value === 'string') {
    const j = doc.refTarget(i, value)
    return j === null ? { missing: value } : ctx.idAt(j)
  }
  if (spec?.kind === 'stages' && Array.isArray(value)) {
    // A step's target as the child's object id, as set_sequence_stages takes it.
    return value.map((s: { steps?: unknown }) =>
      typeof s === 'object' && s !== null && Array.isArray(s.steps)
        ? {
            ...s,
            steps: s.steps.map((step: { target?: unknown }) => {
              if (typeof step !== 'object' || step === null || typeof step.target !== 'string' || step.target === '') return step
              const j = doc.stepTargetOf(i, step.target)
              return j === null ? { ...step, target: { missing: step.target } } : { ...step, target: ctx.idAt(j) }
            }),
          }
        : s,
    )
  }
  if (spec?.kind === 'componentRef' && typeof value === 'object' && value !== null) {
    const r = value as { node?: unknown; component?: unknown }
    const j = typeof r.node === 'string' ? doc.refTarget(i, r.node) : null
    return j === null ? { missing: value } : { object: ctx.idAt(j), component: r.component }
  }
  return value
}

/** Object `i` as the Inspector shows it: transform (rotation in degrees), each component's id, type and every field. */
export const objectView = (ctx: ActionCtx, doc: Doc, i: number): Record<string, unknown> =>
  doc.reading(() => {
    const t = doc.transformOf(i)
    const rot = t.rotation
    const parent = doc.parentOf(i)
    const prefab = doc.refOf(i)
    const children: string[] = []
    for (let j = i + 1; j < doc.count() && doc.depthOf(j) > doc.depthOf(i); j++) if (doc.parentOf(j) === i) children.push(ctx.idAt(j))
    return {
      id: ctx.idAt(i),
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

/** The object with this id as it is now: what an edit answers with. */
export const viewOf = (ctx: ActionCtx, id: string): Record<string, unknown> => objectView(ctx, ctx.doc(), ctx.at(id))

/** The built-in shapes, as the model picker lists them beside the uploaded models (ADR 0090). */
export const builtInModels = (): AssetEntry[] => BUILTIN_MODELS.map((id) => ({ id, name: `${BUILTIN_LABELS[id]} (built-in)`, kind: 'model', path: 'built-in' }))

/** One asset as the asset Inspector shows it; a built-in shape too. */
export const assetView = (ctx: ActionCtx, assetId: string): Record<string, unknown> => {
  if (isBuiltinModel(assetId)) return { id: assetId, name: BUILTIN_LABELS[assetId], kind: 'model', builtIn: true }
  const entry = ctx.host.assetEntry(assetId)
  if (entry === undefined) throw new ActionError(`no asset '${assetId}'${assetIdHint(ctx, undefined, assetId)}`)
  const base = { id: entry.id, name: entry.name, kind: entry.kind, path: entry.path }
  const material = entry.kind === 'material' ? ctx.host.materialOf(entry.id) : undefined
  if (material !== undefined) {
    return { ...base, shader: material.shader, values: Object.fromEntries(Object.entries(material.params).map(([k, v]) => [k, v.value])), parameters: ctx.host.shaderParams(material.shader) ?? null }
  }
  const data = entry.kind === 'data' ? ctx.host.dataOf(entry.id) : undefined
  if (data !== undefined) {
    const type = ctx.host.dataTypeOf(entry.id)
    return { ...base, type: data.type, fields: data.fields, declared: type === undefined ? null : Object.fromEntries(Object.entries(type.fields).map(([k, s]) => [k, describeSpec(s)])) }
  }
  return base
}

/**
 * What an asset id that is not one should have been: the id of an asset by that name, one the id starts, or the
 * nearest names — of that kind when it is known. Asset ids are 16 hex digits; a guessed one is the usual mistake.
 */
export const assetIdHint = (ctx: ActionCtx, kind: string | undefined, raw: string): string => {
  const pool = [...(kind === undefined || kind === 'model' ? builtInModels() : []), ...ctx.host.usableAssets()].filter((a) => kind === undefined || a.kind === kind)
  const named = pool.find((a) => a.name.toLowerCase() === raw.toLowerCase())
  if (named !== undefined) return `: that is a name; its id is '${named.id}'`
  const started = pool.find((a) => raw.length >= 4 && a.id.startsWith(raw))
  if (started !== undefined) return `: did you mean '${started.id}' (${started.name})? Copy ids whole, from list_assets`
  const near = closest(raw, pool.map((a) => a.name))
  if (near.length > 0) return `: did you mean ${near.map((n) => `'${pool.find((a) => a.name === n)!.id}' (${n})`).join(' or ')}? Asset ids come from list_assets`
  return ': asset ids come from list_assets'
}
