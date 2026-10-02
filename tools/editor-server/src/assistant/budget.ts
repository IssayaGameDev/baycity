import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * What each person may spend on the assistant in a day (ADR 0192, Kodjo's call: $1), and what they have. Counted in
 * dollars from the usage every answer reports, by the prices of the model that gave it (`models.ts`); kept in the
 * state directory, so a restart does not hand anyone a fresh day. The day is UTC's.
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

export interface Budget {
  readonly limit: number
  /** Dollars this person has spent today. */
  spent: (email: string) => number
  /** Count `usd` against this person's day. */
  add: (email: string, usd: number) => void
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export const createBudget = (opts: { readonly file: string | null; readonly limit: number; readonly now?: () => number }): Budget => {
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
    limit: opts.limit,
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
  }
}
