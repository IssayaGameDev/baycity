import type { User } from './config'

/**
 * One lock per file, held while the file is open in someone's editor (ADR 0083).
 *
 * The Perforce model, chosen over merging: a level is one JSON document and two people's edits to it cannot
 * be merged, so the second person gets read-only rather than a conflict later. Anyone may take a **stale**
 * lock — one whose holder has not heartbeated within `staleMs` — because a closed laptop must not block a
 * friend for the evening. Nobody may take a live one: everyone is equal, there is no force-unlock.
 *
 * Pure over a plain table so it can be tested without a clock or a disk; the server persists the table.
 */
export interface Lock {
  owner: User
  /** When it was taken. */
  since: number
  /** Last heartbeat. */
  seen: number
}

export type LockTable = Record<string, Lock>

export interface LockRules {
  staleMs: number
}

export const sameUser = (a: User, b: User): boolean => a.email === b.email

/** The live holder of `path`, or `null` when unlocked or stale. */
export const holder = (table: LockTable, path: string, now: number, rules: LockRules): User | null => {
  const lock = table[path]
  if (lock === undefined) return null
  return now - lock.seen < rules.staleMs ? lock.owner : null
}

export type AcquireResult = { ok: true; lock: Lock } | { ok: false; owner: User }

/** Take `path` for `user`. Re-taking your own lock refreshes it. A stale lock is silently replaced. */
export const acquire = (table: LockTable, path: string, user: User, now: number, rules: LockRules): AcquireResult => {
  const live = holder(table, path, now, rules)
  if (live !== null && !sameUser(live, user)) return { ok: false, owner: live }
  const existing = table[path]
  const lock: Lock = { owner: user, since: live !== null && existing !== undefined ? existing.since : now, seen: now }
  table[path] = lock
  return { ok: true, lock }
}

/** Drop `path` if `user` holds it. Releasing someone else's lock is a no-op, not an error. */
export const release = (table: LockTable, path: string, user: User): boolean => {
  const lock = table[path]
  if (lock === undefined || !sameUser(lock.owner, user)) return false
  delete table[path]
  return true
}

/** Refresh every lock in `paths` that `user` holds. Returns the ones that were not theirs (lost to staleness). */
export const heartbeat = (table: LockTable, paths: readonly string[], user: User, now: number): string[] => {
  const lost: string[] = []
  for (const path of paths) {
    const lock = table[path]
    if (lock === undefined || !sameUser(lock.owner, user)) lost.push(path)
    else lock.seen = now
  }
  return lost
}

/** Who stops `user` writing `path` now: `null` when unlocked, stale, or theirs. */
export const blocker = (table: LockTable, path: string, user: User, now: number, rules: LockRules): User | null => {
  const live = holder(table, path, now, rules)
  return live === null || sameUser(live, user) ? null : live
}

/** Every lock `user` holds, live or not. */
export const heldBy = (table: LockTable, user: User): string[] =>
  Object.entries(table)
    .filter(([, lock]) => sameUser(lock.owner, user))
    .map(([path]) => path)

/** Drop stale locks. Returns their owners, so the caller can commit those sessions. */
export const sweep = (table: LockTable, now: number, rules: LockRules): Lock[] => {
  const dropped: Lock[] = []
  for (const [path, lock] of Object.entries(table)) {
    if (now - lock.seen >= rules.staleMs) {
      dropped.push(lock)
      delete table[path]
    }
  }
  return dropped
}
