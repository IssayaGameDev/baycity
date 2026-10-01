import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * What the assistant may read of the repository (ADR 0192): the files git tracks, from the checkout the server
 * runs from — the code that is deployed, and the content as it stands, live edits included.
 *
 * **Refused by the server, not by the model's good manners.** Three rules, every call:
 * - only a tracked file (`git ls-files`): `.env`, build output and anything ignored does not exist here;
 * - only inside the checkout, the path resolved first — `..`, an absolute path or a link leading out is refused;
 * - never a file that looks like a secret, tracked or not, as a second net.
 *
 * The keys themselves live in the state directory, outside the checkout, so no path reaches them at all.
 */

export class Refused extends Error {}

/** Names that are a secret whatever git says. */
const SECRET = [/(^|\/)\.env($|\.)/i, /\.(key|pem|p12|pfx|token)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)/i, /(^|\/)\.npmrc$/i]
export const looksSecret = (path: string): boolean => SECRET.some((r) => r.test(path))

const MAX_BYTES = 400_000
const MAX_LINES = 400
const MAX_HITS = 80
const MAX_LIST = 300

const run = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      // `git grep` exits 1 for "no match", which is an answer, not a failure.
      if (error !== null && !(args[0] === 'grep' && error.code === 1)) reject(error)
      else resolve(stdout)
    })
  })

/** A path as asked: forward slashes, no leading `./` or `/`, and refused if it climbs out. */
export const cleanPath = (asked: string): string => {
  const p = asked.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
  if (p === '' || p.split('/').includes('..') || /^[a-z]:/i.test(p)) throw new Refused(`not a path inside the repository: ${asked}`)
  return p
}

export interface RepoFiles {
  /** Tracked files under `dir` (`''` for all), sorted. */
  list: (dir: string) => Promise<readonly string[]>
  /** Lines `from`…`to` of a tracked file, numbered. */
  read: (path: string, from?: number, to?: number) => Promise<string>
  /** Matching lines across tracked files, `path:line:text`, at most `MAX_HITS`. */
  search: (query: string, opts?: { readonly path?: string; readonly regex?: boolean }) => Promise<string>
}

export const createRepoFiles = (root: string, opts: { readonly refreshMs?: number; readonly now?: () => number } = {}): RepoFiles => {
  const refreshMs = opts.refreshMs ?? 30_000
  const now = opts.now ?? (() => Date.now())
  const realRoot = realpathSync(root)
  let tracked: { at: number; set: Set<string>; sorted: string[] } | null = null

  const trackedNow = async (): Promise<{ set: Set<string>; sorted: string[] }> => {
    if (tracked !== null && now() - tracked.at < refreshMs) return tracked
    const out = await run(root, ['ls-files', '-z'])
    const sorted = out
      .split('\0')
      .filter((p) => p !== '' && !looksSecret(p))
      .sort()
    tracked = { at: now(), set: new Set(sorted), sorted }
    return tracked
  }

  /** The file on disk for a tracked path, its real location checked to be inside the checkout. */
  const fileOf = async (asked: string): Promise<{ rel: string; abs: string }> => {
    const rel = cleanPath(asked)
    if (looksSecret(rel)) throw new Refused(`${rel} is not readable here`)
    if (!(await trackedNow()).set.has(rel)) throw new Refused(`${rel} is not a file in the repository`)
    let abs: string
    try {
      abs = realpathSync(join(root, rel))
    } catch {
      throw new Refused(`${rel} is not on disk`)
    }
    if (!abs.startsWith(realRoot + sep)) throw new Refused(`${rel} leads outside the repository`)
    return { rel, abs }
  }

  return {
    list: async (dir) => {
      const prefix = dir.trim() === '' ? '' : `${cleanPath(dir).replace(/\/+$/, '')}/`
      const all = (await trackedNow()).sorted.filter((p) => p.startsWith(prefix))
      return all.length > MAX_LIST ? [...all.slice(0, MAX_LIST), `… and ${all.length - MAX_LIST} more`] : all
    },
    read: async (asked, from = 1, to = from + MAX_LINES - 1) => {
      const { rel, abs } = await fileOf(asked)
      if (statSync(abs).size > MAX_BYTES) throw new Refused(`${rel} is too large to read whole; search it instead`)
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
      const a = Math.max(1, Math.floor(from))
      const b = Math.min(lines.length, Math.floor(to), a + MAX_LINES - 1)
      const body = lines
        .slice(a - 1, b)
        .map((line, n) => `${String(a + n).padStart(5)}  ${line}`)
        .join('\n')
      return `${rel} — lines ${a}–${b} of ${lines.length}\n${body}`
    },
    search: async (query, o = {}) => {
      if (query.trim() === '') throw new Refused('nothing to search for')
      const spec = o.path === undefined || o.path.trim() === '' ? [] : ['--', cleanPath(o.path)]
      // Tracked files only, which is what `git grep` searches; binary files left out.
      const out = await run(root, ['grep', '-n', '-I', '--no-color', o.regex === true ? '-E' : '-F', '-e', query, ...spec])
      const hits = out
        .split('\n')
        .filter((l) => l !== '' && !looksSecret(l.slice(0, l.indexOf(':'))))
        .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
      if (hits.length === 0) return 'no matches'
      return hits.length > MAX_HITS ? `${hits.slice(0, MAX_HITS).join('\n')}\n… ${hits.length - MAX_HITS} more matches — narrow the search` : hits.join('\n')
    },
  }
}
