import { kindForPath, nameForPath } from '../../../packages/content/src/assets'
import { GAME_FILE, isGameName, levelRefForFile, libraryOf } from '../../../packages/content/src/layout'
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

/** What a person calls the file at `rel` (a path from `content/`), and where it sorts: levels, settings, assets. */
const describePath = (rel: string): { order: number; text: string } => {
  const level = levelRefForFile(rel)
  if (level !== null) return { order: 0, text: `${level.name} level` }
  const [game, file, ...deeper] = rel.split('/')
  if (game !== undefined && isGameName(game) && file === GAME_FILE && deeper.length === 0) return { order: 1, text: `${game} settings` }
  if (libraryOf(rel) !== undefined) {
    const kind = rel.endsWith('.anim.json') ? 'clip' : (kindForPath(rel) ?? 'asset')
    return { order: 2, text: `${nameForPath(rel).replace(/\.anim$/, '')} ${kind}` }
  }
  return { order: 3, text: rel }
}

/** How many things a subject names before it counts the rest. */
const NAMED = 3

/**
 * The commit subject for a session, as a person reads it: `Edit Roblox level, red material and keyboard settings`.
 * Levels first, then a game's settings, then assets; three named, the rest counted. Sidecars fold into their asset:
 * `warn.png` and `warn.png.meta` are one thing.
 */
export const describeCommit = (paths: Iterable<string>): string => {
  const rels = new Set([...paths].map((p) => p.replace(/\.meta$/, '').replace(/^content\//, '')))
  const items = [...rels]
    .map(describePath)
    .sort((a, b) => a.order - b.order || a.text.localeCompare(b.text))
    .map((d) => d.text)
  if (items.length === 0) return 'Edit content'
  const named = items.slice(0, NAMED)
  const rest = items.length - named.length
  if (rest > 0) return `Edit ${named.join(', ')} and ${rest} more`
  return named.length === 1 ? `Edit ${named[0]}` : `Edit ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
}
