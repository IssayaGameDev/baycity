/**
 * Per-player progress + a pluggable persistence adapter.
 *
 * The state is minimal — the last checkpoint reached, which is what `ModeSession` already deals in
 * (ADR 0052). The adapter interface is the point: `localProgress` (per-browser) now; an account-backed
 * adapter (a future grind mode's XP/level, cross-device) implements the same shape. Nothing above this
 * touches storage directly.
 */
export interface PersistenceAdapter<T> {
  load: () => T
  save: (state: T) => void
}

/** Per-player state. `checkpoint` is the last checkpoint index reached (-1 = none). */
export interface PlayerProgress {
  checkpoint: number
}

const DEFAULT: PlayerProgress = { checkpoint: -1 }

/**
 * Local, per-browser persistence via `localStorage`, keyed by the game's own name so two games on the
 * platform never share a save. Best-effort: any read/parse/write failure falls back to defaults rather than
 * throwing.
 */
export const localProgress = (mode: string): PersistenceAdapter<PlayerProgress> => ({
  load: () => {
    try {
      const raw = localStorage.getItem(`${mode}.state`)
      if (raw === null) return { ...DEFAULT }
      const parsed = JSON.parse(raw) as { checkpoint?: unknown }
      const cp = typeof parsed.checkpoint === 'number' && Number.isInteger(parsed.checkpoint) ? parsed.checkpoint : -1
      return { checkpoint: cp }
    } catch {
      return { ...DEFAULT }
    }
  },
  save: (state) => {
    try {
      localStorage.setItem(`${mode}.state`, JSON.stringify(state))
    } catch {
      // ignore — local persistence is best-effort
    }
  },
})
