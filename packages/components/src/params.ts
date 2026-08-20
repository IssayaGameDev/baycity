import type { Vec3 } from '@mp/core'
import type { ColliderDesc, Keyframe } from '@mp/content'

/**
 * Declared component parameters — the single source the Inspector, the validator, the defaults and the
 * serializer all read (PLAN-component-system, stage C1).
 *
 * Declared rather than reflected off a TypeScript type, because TS types are erased at runtime: there is
 * nothing left at load time to tell an editor that `power` is a number between 1 and 60. Unity gets this
 * from C# reflection over serialized fields; without reflection the declaration has to be a value.
 */

/** Thrown when authored parameters do not match a component's declaration. */
export class ComponentError extends Error {}

/**
 * Show a parameter only while another parameter of the same component holds one of these values.
 *
 * Presentation, like `label` and `min` — but presentation the Inspector cannot infer: showing an editable
 * field that the component's own mode ignores is a worse lie than hiding it, and the value is kept either way,
 * so switching the mode back finds it where you left it.
 *
 * **Nothing built in uses this.** Its one user was the old combined `Visual`, whose `source` enum decided
 * whether its `model` mattered — and splitting that into `Mesh` and `Renderer` removed the mode rather than
 * hiding a field around it (ADR 0039). Kept because the mechanism is right for a component that genuinely has
 * a mode, and because deleting it would only mean writing it again.
 */
export interface ParamWhen {
  readonly param: string
  readonly is: readonly (string | number | boolean)[]
}

/** What every parameter declaration carries, whatever its kind. */
interface SpecBase {
  /** Inspector label. Falls back to the parameter's own name. */
  readonly label?: string
  /** Hide this parameter unless another one says otherwise. */
  readonly when?: ParamWhen
}

export interface NumberSpec extends SpecBase {
  readonly kind: 'number'
  readonly default: number
  /** Inspector bounds and step. **Hints, not constraints** — see `readParams`. */
  readonly min?: number
  readonly max?: number
  readonly step?: number
}
export interface BoolSpec extends SpecBase {
  readonly kind: 'bool'
  readonly default: boolean
}
export interface StringSpec extends SpecBase {
  readonly kind: 'string'
  readonly default: string
}
/**
 * An sRGB colour as `#rrggbb`.
 *
 * Its own kind rather than a `string`, for the same reason `asset` is: the Inspector can offer a picker, and
 * the validator can reject `"reddish"` at load instead of letting it reach a shader as black. Materials have
 * had a colour kind since ADR 0026, but that is the *shader* parameter system; this is the component one.
 */
export interface ColorSpec extends SpecBase {
  readonly kind: 'color'
  readonly default: string
}
export interface EnumSpec<O extends string = string> extends SpecBase {
  readonly kind: 'enum'
  readonly options: readonly O[]
  readonly default: O
}
export interface Vec3Spec extends SpecBase {
  readonly kind: 'vec3'
  readonly default: Vec3
}
/** An asset id, restricted to one kind so the Inspector can offer the right list. `''` means none. */
export interface AssetSpec extends SpecBase {
  readonly kind: 'asset'
  readonly of: 'material' | 'model'
  readonly default: string
}
/** A collision shape. Its own kind rather than a bag of numbers, so the Inspector can switch shape. */
export interface ColliderSpec extends SpecBase {
  readonly kind: 'collider'
  readonly default: ColliderDesc
}
/** A keyframe track, edited by the existing timeline (ADR 0029). Always defaults to empty. */
export interface KeysSpec extends SpecBase {
  readonly kind: 'keys'
}
/** A pointer to another node, by id. Always defaults to `null`. Resolution lands in stage C4. */
export interface NodeRefSpec extends SpecBase {
  readonly kind: 'nodeRef'
}

export type ParamSpec = NumberSpec | BoolSpec | StringSpec | ColorSpec | EnumSpec | Vec3Spec | AssetSpec | ColliderSpec | KeysSpec | NodeRefSpec

/**
 * Runtime value per spec kind. A lookup table keyed on `kind` rather than a chain of `S extends …`,
 * because several specs are structurally assignable to each other (`AssetSpec` satisfies `StringSpec`,
 * having only extra fields) and a conditional chain would resolve by declaration order instead of by kind.
 */
interface ValueByKind {
  number: number
  bool: boolean
  string: string
  color: string
  enum: string
  vec3: Vec3
  asset: string
  collider: ColliderDesc
  keys: readonly Keyframe[]
  nodeRef: string | null
}

/** `enum` keeps its literal union, so `self.params.loop` narrows to `'loop' | 'pingPong' | 'once'`. */
export type ValueOf<S extends ParamSpec> = S extends EnumSpec<infer O> ? O : ValueByKind[S['kind']]

export type ParamDecls = Record<string, ParamSpec>

/** The typed view of one component's authored parameters. */
export type Params<D extends ParamDecls> = { readonly [K in keyof D]: ValueOf<D[K]> }

/** Authored parameters as they sit in JSON, before they are checked against a declaration. */
export type RawParams = Record<string, unknown>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const isVec3 = (v: unknown): v is Vec3 => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.z)

/**
 * A collision shape, checked field by field.
 *
 * Nothing checked colliders before this: `validateLevel` walked pieces only as far as their behaviors and
 * triggers, so a box with a missing `halfExtents` reached Rapier as `undefined` and failed there, or
 * worse, silently. Colliders becoming a declared parameter is what closes that, for free.
 */
