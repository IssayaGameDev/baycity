import { libraryOf } from '@mp/content'

import type { AssetLibrary } from './assetsApi'

/**
 * Other people's asset changes, as they happen (ADR 0156).
 *
 * The server numbers every write it makes (`changes.ts`, the feed the live mirror follows) and answers a
 * long poll the moment there is news. The editor follows the same feed from where its asset list was read, and
 * when an asset path goes by, reloads what changed. Before this an upload, a rename or a material edit by
 * someone else reached you only with your own next file operation, or a page reload.
 *
 * Levels go by on the feed too — every live edit's write — and are not this watch's: a level open here is
 * already live, and one that is not is read fresh when opened.
 */

/** The feed's repo-relative paths that are in an asset library — any library (ADR 0161) — as paths from `content/`. */
export const assetPathsOf = (paths: readonly string[]): string[] => {
  const out = new Set<string>()
  for (const p of paths) {
    if (!p.startsWith('content/')) continue
    const path = p.slice('content/'.length)
    if (libraryOf(path) === undefined) continue
    // A sidecar is its asset's: a new or moved one is a list change, found by comparing lists.
    out.add(path.replace(/\.meta$/, ''))
  }
  return [...out]
}

/**
 * What differs between the library this tab has and a fresh one: whether the list itself changed (an asset
 * added, removed, renamed or moved, a folder made), and which assets' contents did. A material or prefab is
 * compared by its JSON; a texture or model cannot be, so one the feed named is taken as changed — its bytes
 * were replaced (an upload keeps the id). Pure.
 */
export const libraryChanges = (before: AssetLibrary | null, after: AssetLibrary, named: readonly string[]): { list: boolean; ids: string[] } => {
  if (before === null) return { list: true, ids: after.db.entries.map((e) => e.id) }
  const key = (lib: AssetLibrary): string => JSON.stringify([lib.db.entries.map((e) => [e.id, e.kind, e.path]), lib.folders, lib.libraries])
  const list = key(before) !== key(after)
  const touched = new Set(named)
  const ids: string[] = []
  for (const e of after.db.entries) {
    if (e.kind === 'material') {
      if (JSON.stringify(before.materialOf(e.id)) !== JSON.stringify(after.materialOf(e.id))) ids.push(e.id)
    } else if (e.kind === 'prefab') {
      if (JSON.stringify(before.prefabOf(e.id)) !== JSON.stringify(after.prefabOf(e.id))) ids.push(e.id)
    } else if (touched.has(e.path) && before.db.byId[e.id]?.path === e.path) ids.push(e.id)
  }
  return { list, ids }
}

export interface AssetWatchHost {
  /** Where the asset list this tab holds was read, on the feed. */
  seq: () => number
  /** Asset paths the feed named since. The watch waits for this before asking again. */
  changed: (paths: string[]) => Promise<void>
  /** The feed lost track — the server restarted, or this tab fell too far behind: reload everything. */
  lost: () => Promise<void>
  /** Injectable for tests. */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
  sleep?: (ms: number) => Promise<void>
}

/** How long the server may hold a poll; it answers sooner the moment there is news. */
export const WATCH_TIMEOUT_MS = 25_000
const BACKOFF_MIN_MS = 2_000
const BACKOFF_MAX_MS = 30_000

/** Follow the feed until `stop`. Errors back off from 2 s to 30 s and never end the watch. */
export const watchAssets = (host: AssetWatchHost): { stop: () => void } => {
  const get = host.fetch ?? ((url: string) => fetch(url))
  const sleep = host.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let stopped = false
  void (async () => {
    let since = host.seq()
    let backoff = BACKOFF_MIN_MS
    while (!stopped) {
      try {
        const r = await get(`/api/changes?since=${since}&timeout=${WATCH_TIMEOUT_MS}`)
        if (stopped) return
        if (r.status === 410) {
          await host.lost()
          since = host.seq()
          backoff = BACKOFF_MIN_MS
          continue
        }
        if (!r.ok) throw new Error(`changes → ${r.status}`)
        const batch = (await r.json()) as { seq?: unknown; paths?: unknown }
        if (typeof batch.seq !== 'number' || !Array.isArray(batch.paths)) throw new Error('changes: not a batch')
        since = batch.seq
        backoff = BACKOFF_MIN_MS
        const paths = assetPathsOf(batch.paths.filter((p): p is string => typeof p === 'string'))
        if (paths.length > 0) await host.changed(paths)
      } catch {
        if (stopped) return
        await sleep(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    }
  })()
  return { stop: () => void (stopped = true) }
}
