import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * What each person may spend on the assistant in a day, and what they have (ADR 0192). Counted in dollars from the
 * usage every answer reports, by the prices of the model that gave it (`models.ts`); kept in the state directory, so
 * a restart does not hand anyone a fresh day. The day is UTC's.
 *
 * The limits are the admin page's (ADR 0200): one for everyone — $1 until it is set, Kodjo's call — and a person's
 * own over it; and a person's day can be started again there.
 */

/** USD per million tokens. */
export interface Prices {
  readonly input: number
  readonly output: number
  readonly cacheWrite: number
  readonly cacheRead: number
}

export interface Usage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
}

export const costOf = (u: Usage, prices: Prices): number =>
  (u.input_tokens * prices.input + u.output_tokens * prices.output + (u.cache_creation_input_tokens ?? 0) * prices.cacheWrite + (u.cache_read_input_tokens ?? 0) * prices.cacheRead) /
  1_000_000

/** Dollars a day: one figure for everyone, and some people's own (ADR 0200). */
export interface Limits {
  /** Everyone's, unless they have their own. */
  readonly everyone: () => number
  /** This person's own, or `undefined` for everyone's. */
  readonly own: (email: string) => number | undefined
  /** What this person may spend a day: their own, else everyone's. */
  readonly of: (email: string) => number
  /** Set everyone's, and people's own — `null` takes a person's own away. */
  readonly set: (change: { readonly everyone?: number; readonly people?: Readonly<Record<string, number | null>> }) => void
}

/** A figure a limit may be: dollars, none below nothing. */
export const isLimit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

export const createLimits = (opts: { readonly file: string | null; readonly everyone: number }): Limits => {
  let everyone = opts.everyone
  const people: Record<string, number> = {}
  if (opts.file !== null && existsSync(opts.file)) {
    try {
      const saved = JSON.parse(readFileSync(opts.file, 'utf8')) as { everyone?: unknown; people?: unknown }
      if (isLimit(saved.everyone)) everyone = saved.everyone
      if (typeof saved.people === 'object' && saved.people !== null) for (const [k, v] of Object.entries(saved.people)) if (isLimit(v)) people[k.toLowerCase()] = v
    } catch {
      // A torn file is the default limits, not a dead assistant.
    }
  }
  const own = (email: string): number | undefined => people[email.toLowerCase()]
  return {
    everyone: () => everyone,
    own,
    of: (email) => own(email) ?? everyone,
    set: (change) => {
      if (change.everyone !== undefined) everyone = change.everyone
      for (const [k, v] of Object.entries(change.people ?? {})) {
        if (v === null) delete people[k.toLowerCase()]
        else people[k.toLowerCase()] = v
      }
      if (opts.file !== null) writeFileSync(opts.file, JSON.stringify({ everyone, people }))
    },
  }
}

export interface Budget {
  /** Dollars this person may spend a day. */
  limitOf: (email: string) => number
  /** Dollars this person has spent today. */
  spent: (email: string) => number
  /** Count `usd` against this person's day. */
  add: (email: string, usd: number) => void
  /** Today's spending, by email: everyone who has spent anything. */
  today: () => Readonly<Record<string, number>>
  /** This person's day starts again, nothing spent (ADR 0200). */
  reset: (email: string) => void
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export const createBudget = (opts: { readonly file: string | null; readonly limitOf: (email: string) => number; readonly now?: () => number }): Budget => {
  const now = opts.now ?? (() => Date.now())
  let day = dayOf(now())
  let spent: Record<string, number> = {}
  if (opts.file !== null && existsSync(opts.file)) {
    try {
      const saved = JSON.parse(readFileSync(opts.file, 'utf8')) as { day?: unknown; spent?: unknown }
      if (saved.day === day && typeof saved.spent === 'object' && saved.spent !== null) {
        for (const [k, v] of Object.entries(saved.spent)) if (typeof v === 'number') spent[k] = v
      }
    } catch {
      // A torn file is a fresh day, not a dead assistant.
    }
  }
  const roll = (): void => {
    const today = dayOf(now())
    if (today === day) return
    day = today
    spent = {}
  }
  const save = (): void => {
    if (opts.file !== null) writeFileSync(opts.file, JSON.stringify({ day, spent }))
  }
  return {
    limitOf: opts.limitOf,
    spent: (email) => {
      roll()
      return spent[email.toLowerCase()] ?? 0
    },
    add: (email, usd) => {
      roll()
      const key = email.toLowerCase()
      spent[key] = (spent[key] ?? 0) + Math.max(0, usd)
      save()
    },
    today: () => {
      roll()
      return { ...spent }
    },
    reset: (email) => {
      roll()
      delete spent[email.toLowerCase()]
      save()
    },
  }
}
