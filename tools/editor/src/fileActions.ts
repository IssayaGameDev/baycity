import type { Registry } from '@mp/components'
import { hydratePrefabs, isSegment, libraryOf, mayUse, parseQualified, qualify, stripHydrated, unlinkPrefab, type AssetEntry, type Level, type PrefabSource, type UnlinkDeps } from '@mp/content'
import { isSharedComponent } from '@mp/components'

import type { AssetLibrary } from './assetsApi'
import { renamedTo } from './assetTree'
import { askDestructive, askName } from './confirm'
import { unknownComponentTypes, type Doc } from './editorDoc'
import { deleteLevel as apiDeleteLevel, listFiles, loadLevelRaw, renameLevel as apiRenameLevel, saveFile, type FileEntry } from './filesApi'
import type { Notify } from './notices'

/**
 * Operations on the project tree's files: arming an asset to place, renaming, deleting, and the two deletes
 * that are more than a file removal (ADR 0097, ADR 0110, ADR 0121).
 *
 * One module because they share one shape — ask, call the API, then invalidate previews, re-read the asset
 * database and refresh the tree (`afterFileOp`) — and because two of them are the only places in the editor
 * that rewrite a file it does not have open.
 *
 * Deleting a **prefab** unlinks every placement of it first, which only the editor can do: the unlink needs a
 * component registry, for which components are singletons and which parameters are node references that must
 * follow a re-id, and the editor-server has none by design. Deleting a **level** is heavier still, because
 * nothing else holds a copy — a prefab lives on in the placements that referenced it, a level is the content.
 */

/** What deleting a path takes with it: one asset, or a folder and everything under it. */
export interface Deleted {
  /** The file's asset name, or the folder's own name. */
  name: string
  folder: boolean
  /** Assets under a folder; `0` for a file. */
  inside: number
  /** The prefabs among them, each of which is unlinked first (ADR 0097). */
  prefabs: AssetEntry[]
}

/** What a delete of `path` covers, from the database. Pure. */
export const deletedBy = (entries: readonly AssetEntry[], path: string): Deleted => {
  const entry = entries.find((e) => e.path === path)
  if (entry !== undefined) return { name: entry.name, folder: false, inside: 0, prefabs: entry.kind === 'prefab' ? [entry] : [] }
  const under = entries.filter((e) => e.path.startsWith(`${path}/`))
  return { name: path.slice(path.lastIndexOf('/') + 1), folder: true, inside: under.length, prefabs: under.filter((e) => e.kind === 'prefab') }
}

/**
 * The question before deleting prefabs: what goes, and what happens to the objects placing them. `here` is how
 * many placements the open level has, `others` the other levels placing any of them. Pure.
 */
export const deleteWording = (what: Deleted, here: number, others: readonly string[]): { title: string; body: string } => {
  const counts = [
    here > 0 ? `${here} in this level` : null,
    others.length > 0 ? `${others.length} other level${others.length === 1 ? '' : 's'} (${others.join(', ')})` : null,
  ].filter((s) => s !== null)
  if (!what.folder) {
    return {
      title: `Delete ${what.name}?`,
      body:
        counts.length === 0
          ? 'Nothing places it. The file and its id go for good — a prefab created again later gets a new id.'
          : `Used by ${counts.join(' and ')}. Those objects stay where they are and keep what they are drawing; they just stop being copies of this prefab. The file and its id go for good.`,
    }
  }
  const n = what.prefabs.length
  const names = what.prefabs.map((p) => p.name)
  const listed = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  const holds = n === 1 ? `It holds the prefab ${listed}.` : `It holds ${n} prefabs: ${listed}.`
  return {
    title: `Delete ${what.name} and the ${what.inside} asset${what.inside === 1 ? '' : 's'} in it?`,
    body:
      counts.length === 0
        ? `${holds} Nothing places ${n === 1 ? 'it' : 'them'}. The files and their ids go for good.`
        : `${holds} Used by ${counts.join(' and ')}. Those objects stay where they are and keep what they are drawing; they just stop being copies of ${n === 1 ? 'that prefab' : 'those prefabs'}. The files and their ids go for good.`,
  }
}

/**
 * The question before deleting several at once (ADR 0166): how many, how many files go with them, and what happens
 * to the objects placing any prefab among them. Pure.
 */