const checkCollider = (v: unknown, at: string): void => {
  if (!isObj(v)) throw new ComponentError(`${at}: expected a collider shape`)
  switch (v.kind) {
    case 'box':
      if (!isVec3(v.halfExtents)) throw new ComponentError(`${at}.halfExtents: expected a Vec3`)
      return
    case 'cylinder':
    case 'capsule':
      if (!isNum(v.halfHeight)) throw new ComponentError(`${at}.halfHeight: expected a number`)
      if (!isNum(v.radius)) throw new ComponentError(`${at}.radius: expected a number`)
      return
    case 'ball':
      if (!isNum(v.radius)) throw new ComponentError(`${at}.radius: expected a number`)
      return
    case 'convex':
      if (!Array.isArray(v.points) || v.points.length < 4) throw new ComponentError(`${at}.points: expected at least 4 points`)
      v.points.forEach((p: unknown, n: number) => {
        if (!isVec3(p)) throw new ComponentError(`${at}.points[${n}]: expected a Vec3`)
      })
      return
    default:
      throw new ComponentError(`${at}.kind: expected 'box' | 'cylinder' | 'capsule' | 'ball' | 'convex'`)
  }
}

const checkKeys = (v: unknown, at: string): void => {
  if (!Array.isArray(v)) throw new ComponentError(`${at}: expected an array of keyframes`)
  v.forEach((k: unknown, n: number) => {
    const kAt = `${at}[${n}]`
    if (!isObj(k) || !isNum(k.t)) throw new ComponentError(`${kAt}.t: expected a time in ms`)
    if (k.position !== undefined && !isVec3(k.position)) throw new ComponentError(`${kAt}.position: expected a Vec3`)
    if (k.rotation !== undefined && !isVec3(k.rotation)) throw new ComponentError(`${kAt}.rotation: expected a Vec3`)
  })
}

/** The value a spec falls back to. `keys` and `nodeRef` carry no `default` because theirs is forced. */
const defaultFor = (spec: ParamSpec): unknown => {
  if (spec.kind === 'keys') return []
  if (spec.kind === 'nodeRef') return null
  return spec.default
}

/** Every declared parameter at its default. What a freshly added component holds. */
export const defaultsOf = <D extends ParamDecls>(decls: D): Params<D> => {
  const out: RawParams = {}
  for (const [key, spec] of Object.entries(decls)) out[key] = defaultFor(spec)
  return out as Params<D>
}

const checkOne = (spec: ParamSpec, value: unknown, at: string): void => {
  switch (spec.kind) {
    case 'number':
      if (!isNum(value)) throw new ComponentError(`${at}: expected a number`)
      return
    case 'bool':
      if (typeof value !== 'boolean') throw new ComponentError(`${at}: expected true or false`)
      return
    case 'string':
    case 'asset':
      if (typeof value !== 'string') throw new ComponentError(`${at}: expected a string`)
      return
    case 'color':
      // Rejected at load rather than reaching a shader as black, which is the failure a plain string allows.
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
        throw new ComponentError(`${at}: expected an sRGB colour as #rrggbb`)
      return
    case 'enum':
      if (typeof value !== 'string' || !spec.options.includes(value))
        throw new ComponentError(`${at}: expected one of ${spec.options.map((o) => `'${o}'`).join(' | ')}`)
      return
    case 'vec3':
      if (!isVec3(value)) throw new ComponentError(`${at}: expected a Vec3`)
      return
    case 'collider':
      checkCollider(value, at)
      return
    case 'keys':
      checkKeys(value, at)
      return
    case 'nodeRef':
      if (value !== null && typeof value !== 'string') throw new ComponentError(`${at}: expected a node id or null`)
      return
  }
}

/**
 * Authored parameters, checked against a declaration and completed with defaults.
 *
 * **An absent key takes its default** rather than failing, so adding a parameter to a component does not
 * invalidate every level that already uses it.
 *
 * **An unknown key is ignored and dropped.** The alternative — erroring — turns every parameter rename
 * into a content migration, and Unity drops unknown serialized fields for the same reason. The cost is
 * that a rename loses the old values silently, so rename by migrating, not by editing the declaration.
 *
 * **`min`/`max` are not enforced.** They drive the Inspector's slider; a value outside them is honest
 * data (a script or a hand edit meant it) and rejecting it at load would make the bounds a schema change.
 * Non-finite numbers are rejected, because `NaN` reaches the character as a position and disappears it.
 */
/**
 * Which parameters to show, given the values a component currently holds. Declaration order.
 *
 * A hidden parameter is still *stored* and still validated — this says nothing about the data, only about what
 * is worth putting in front of somebody. A `when` naming a parameter that does not exist shows the field,
 * which is the safe direction: a typo in a declaration should not make a control vanish silently.
 */
export const visibleParams = <D extends ParamDecls>(decls: D, values: RawParams): string[] =>
  Object.entries(decls)
    .filter(([, spec]) => {
      const when = spec.when
      if (when === undefined) return true
      if (!(when.param in decls)) return true
      const held = values[when.param] ?? defaultFor(decls[when.param]!)
      return when.is.includes(held as string | number | boolean)
    })
    .map(([key]) => key)

export const readParams = <D extends ParamDecls>(decls: D, raw: RawParams | undefined, at: string): Params<D> => {
  const out: RawParams = {}
  for (const [key, spec] of Object.entries(decls)) {
    const value = raw?.[key]
    if (value === undefined) {
      out[key] = defaultFor(spec)
      continue
    }
    checkOne(spec, value, `${at}.${key}`)
    out[key] = value
  }
  return out as Params<D>
}
