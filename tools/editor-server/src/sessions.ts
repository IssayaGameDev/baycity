import type { User } from './config'

/**
 * A session is one person's uncommitted work: the paths they have changed since their last commit.
 *
 * Commits are per session, not per save (ADR 0083): Ctrl+S every thirty seconds for two hours is one commit
 * when the lock is released, not two hundred and forty. Disk is always current either way — a session only
 * decides *when git records it*. A safety commit every `safetyMs` bounds how much one crash could lose from
 * history (nothing is lost from disk).
 */
export interface Session {
  user: User
  dirty: Set<string>
  /** When the first uncommitted change landed. */
  since: number
}

export type SessionTable = Map<string, Session>

export const markDirty = (table: SessionTable, user: User, paths: readonly string[], now: number): void => {
  if (paths.length === 0) return
  let s = table.get(user.email)
  if (s === undefined) {
    s = { user, dirty: new Set(), since: now }
    table.set(user.email, s)
  }
  for (const p of paths) s.dirty.add(p)
}

/** Take (and clear) a user's session. `null` when nothing is dirty. */
export const take = (table: SessionTable, user: User): Session | null => {
  const s = table.get(user.email)
  if (s === undefined || s.dirty.size === 0) return null
  table.delete(user.email)
  return s
}

/** Sessions older than `safetyMs`, taken. */
export const takeDue = (table: SessionTable, now: number, safetyMs: number): Session[] => {
  const due: Session[] = []
  for (const s of [...table.values()]) if (s.dirty.size > 0 && now - s.since >= safetyMs) due.push(s)
  for (const s of due) table.delete(s.user.email)
  return due
}

/** Everything, taken — for deploy, which needs a clean tree before it merges. */
export const takeAll = (table: SessionTable): Session[] => {
  const all = [...table.values()].filter((s) => s.dirty.size > 0)
  table.clear()
  return all
}

const LEVEL = /^content\/levels\/([^/]+)\.json$/
const GAME = /^content\/games\/([^/]+)\.json$/
/** The shared library, or a game's own (ADR 0161). */
const ASSET = /^content\/(?:[^/]+\/)?assets\/(.+)$/

const KINDS: [RegExp, string][] = [
  [/\.prefab\.json$/, 'prefab'],
  [/\.mat\.json$/, 'material'],
  [/\.anim\.json$/, 'clip'],
  [/\.(png|jpe?g|webp|ktx2)$/i, 'texture'],
  [/\.glb$/i, 'model'],
]

/** One path, as a commit subject reads it: `level keyboard`, `prefab Trampoline`, `texture warn.png`. */
const describePath = (path: string): string => {
  const level = LEVEL.exec(path)
  if (level !== null) return `level ${level[1]}`
  const game = GAME.exec(path)
  if (game !== null) return `the ${game[1]} component list`
  const asset = ASSET.exec(path)
  if (asset !== null) {
    const file = asset[1]!.split('/').pop() ?? asset[1]!
    const kind = KINDS.find(([re]) => re.test(file))?.[1] ?? 'asset'
    const name = file.replace(/\.(prefab|mat|anim)\.json$/, '')
    return `${kind} ${name}`
  }
  return path
}

/**
 * The commit subject for a session: imperative, one line, the first item named and the rest counted.
 * Sidecars are folded into their asset: `warn.png` and `warn.png.meta` are one thing.
 */
export const describeCommit = (paths: Iterable<string>): string => {
  const items = [...new Set([...paths].map((p) => p.replace(/\.meta$/, '')))].sort().map(describePath)
  const [first, ...rest] = items
  if (first === undefined) return 'Edit content'
  return rest.length === 0 ? `Edit ${first}` : `Edit ${first} and ${rest.length} more`
}