export const severalWording = (count: number, files: number, prefabs: number, here: number, others: readonly string[]): { title: string; body: string } => {
  const counts = [
    here > 0 ? `${here} in this level` : null,
    others.length > 0 ? `${others.length} other level${others.length === 1 ? '' : 's'} (${others.join(', ')})` : null,
  ].filter((s) => s !== null)
  const goes = `${files} asset${files === 1 ? '' : 's'} and ${files === 1 ? 'its id go' : 'their ids go'} for good.`
  const placed =
    prefabs === 0 || counts.length === 0
      ? ''
      : ` ${prefabs === 1 ? 'A prefab among them is' : `${prefabs} prefabs among them are`} used by ${counts.join(' and ')}: those objects stay where they are and keep what they are drawing; they just stop being copies.`
  return { title: `Delete ${count} items?`, body: `${goes}${placed}` }
}

/**
 * A level file with every placement of `ids` unlinked, as it goes back to disk, or `null` when it placed none of
 * them. Pure, over a level read from disk.
 *
 * Everything hydration filled goes back out, not only the prefabs deleted: stripping just those wrote every
 * *other* prefab the level places into its file, as a frozen copy that stopped following its prefab for good
 * (ADR 0124).
 */
export const unlinkedLevel = (level: Level, ids: readonly string[], source: PrefabSource, deps: UnlinkDeps): Level | null => {
  const { filled } = hydratePrefabs(level, source)
  let n = 0
  for (const id of ids) n += unlinkPrefab(level, id, deps)
  return n === 0 ? null : stripHydrated(level, new Set([...filled, ...ids]))
}

/** What file operations need from the editor around them. */
export interface FileActionsHost {
  doc: () => Doc | null
  assets: () => AssetLibrary | null
  registry: () => Registry
  /** Prefab definitions, for hydrating a level this editor does not have open. */
  prefabSource: PrefabSource
  /** The open file's qualified name — which of the listed levels is this one. */
  fileName: () => string
  levelEntries: () => readonly FileEntry[]
  /** A game is picked, so a shared component can be adopted into it (ADR 0077). */
  hasGame: () => boolean
  /** A prefab is open on top of the file; a prefab belongs to no game, so nothing is adopted into one. */
  inPrefab: () => boolean
  /** Whose the document being edited is (ADR 0161): a level's game, or an open prefab's library (`null` for Shared). */
  editingFor: () => string | null
  adoptable: () => readonly string[]
  adopt: (types: string[]) => Promise<void>
  recordEdit: (label: string) => void
  room: { live: () => boolean; flush: () => Promise<void>; leave: () => Promise<void> | void }
  openFile: (qualified: string) => Promise<void>
  /** Boot into whatever is left, rather than leaving a document with no file. */
  openFirstLevel: () => Promise<void>
  refreshFileList: () => Promise<void>
  /** `named`: paths just written whose bytes the reload cannot compare — an upload replacing a texture (ADR 0157). */
  reloadAssets: (named?: readonly string[]) => Promise<void>
  invalidatePreviews: () => void
  notify: Notify
  refreshUi: () => void
}

