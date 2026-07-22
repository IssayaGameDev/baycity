/**
 * Per-player mode state + a pluggable persistence adapter (mode-readiness seam, ADR
 * pending). Parkour's state is minimal — the last checkpoint reached. The adapter interface
 * is the point: `local` (per-browser) now; an account-backed adapter (a future grind mode's
 * XP/level, cross-device) implements the same shape. The mode never touches storage directly.
 */
export interface PersistenceAdapter<T> {
  load: () => T
  save: (state: T) => void
}

/** Parkour per-player state. `checkpoint` is the last checkpoint index reached (-1 = none). */
export interface ParkourPlayerState {
  checkpoint: number
}

const DEFAULT: ParkourPlayerState = { checkpoint: -1 }

/** Local, per-browser persistence via `localStorage`. Best-effort: any read/parse/write
 * failure falls back to defaults rather than throwing. */
export const localParkourPersistence = (key = 'parkour.state'): PersistenceAdapter<ParkourPlayerState> => ({
  load: () => {
    try {
      const raw = localStorage.getItem(key)
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
      localStorage.setItem(key, JSON.stringify(state))
    } catch {
      // ignore — local persistence is best-effort
    }
  },
})
