import type { Vec3 } from '@mp/core'

/**
 * What an editor action takes, declared once (ADR 0194): the JSON Schema an agent is shown as the tool's input,
 * and the check that input passes before the action runs. Input comes from a model, so it is checked like any
 * wire input — strictly: a field the action does not take is refused by name rather than ignored, so a typo
 * (`colour` for `color`) is said rather than silently doing nothing.
 */

export type JsonSchema = { readonly [key: string]: unknown }

/** Input that does not fit: what was expected, and where. */
export class InputError extends Error {}

export interface Schema<T> {
  readonly json: JsonSchema
  /** The value, checked; throws `InputError` naming `at`. */
  readonly parse: (value: unknown, at: string) => T
}

export type Infer<S> = S extends Schema<infer T> ? T : never

const fail = (at: string, what: string): never => {
  throw new InputError(`${at}: expected ${what}`)
}

const described = (json: JsonSchema, description: string | undefined): JsonSchema => (description === undefined ? json : { ...json, description })

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const str = (description?: string): Schema<string> => ({
  json: described({ type: 'string' }, description),
  parse: (v, at) => (typeof v === 'string' ? v : fail(at, 'a string')),
})

export const num = (description?: string): Schema<number> => ({
  json: described({ type: 'number' }, description),
  parse: (v, at) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(at, 'a finite number')),
})

export const bool = (description?: string): Schema<boolean> => ({
  json: described({ type: 'boolean' }, description),
  parse: (v, at) => (typeof v === 'boolean' ? v : fail(at, 'true or false')),
})

export const oneOf = <const T extends readonly string[]>(values: T, description?: string): Schema<T[number]> => ({
  json: described({ type: 'string', enum: [...values] }, description),
  parse: (v, at) => (typeof v === 'string' && values.includes(v) ? v : fail(at, `one of ${values.map((x) => `'${x}'`).join(', ')}`)),
})

export const vec3 = (description?: string): Schema<Vec3> => ({
  json: described({ type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'], additionalProperties: false }, description),
  parse: (v, at) => {
    if (!isPlain(v)) return fail(at, '{ x, y, z }')
    const extra = Object.keys(v).find((k) => k !== 'x' && k !== 'y' && k !== 'z')
    if (extra !== undefined) return fail(`${at}.${extra}`, 'nothing: a vector is x, y and z')
    return { x: num().parse(v.x, `${at}.x`), y: num().parse(v.y, `${at}.y`), z: num().parse(v.z, `${at}.z`) }
  },
})

export const list = <T>(item: Schema<T>, opts: { description?: string; min?: number; max?: number } = {}): Schema<T[]> => ({
  json: described({ type: 'array', items: item.json, ...(opts.min === undefined ? {} : { minItems: opts.min }), ...(opts.max === undefined ? {} : { maxItems: opts.max }) }, opts.description),
  parse: (v, at) => {
    if (!Array.isArray(v)) return fail(at, 'a list')
    if (opts.min !== undefined && v.length < opts.min) return fail(at, `at least ${opts.min} item${opts.min === 1 ? '' : 's'}`)
    if (opts.max !== undefined && v.length > opts.max) return fail(at, `at most ${opts.max} items`)
    return v.map((x, n) => item.parse(x, `${at}[${n}]`))
  },
})

export const nullable = <T>(s: Schema<T>): Schema<T | null> => ({
  json: { anyOf: [s.json, { type: 'null' }] },
  parse: (v, at) => (v === null ? null : s.parse(v, at)),
})

/** Any JSON value, checked by the action itself — a component field's, against its declaration. */
export const anyValue = (description: string): Schema<unknown> => ({
  json: { description },
  parse: (v, at) => (v === undefined ? fail(at, 'a value') : v),
})

/** An object with keys the caller chooses — a component's field values by name. */
export const record = <T>(value: Schema<T>, description: string): Schema<Record<string, T>> => ({
  json: { type: 'object', additionalProperties: value.json, description },
  parse: (v, at) => {
    if (!isPlain(v)) return fail(at, 'an object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value.parse(x, `${at}.${k}`)]))
  },
})

type Shape = Record<string, Schema<unknown>>
type Shaped<R extends Shape, O extends Shape> = { [K in keyof R]: Infer<R[K]> } & { [K in keyof O]?: Infer<O[K]> }

/** An object of named fields: `required` must be there, `optional` may be. Nothing else is taken. */
export const object = <R extends Shape, O extends Shape = Record<never, never>>(required: R, optional?: O, description?: string): Schema<Shaped<R, O>> => {
  const opt: Shape = optional ?? {}
  return {
    json: described(
      {
        type: 'object',
        properties: Object.fromEntries([...Object.entries(required), ...Object.entries(opt)].map(([k, s]) => [k, s.json])),
        required: Object.keys(required),
        additionalProperties: false,
      },
      description,
    ),
    parse: (v, at) => {
      if (!isPlain(v)) return fail(at, 'an object')
      // A field it does not take first: a misspelt one is the likelier mistake than a missing one.
      for (const k of Object.keys(v)) if (!(k in required) && !(k in opt)) return fail(`${at}.${k}`, `nothing: the fields are ${[...Object.keys(required), ...Object.keys(opt)].join(', ')}`)
      const out: Record<string, unknown> = {}
      for (const [k, s] of Object.entries(required)) {
        if (!(k in v)) return fail(`${at}.${k}`, 'a value: it is required')
        out[k] = s.parse(v[k], `${at}.${k}`)
      }
      for (const [k, s] of Object.entries(opt)) if (k in v && v[k] !== undefined) out[k] = s.parse(v[k], `${at}.${k}`)
      return out as Shaped<R, O>
    },
  }
}