export const createFileActions = (host: FileActionsHost) => {
  /**
   * Run a file operation, then rebuild the database — every one of them changes what is on disk. `named` are
   * the paths whose contents it replaced, so what was compiled from them is too.
   */
  const afterFileOp = (label: string, run: () => Promise<void>, named?: readonly string[]): void => {
    void (async () => {
      try {
        await run()
      } catch (e) {
        host.notify.error(`${label} failed: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      host.invalidatePreviews()
      await host.reloadAssets(named)
      host.notify.ok(label)
      host.refreshUi()
    })()
  }

  /**
   * The component types a prefab file uses that the open document's registry lacks, split into the shared ones
   * the game can adopt (ADR 0077) and another game's private ones, which it cannot (ADR 0076).
   */
  const missingIn = (assetId: string): { shared: string[]; foreign: string[] } => {
    const entry = host.assets()?.db.byId[assetId]
    const root = entry?.kind === 'prefab' ? host.assets()?.prefabOf(assetId) : undefined
    const open = host.doc()
    if (root === undefined || open === null) return { shared: [], foreign: [] }
    const unknown = unknownComponentTypes(root, open.registry)
    return { shared: unknown.filter(isSharedComponent), foreign: unknown.filter((t: string) => !isSharedComponent(t)) }
  }

  /**
   * Why this asset cannot be placed into the open document, or `null`: another game's private component (ADR 0076),
   * or a library the document may not use (ADR 0161) — another game's, or any game's inside a Shared prefab.
   */
  const unplaceableWhy = (assetId: string): string | null => {
    const entry = host.assets()?.db.byId[assetId]
    const user = host.editingFor()
    if (entry !== undefined && !mayUse(user, entry.path)) {
      return user === null ? `is ${libraryOf(entry.path) ?? 'another'}'s own: a Shared prefab uses only Shared's` : `is ${libraryOf(entry.path) ?? 'another game'}'s own, not ${user}'s`
    }
    const { foreign } = missingIn(assetId)
    return foreign.length === 0 ? null : `uses ${foreign.join(', ')}, which this game does not have`
  }

  /**
   * Make a dropped asset ready to place, then `place` it (ADR 0164): refused with why when it cannot go here, and a
   * shared component the game lacks adopted first, so the placement never meets a registry without it (ADR 0077) —
   * not while a prefab is open on top, which belongs to no game.
   *
   * `fresh` once the prefab has been fetched again. The copy the library loaded at boot is behind any edit a
   * collaborator has made to it since, and a level that has no copy of its own places from this one — so a prefab
   * is placed from the server's current copy, or from the one it had when the server cannot be asked.
   */
  const whenPlaceable = (assetId: string, place: (kind: 'prefabAsset' | 'model') => void, fresh = false): void => {
    const library = host.assets()
    const entry = library?.db.byId[assetId]
    if (library === null || entry === undefined || (entry.kind !== 'prefab' && entry.kind !== 'model')) return
    if (entry.kind === 'prefab' && !fresh) {
      void library
        .refreshPrefab(assetId)
        .catch(() => undefined)
        .then(() => whenPlaceable(assetId, place, true))
      return
    }
    const why = unplaceableWhy(assetId)
    if (why !== null) {
      host.notify.warn(`${entry.name} ${why}`)
      return
    }
    const { shared } = missingIn(assetId)
    if (shared.length > 0 && host.hasGame() && !host.inPrefab()) {
      void host.adopt(shared).then(() => whenPlaceable(assetId, place, true))
      return
    }
    place(entry.kind === 'prefab' ? 'prefabAsset' : 'model')
  }

  const renameAsset = (path: string, name: string): void =>
    afterFileOp(`renamed to ${name}`, async () => host.assets()?.move(path, renamedTo(path, name)) ?? Promise.resolve())

  /** A node id, minted the way `editorDoc` mints them: four random bytes, hex. */
  const freshNodeId = (): string => {
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** Every `nodeRef` parameter a component type declares — what a re-id has to follow (ADR 0097). */
  const nodeRefKeysOf = (type: string): string[] => {
    const def = host.registry().get(type)
    return def === undefined ? [] : Object.entries(def.params).filter(([, spec]) => spec.kind === 'nodeRef').map(([key]) => key)
  }

  /**
   * Delete an asset — and for a **prefab**, unlink every placement of it first (ADR 0097).
   *
   * Deleting a prefab used to be silent and unrecoverable: no warning, no count of what referenced it, and the
   * `.meta` sidecar went with the file, so the asset id died and re-creating the prefab could never re-link the
   * placements. They degraded to objects that kept a transform and drew nothing — right for a file that went
   * missing by accident, wrong for one somebody chose to delete.
   *
   * So the placements are unlinked instead: they keep exactly what they were drawing and stop being copies of
   * anything. Kodjo's call.
   *
   * Two paths, because the editor is the only side that can do this. The unlink needs a component registry —
   * for which components are singletons, and which parameters are node references that must follow a re-id —
   * and the editor-server has none by design.
   *
   * - the **open** level goes through its own document, as ops: one undo entry, and everyone in the room sees it.
   * - every **other** level goes through `GET` + `PUT`, which 409s while that level is open live. That refusal
   *   is the guard: rather than rewrite a file under somebody, the whole delete stops and names the level.
   *
   * The prefab file goes last. A failed unlink then costs nothing, where the reverse order would leave
   * placements pointing at an id that no longer exists.
   *
   * **A folder is every prefab in it.** Deleting one used to remove its prefabs as plain files, so their
   * placements lost their definitions and drew nothing — the very outcome ADR 0097 chose against.
   */
  /**
   * Where these prefabs are placed: the other levels (from the listing), and how many times in this one. The open
   * document is ahead of the listing either way: it may have placed one since the last write, or removed the last.
   */
  const placementsOf = async (ids: readonly string[]): Promise<{ others: string[]; here: number }> => {
    const all = await listFiles('levels').catch(() => [] as FileEntry[])
    const openName = host.fileName()
    const others = all.filter((f) => f.name !== openName && f.prefabs?.some((id) => ids.includes(id)) === true).map((f) => f.name)
    const here = ids.reduce((n, id) => n + (host.doc()?.refCount(id) ?? 0), 0)
    return { others, here }
  }

  /**
   * Unlink every placement of these prefabs, so deleting them leaves the objects where they are: the other levels
   * first — they are the ones that can refuse, and a refusal must stop the whole thing — then this one. `false`
   * when one refused, and nothing is to be deleted.
   */
  const unlinkEverywhere = async (prefabs: readonly AssetEntry[], others: readonly string[], here: number): Promise<boolean> => {
    const ids = prefabs.map((e) => e.id)
    for (const name of others) {
      try {
        const unlinked = unlinkedLevel((await loadLevelRaw(name)) as Level, ids, host.prefabSource, { types: host.registry(), freshId: freshNodeId, refKeysOf: nodeRefKeysOf })
        if (unlinked !== null) await saveFile('levels', name, unlinked)
      } catch (e) {
        host.notify.error(`${name} could not be unlinked (${String(e)}) — nothing deleted`)
        return false
      }
    }
    if (here > 0) {
      for (const id of ids) if ((host.doc()?.refCount(id) ?? 0) > 0) host.doc()?.unlinkPrefab(id)
      host.recordEdit(prefabs.length === 1 ? `unlinked ${prefabs[0]!.name}` : `unlinked ${prefabs.length} prefabs`)
      await host.room.flush().catch(() => undefined)
    }
    return true
  }

  const deleteAsset = (path: string): void => {
    const db = host.assets()?.db
    if (db === undefined) return
    const covered = deletedBy(db.entries, path)
    const remove = (): void => afterFileOp(`deleted ${path}`, async () => host.assets()?.remove(path) ?? Promise.resolve())
    if (covered.prefabs.length === 0) {
      // A confirm only where it is warranted: a folder takes everything under it, and an id that disappears
      // greyboxes silently rather than failing (ADR 0028).
      if (covered.inside > 0 && !confirm(`Delete ${covered.name} and the ${covered.inside} asset${covered.inside === 1 ? '' : 's'} in it?`)) return
      remove()
      return
    }
    void (async () => {
      const { others, here } = await placementsOf(covered.prefabs.map((e) => e.id))
      const ask = deleteWording(covered, here, others)
      if (!(await askDestructive(ask.title, ask.body, 'Delete'))) return host.notify.ok('kept')
      if (await unlinkEverywhere(covered.prefabs, others, here)) remove()
    })()
  }

  /**
   * Delete several at once (ADR 0166), asked once for all: what goes, and what becomes of the objects placing any
   * prefab among them. Then all or none on the server, which refuses while anyone holds any of them. A path inside
   * another one being deleted is that one's already.
   */
  const deleteAssets = (paths: readonly string[]): void => {
    const own = paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)))
    if (own.length === 0) return
    if (own.length === 1) return deleteAsset(own[0]!)
    const db = host.assets()?.db
    if (db === undefined) return
    const parts = own.map((p) => deletedBy(db.entries, p))
    const files = parts.reduce((n, d) => n + (d.folder ? d.inside : 1), 0)
    const prefabs = [...new Map(parts.flatMap((d) => d.prefabs).map((e) => [e.id, e])).values()]
    void (async () => {
      const { others, here } = await placementsOf(prefabs.map((e) => e.id))
      const ask = severalWording(own.length, files, prefabs.length, here, others)
      if (!(await askDestructive(ask.title, ask.body, 'Delete'))) return host.notify.ok('kept')
      if (prefabs.length > 0 && !(await unlinkEverywhere(prefabs, others, here))) return
      afterFileOp(`deleted ${own.length} items`, async () => host.assets()?.removeMany(own) ?? Promise.resolve())
    })()
  }

  /**
   * Rename a level (ADR 0110).
   *
   * The open one is handled by leaving its live session first: the server refuses a rename while the document
   * is open, because the next flush would write the old file straight back. Flush, leave, rename, reopen under
   * the new name — and a refusal past that point is someone *else* holding it, which is theirs to release.
   *
   * A `to` in another game moves the level there, since the folder is the game.
   */
  /**
   * Move a level's file to `to` — a new name, or another game's folder (ADR 0162). The server refuses while the level
   * is open, so the one this tab has open is left first and opened again where it went, or where it was.
   */
  const relocateLevel = async (from: string, to: string, what: { done: string; failed: string }): Promise<void> => {
    const wasOpen = host.fileName() === from
    if (wasOpen) {
      if (host.room.live()) await host.room.flush().catch(() => undefined)
      await host.room.leave()
    }
    try {
      await apiRenameLevel(from, to)
    } catch (e) {
      host.notify.error(`${what.failed}: ${e instanceof Error ? e.message : String(e)}`)
      if (wasOpen) await host.openFile(from) // put back what we left
      return
    }
    await host.refreshFileList()
    if (wasOpen) await host.openFile(to)
    host.notify.ok(what.done)
  }

  const renameLevel = (qualified: string): void => {
    const ref = parseQualified(qualified)
    if (ref === null) return
    void (async () => {
      const asked = await askName(
        `Rename ${ref.name}`,
        ref.name,
        `File name in content/${ref.game}/levels/. Letters, digits, - and _. Any ?level=${ref.name} link, and the multiplayer room name, change with it.`,
      )
      if (asked === null || asked === ref.name) return
      if (!isSegment(asked)) return host.notify.warn(`"${asked}" is not a file name: letters, digits, - and _ only`)
      await relocateLevel(qualified, qualify({ game: ref.game, name: asked }), { done: `renamed to ${asked}`, failed: 'could not rename' })
    })()
  }

  /**
   * Move a level to another game (ADR 0162), after a short confirmation, Kodjo's call. The file goes to that game's
   * folder and its tag with it; the server refuses while it uses its old game's own assets.
   */
  const moveLevelToGame = (qualified: string, game: string, label: string): void => {
    const ref = parseQualified(qualified)
    if (ref === null || ref.game === game) return
    void (async () => {
      const go = await askDestructive(
        `Move ${ref.name} to ${label}?`,
        `It becomes a ${label} level: it opens with ${label}'s components, and its ?level= link and its multiplayer room go with it.`,
        'Move',
      )
      if (!go) return
      await relocateLevel(qualified, qualify({ game, name: ref.name }), { done: `moved ${ref.name} to ${label}`, failed: `could not move ${ref.name}` })
    })()
  }

  /**
   * Delete a level (ADR 0110), behind `askDestructive` with the consequences named.
   *
   * Heavier than an asset delete because there is no undo and nothing else holds a copy: a prefab lives on in
   * the placements that referenced it, a level is the content. So the dialogue says what it is, whether it is
   * the one you have open, and whether it is the level its game boots into; Cancel is the keyboard default.
   */
  const deleteLevelFile = (qualified: string): void => {
    const ref = parseQualified(qualified)
    if (ref === null) return
    void (async () => {
      const siblings = host.levelEntries().filter((e) => e.mode === ref.game && e.name !== qualified)
      const isOpen = host.fileName() === qualified
      const isDefault = ref.name === 'default'
      const notes = [
        isOpen ? 'It is the level you have open' : null,
        isDefault ? `it is what ${ref.game} loads with no ?level=, so the game will boot into ${siblings[0] === undefined ? 'nothing' : (parseQualified(siblings[0].name)?.name ?? siblings[0].name)} instead` : null,
        siblings.length === 0 ? `it is the only level ${ref.game} has` : null,
      ].filter((n) => n !== null)
      const body = `The file goes for good — there is no undo and no copy anywhere else.${notes.length > 0 ? ` ${notes.join(', and ')}.` : ''}`
      if (!(await askDestructive(`Delete ${ref.name}?`, body, 'Delete for good'))) return host.notify.ok('kept')

      if (isOpen) await host.room.leave()
      try {
        await apiDeleteLevel(qualified)
      } catch (e) {
        host.notify.error(`could not delete: ${String(e)}`)
        if (isOpen) await host.openFile(qualified)
        return
      }
      await host.refreshFileList()
      // Nothing is open now, so boot into whatever is left rather than leaving a document with no file.
      if (isOpen) await host.openFirstLevel()
      host.notify.ok(`deleted ${ref.name}`)
    })()
  }
  return {
    /** Ask, run, then invalidate previews, re-read the asset database and refresh the tree. */
    afterFileOp,
    /** Arm a placeable asset for the next viewport click, adopting any shared component it needs first. */
    whenPlaceable,
    deleteAssets,
    renameAsset,
    /** Delete an asset — and for a prefab, unlink every placement of it first (ADR 0097). */
    deleteAsset,
    renameLevel,
    moveLevelToGame,
    /** Delete a level (ADR 0110), behind a confirm with the consequences named. */
    deleteLevelFile,
    /** Why this asset cannot be placed into the open document, or `null`. */
    unplaceableWhy,
    /** Component types a prefab needs, split into the shared ones the game can adopt and another game's. */
    missingIn,
  }
}
