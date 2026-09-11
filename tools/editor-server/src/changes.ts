/**
 * The change feed: every write's paths, numbered, for the live mirror on Kodjo's PC (ADR 0084).
 *
 * A bounded log plus long-poll waiters. `since(seq)` answers at once when there is news; `wait` parks the
 * request until there is, or the timeout passes. Bounded because a mirror that fell behind further than the
 * log reaches simply does a full sync — cheaper than remembering everything forever.
 */
export interface ChangeBatch {
  /** The feed's position after these paths. */
  seq: number
  paths: string[]
}

export interface ChangeFeed {
  /** Current position. */
  seq: () => number
  record: (paths: readonly string[]) => void
  /**
   * Everything after `since`, folded into one batch. `null` when the caller is older than the log remembers, or
   * **ahead of it** — the server restarted and its numbering began again — and a full sync is the answer.
   * Empty `paths` with the current `seq` when nothing happened.
   */
  since: (since: number) => ChangeBatch | null
  /** `since`, but waits up to `timeoutMs` for news when there is none yet. */
  wait: (since: number, timeoutMs: number) => Promise<ChangeBatch | null>
}

export const createChangeFeed = (keep = 2000): ChangeFeed => {
  let seq = 0
  /** `entries[i]` happened at seq `first + i`. */
  const entries: string[][] = []
  let first = 1
  let waiters: (() => void)[] = []

  const since = (from: number): ChangeBatch | null => {
    if (from > seq || from < first - 1) return null
    if (from === seq) return { seq, paths: [] }
    const paths = new Set<string>()
    for (let s = Math.max(from + 1, first); s <= seq; s++) for (const p of entries[s - first]!) paths.add(p)
    return { seq, paths: [...paths] }
  }

  return {
    seq: () => seq,
    record: (paths) => {
      if (paths.length === 0) return
      seq++
      entries.push([...paths])
      while (entries.length > keep) {
        entries.shift()
        first++
      }
      const wake = waiters
      waiters = []
      for (const w of wake) w()
    },
    since,
    wait: (from, timeoutMs) => {
      const now = since(from)
      if (now === null || now.paths.length > 0) return Promise.resolve(now)
      return new Promise((resolve) => {
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(since(from))
        }
        const timer = setTimeout(finish, timeoutMs)
        waiters.push(finish)
      })
    },
  }
}
