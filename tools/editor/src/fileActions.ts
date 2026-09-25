import type { Registry } from '@mp/components'
import { hydratePrefabs, isSegment, parseQualified, qualify, stripHydrated, unlinkPrefab, type Level, type PrefabSource } from '@mp/content'
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
  adoptable: () => readonly string[]
  adopt: (types: string[]) => Promise<void>
  /** Arm this asset for the next viewport click, or disarm the one already waiting. */
  arm: (kind: 'prefabAsset' | 'model', assetId: string) => void
  recordEdit: (label: string) => void
  room: { live: () => boolean; flush: () => Promise<void>; leave: () => Promise<void> | void }
  openFile: (qualified: string) => Promise<void>
  /** Boot into whatever is left, rather than leaving a document with no file. */
  openFirstLevel: () => Promise<void>
  refreshFileList: () => Promise<void>
  reloadAssets: () => Promise<void>
  invalidatePreviews: () => void
  notify: Notify
  refreshUi: () => void
}

export const createFileActions = (host: FileActionsHost) => {
  /** Run a file operation, then rebuild the database — every one of them changes what is on disk. */
  const afterFileOp = (label: string, run: () => Promise<void>): void => {
    void (async () => {
      try {
        await run()
      } catch (e) {
        host.notify.error(`${label} failed: ${String(e)}`)
        return
      }
      host.invalidatePreviews()
      await host.reloadAssets()
      host.notify.ok(label)
      host.refreshUi()
    })()
  }

  /** Arm a placeable asset for the next viewport click, or disarm the one already waiting. */
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

  /** Why this asset cannot be placed into the open document, or `null`. Only another game's private component is a reason. */
  const unplaceableWhy = (assetId: string): string | null => {
    const { foreign } = missingIn(assetId)
    return foreign.length === 0 ? null : `uses ${foreign.join(', ')}, which this game does not have`
  }

  const armAsset = (assetId: string): void => {
    const entry = host.assets()?.db.byId[assetId]
    if (entry === undefined) return
    const why = unplaceableWhy(assetId)
    if (why !== null) {
      host.notify.warn(`${entry.name} ${why}`)
      return
    }
    // A shared component the game lacks is adopted on the way to arming, so the click that places it never sees
    // a registry without it (ADR 0077). Not while a prefab is open on top: a prefab belongs to no game.
    const { shared } = missingIn(assetId)
    if (shared.length > 0 && host.hasGame() && !host.inPrefab()) {
      void host.adopt(shared).then(() => armAsset(assetId))
      return
    }
    const kind = entry.kind === 'prefab' ? ('prefabAsset' as const) : ('model' as const)
    host.arm(kind, assetId)
    host.refreshUi()
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
   */
  const deleteAsset = (path: string): void => {
    const entry = host.assets()?.db.entries.find((e) => e.path === path)
    if (entry === undefined || entry.kind !== 'prefab') {
      afterFileOp(`deleted ${path}`, async () => host.assets()?.remove(path) ?? Promise.resolve())
      return
    }
    void (async () => {
      const id = entry.id
      const all = await listFiles('levels').catch(() => [] as FileEntry[])
      const users = all.filter((f) => f.prefabs?.includes(id) === true).map((f) => f.name)
      const openName = host.fileName()
      const here = host.doc()?.refCount(id) ?? 0
      // The open document is ahead of the listing either way: it may have placed one since the last write, or
      // removed the last one.
      const others = users.filter((n) => n !== openName)

      const counts = [
        here > 0 ? `${here} in this level` : null,
        others.length > 0 ? `${others.length} other level${others.length === 1 ? '' : 's'} (${others.join(', ')})` : null,
      ].filter((s) => s !== null)
      const body =
        counts.length === 0
          ? 'Nothing places it. The file and its id go for good — a prefab created again later gets a new id.'
          : `Used by ${counts.join(' and ')}. Those objects stay where they are and keep what they are drawing; they just stop being copies of this prefab. The file and its id go for good.`
      if (!(await askDestructive(`Delete ${entry.name}?`, body, 'Delete'))) return host.notify.ok('kept')

      // Other levels first: they are the ones that can refuse, and a refusal must stop the whole thing.
      for (const name of others) {
        try {
          const level = (await loadLevelRaw(name)) as Level
          hydratePrefabs(level, host.prefabSource)
          const n = unlinkPrefab(level, id, { types: host.registry(), freshId: freshNodeId, refKeysOf: nodeRefKeysOf })
          if (n > 0) await saveFile('levels', name, stripHydrated(level, [id]))
        } catch (e) {
          host.notify.error(`${name} could not be unlinked (${String(e)}) — nothing deleted`)
          return
        }
      }
      if (here > 0) {
        host.doc()?.unlinkPrefab(id)
        host.recordEdit(`unlinked ${entry.name}`)
        await host.room.flush().catch(() => undefined)
      }
      afterFileOp(`deleted ${path}`, async () => host.assets()?.remove(path) ?? Promise.resolve())
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
      const to = qualify({ game: ref.game, name: asked })
      const wasOpen = host.fileName() === qualified
      if (wasOpen) {
        if (host.room.live()) await host.room.flush().catch(() => undefined)
        await host.room.leave()
      }
      try {
        await apiRenameLevel(qualified, to)
      } catch (e) {
        host.notify.error(`could not rename: ${String(e)}`)
        if (wasOpen) await host.openFile(qualified) // put back what we left
        return
      }
      await host.refreshFileList()
      if (wasOpen) await host.openFile(to)
      host.notify.ok(`renamed to ${asked}`)
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
    armAsset,
    renameAsset,
    /** Delete an asset — and for a prefab, unlink every placement of it first (ADR 0097). */
    deleteAsset,
    renameLevel,
    /** Delete a level (ADR 0110), behind a confirm with the consequences named. */
    deleteLevelFile,
    /** Why this asset cannot be placed into the open document, or `null`. */
    unplaceableWhy,
    /** Component types a prefab needs, split into the shared ones the game can adopt and another game's. */
    missingIn,
  }
}
