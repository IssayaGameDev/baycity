import type { PersistenceAdapter } from '@mp/game-client'

import { BASE_PER_STEP } from './progression'

/**
 * What this game keeps for a player across visits: Experience (ADR 0071), Wins (ADR 0073), what a step pays
 * (ADR 0082), the checkpoints reached (ADR 0211) and how many times they have reborn (ADR 0221). A game's stats live in the game, and they are saved **only
 * through a `PersistenceAdapter`** (Kodjo's rule): this browser's storage now, platform accounts later, and the game
 * reads and writes this one shape either way.
 */
export interface KeyboardSave {
  experience: number
  wins: number
  perStep: number
  /** By level name, the keys of the checkpoints reached there (`CheckpointStop.key`). */
  reached: Readonly<Record<string, readonly string[]>>
  /** Rebirths taken, a whole number (ADR 0221). */
  rebirths: number
}

/** The keys these values were always saved under, so a save from before the adapter loads as it was. */
const KEYS = { experience: 'keyboard.experience', wins: 'keyboard.wins', perStep: 'keyboard.perStep', reached: 'keyboard.reached', rebirths: 'keyboard.rebirths' } as const

/** A stored number, or `fallback` when it is missing, unreadable, or below `min`. */
const readNumber = (key: string, fallback: number, min: number): number => {
  try {
    const raw = localStorage.getItem(key)
    const n = raw === null ? fallback : Number.parseFloat(raw)
    return Number.isFinite(n) && n >= min ? n : fallback
  } catch {
    return fallback
  }
}

/** The reached checkpoints, keeping only levels whose value is a list of strings; none for anything unreadable. */
const readReached = (): Record<string, readonly string[]> => {
  try {
    const raw = localStorage.getItem(KEYS.reached)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, readonly string[]> = {}
    for (const [level, keys] of Object.entries(parsed)) {
      if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) out[level] = keys
    }
    return out
  } catch {
    return {}
  }
}

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A session that cannot save still plays.
  }
}

/** This browser's `localStorage`, under the game's own keys. Best-effort: a value that cannot be read is its default. */
export const localKeyboardSave = (): PersistenceAdapter<KeyboardSave> => ({
  load: () => ({
    experience: readNumber(KEYS.experience, 0, 0),
    wins: readNumber(KEYS.wins, 0, 0),
    perStep: readNumber(KEYS.perStep, BASE_PER_STEP, 1),
    reached: readReached(),
    rebirths: Math.floor(readNumber(KEYS.rebirths, 0, 0)),
  }),
  save: (s) => {
    write(KEYS.experience, String(Math.floor(s.experience)))
    write(KEYS.wins, String(Math.floor(s.wins)))
    write(KEYS.perStep, String(s.perStep))
    write(KEYS.reached, JSON.stringify(s.reached))
    write(KEYS.rebirths, String(Math.floor(s.rebirths)))
  },
})

/** `reached` with `key` added for `level` — the same object when it is already there. */
export const withReached = (reached: KeyboardSave['reached'], level: string, key: string): KeyboardSave['reached'] => {
  const have = reached[level] ?? []
  return have.includes(key) ? reached : { ...reached, [level]: [...have, key] }
}
