import type { Registry } from '@mp/components'
import type { Level, Op } from '@mp/content'

import type { AssetLibrary } from './assetsApi'
import { askName } from './confirm'
import { prefabDoc, type Doc, type Mode } from './editorDoc'
import { prefabFolder, prefabTarget, sanitisePrefabName } from './prefabPath'

/**
 * The prefab gestures: opening one in its own room, coming back out, unlinking a placement, saving a
 * selection as a new prefab, and the two override directions (ADR 0091, ADR 0097, ADR 0111, ADR 0121).
 *
 * One module because they are one feature with four entry points, and because each of them is a **two-sided**
 * operation that was easy to half-do while it sat in the middle of the shell. Entering a prefab leaves the
 * level's room, so this tab is in one document at a time — the viewport, the physics world, the selection and
 * the holds are singletons keyed to the open document, and two joined rooms would be two streams repainting
 * one screen. Applying an override writes to a room this tab is not in, and only reverts here if the server
 * took it.
 *
 * It owns nothing. `doc`, `docStack` and `prefabOpen` stay in the shell, which is what the shell is for.
 */

/** What the prefab gestures need from the editor around them. */
export interface PrefabActionsHost {
  doc: () => Doc | null
  docStack: () => { doc: Doc; label: string }[]
  selection: () => readonly number[]
  selected: () => number | null
  applySelection: (indices: readonly number[]) => void
  deselect: () => void
  assets: () => AssetLibrary | null
  registry: () => Registry
  /** The prefab open on top of the file, and the level to go back to. */
  prefabOpen: () => { assetId: string; name: string; from: string } | null
  setPrefabOpen: (value: { assetId: string; name: string; from: string } | null) => void
  fileName: () => string
  setMode: (mode: Mode) => void
  /** Replace the whole stack with one document and point the editor at it. */
  setDoc: (next: Doc, name: string) => void
  /** Point the viewport at the top of the stack. */
  showDoc: () => void
  openFile: (qualified: string) => Promise<void>
  room: {
    live: () => boolean
    joinRoom: (name: string, kind?: 'prefab') => Promise<Level | null>
    leave: () => Promise<void> | void
    flush: () => Promise<void>
    submitToPrefab: (assetId: string, ops: Op[]) => Promise<string | null>
  }
  edits: () => {
    withOps: (d: Doc) => Doc
    recordEdit: (label: string) => void
    reset: () => void
  }
  refuseHeld: (index: number) => boolean
  projectFolder: () => string | null
  reloadAssets: () => Promise<void>
  setProblem: (message: string) => void
  rebuildMeshes: () => void
  rebuildLoaded: () => void
  scheduleRebuild: () => void
  loadNewReferencesThen: (redraw: () => void) => void
  invalidatePreviews: () => void
  inspectorRebuild: () => void
  setStatus: (message: string) => void
  refreshUi: () => void
  uiChanged: () => void
}

export const createPrefabActions = (host: PrefabActionsHost) => {
  /**
   * Edit the prefab behind a placement — in **its own live room** (ADR 0091), not as a lens over this level's
   * copy, because there is no copy any more. Its edits are ops on that document, everyone in it sees them, and
   * every open level following it repaints. There is no Save.
   *
   * The level's session is left, so this tab is in one document at a time: the viewport, the physics world, the
   * host.selection() and the holds are all singletons keyed to the open document, and two joined rooms would be two
   * streams repainting one screen. Back rejoins the level, and the server greets that with a fresh snapshot, so
   * what everyone else did while you were away is there when you return.
   */
  const enterPrefab = async (assetId: string): Promise<void> => {
    const entry = host.assets()?.db.byId[assetId]
    if (entry === undefined) {
      host.setStatus('that prefab is not in the project')
      return
    }
    const from = host.fileName()
    host.room.leave()
    let greeting: Level | null
    try {
      greeting = await host.room.joinRoom(assetId, 'prefab')
    } catch (e) {
      host.setStatus(`could not open ${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
      void rejoinLevel(from)
      return
    }
    const root = greeting?.nodes[0]
    if (root === undefined) {
      host.setStatus('that prefab did not load')
      void rejoinLevel(from)
      return
    }
    host.setPrefabOpen({ assetId, name: entry.name, from })
    host.docStack().length = 0
    host.docStack().push({ doc: host.edits().withOps(prefabDoc(root, host.registry())), label: `prefab: ${entry.name}` })
    host.showDoc()
    host.edits().reset()
    host.refreshUi()
  }

  /**
   * Unlink one placement (ADR 0111): it keeps exactly what it was drawing and stops being a copy of the prefab.
   * The file and every other placement are untouched.
   *
   * No confirm. It is one op, so Ctrl+Z puts the link back — unlike deleting the prefab file, which destroys
   * the id and cannot be undone (ADR 0097), and which is why *that* one asks.
   */
  const unlinkPlacement = (index: number): void => {
    const open = host.doc()
    if (open === null) return
    const label = open.label(index)
    if (!open.unlinkNode(index)) return host.setStatus(`${label} is not a prefab placement`)
    host.edits().recordEdit(`unlinked ${label}`)
    // A `replaceNode` changes the tree and what is drawn, so the same refresh a revert does.
    host.rebuildMeshes()
    host.rebuildLoaded()
    host.applySelection(host.selection())
    host.setStatus(`${label} is its own object now — the prefab is unchanged`)
  }

  const openPrefabOf = (index: number): void => {
    const id = host.doc()?.refOf(index)
    if (id === null || id === undefined) return
    void enterPrefab(id)
  }

  /** Leave the prefab and rejoin the level it was opened from, which arrives as a fresh snapshot. */
  const closePrefab = (): void => {
    const open = host.prefabOpen()
    if (open === null) return
    host.setPrefabOpen(null)
    host.room.leave()
    void rejoinLevel(open.from)
  }

  /** Reopen a level by name, as `openFile` does — used on the way back out of a prefab. */
  const rejoinLevel = async (name: string): Promise<void> => {
    host.setPrefabOpen(null)
    host.setMode('level')
    await host.openFile(name)
  }

  /**
   * Write the host.selection() into a prefab file and point it at that file (ADR 0091) — the one action that makes a
   * prefab, replacing both `Extract to prefab`, which wrote no file, and prefab mode's Save, which made no
   * reference.
   *
   * **The file goes first.** A failed write costs nothing but a status line, where the reverse order would leave
   * a placement pointing at a prefab that does not exist. If the write lands and the level edit does not, the
   * file is simply an unreferenced prefab, which is visible in the Project panel and placeable by hand.
   *
   * The undo entry holds the level's `replaceNode` and its inverse. It does **not** delete the file: by the time
   * anyone presses Ctrl+Z another level may already reference it, and deleting a file on an undo is a surprise
   * nobody recovers from. The Project panel is where a prefab is deleted.
   */
  const saveAsPrefab = async (index: number): Promise<void> => {
    const open = host.doc()
    const library = host.assets()
    if (open === null || open.mode !== 'level' || library === null) return
    const definition = open.definitionOf(index)
    if (definition === null) return
    if (host.refuseHeld(index)) return

    // Identity that survives the awaits: an index shifts under a remote edit, a ref does not.
    const ref = open.refAt(index)
    if (ref === null) return

    const folder = host.projectFolder()
    const asked = await askName('Save as prefab', sanitisePrefabName(open.nameOf(index) || open.label(index)), `Saved in content/assets/${prefabFolder(folder)}/ — the folder open in the Project panel. Letters, digits, - and _.`)
    if (asked === null) return
    const target = prefabTarget(folder, asked, library.db.entries.map((e: { path: string }) => e.path))
    if ('error' in target) {
      host.setStatus(target.error)
      return
    }

    let created
    try {
      created = await library.createPrefab(target.path, definition)
    } catch (e) {
      host.setStatus(`could not save ${target.path}: ${String(e)}`)
      return
    }
    if (created === undefined) {
      host.setProblem(`wrote ${target.path} but it was given no id — reload the editor`)
      return
    }
    host.invalidatePreviews()
    await host.reloadAssets()

    // The document may have moved under the dialog and the two requests.
    const at = host.doc() === open ? open.indexOfRef(ref) : null
    if (at === null || !open.linkToPrefab(at, created.id, definition)) {
      host.setStatus(`saved ${created.name} to ${target.path}, but that object is gone — place it from the Project panel`)
      host.refreshUi()
      return
    }
    host.edits().recordEdit('save as prefab')
    host.rebuildMeshes()
    host.rebuildLoaded()
    host.applySelection([open.indexOfRef(ref) ?? at])
    host.inspectorRebuild()
    host.uiChanged()
    host.loadNewReferencesThen(host.rebuildMeshes)
    host.setStatus(`saved ${created.name} to ${target.path} — every level can place it now`)
  }

  /**
   * Drop this placement's overrides, or push them into the prefab.
   *
   * Named rather than inline in the Inspector's host, because the Hierarchy's menu offers the same two and a
   * second copy would be a second set of edge cases.
   */
  const revertOverride = (field?: string): void => {
    const i = host.selected()
    const open = host.doc()
    if (i === null || open === null) return
    open.revert(i, field)
    host.edits().recordEdit(field === undefined ? 'revert overrides' : `revert ${field}`)
    host.rebuildMeshes()
    host.rebuildLoaded()
    host.applySelection(host.selection())
    host.setStatus('reverted to the prefab')
  }

  /** Push this placement's overrides into the shared prefab. Named for the same reason as `revertOverride`. */
  /**
   * Push this placement's overrides into the shared prefab — two documents, one gesture (ADR 0091). The prefab's
   * ops go to its own room, and only once the server has taken them does the override here go, so a refusal
   * leaves the placement exactly as it was rather than clean but unapplied.
   *
   * Ctrl+Z afterwards puts **this placement's** override back; it does not take the change out of the prefab.
   * The result looks the same either way, and the status line says so, because pushing into a prefab is a
   * deliberate act on something other levels share.
   */
  const applyOverrides = async (): Promise<void> => {
    const open = host.doc()
    const at = host.selected()
    if (at === null || open === null) return
    const plan = open.overrideOpsFor(at)
    if (plan === null) return
    const name = host.assets()?.db.byId[plan.assetId]?.name ?? 'the prefab'
    const refused = await host.room.submitToPrefab(plan.assetId, plan.ops)
    if (refused !== null) {
      host.setStatus(`${name} did not take it: ${refused} — this placement is unchanged`)
      return
    }
    if (host.doc() !== open) return // the document moved under the round trip
    open.revert(at)
    host.edits().recordEdit('apply to prefab')
    host.rebuildMeshes()
    host.rebuildLoaded()
    host.applySelection(host.selection())
    host.setStatus(`applied to ${name} — every level using it follows; undo puts this placement's override back`)
  }
  /**
   * Revert every override in the placement at `index` — the whole instance, not one piece (ADR 0122).
   *
   * The placement root carries no override of its own, so this is the only Revert that means anything when
   * the prefab object itself is what you selected. One batch underneath, so it is one Ctrl+Z.
   */
  const revertPlacement = (index: number): void => {
    const open = host.doc()
    if (open === null) return
    const count = open.placementOverrides(index).length
    const added = open.placementAdded(index).length
    const gone = open.placementRemoved(index).length
    if (count + added + gone === 0) return
    open.revertPlacement(index)
    host.edits().recordEdit('revert prefab overrides')
    host.rebuildMeshes()
    host.rebuildLoaded()
    host.applySelection(host.selection())
    // Deleting is said out loud: it is the one part of a revert that loses work, and Ctrl+Z is the way back.
    const removed = added === 0 ? '' : `, removed ${added} added object${added === 1 ? '' : 's'}`
    const back = gone === 0 ? '' : `, put ${gone} piece${gone === 1 ? '' : 's'} back`
    host.setStatus(`reverted ${count} object${count === 1 ? '' : 's'} to the prefab${removed}${back}`)
  }

  /**
   * Push every override in the placement into the shared prefab (ADR 0122).
   *
   * The same two-room gesture as the per-piece Apply: the ops go to the prefab's own document, and the
   * overrides here are dropped only if it took them. Every piece in one submission, so a partial failure
   * cannot leave half the instance applied.
   */
  const applyPlacementOverrides = async (index: number): Promise<void> => {
    const open = host.doc()
    if (open === null) return
    const plan = open.placementOverrideOps(index)
    if (plan === null) return
    const count = open.placementOverrides(index).length + open.placementAdded(index).length + open.placementRemoved(index).length
    const name = host.assets()?.db.byId[plan.assetId]?.name ?? 'the prefab'
    const refused = await host.room.submitToPrefab(plan.assetId, plan.ops)
    if (refused !== null) {
      host.setStatus(`${name} did not take it: ${refused} — this placement is unchanged`)
      return
    }
    if (host.doc() !== open) return // the document moved under the round trip
    open.revertPlacement(index)
    host.edits().recordEdit('apply to prefab')
    host.rebuildMeshes()
    host.rebuildLoaded()
    host.applySelection(host.selection())
    host.setStatus(`applied ${count} object${count === 1 ? '' : 's'} to ${name} — every level using it follows`)
  }

  return {
    /** Edit the prefab behind a placement, in its own live room (ADR 0091). */
    enterPrefab,
    /** From a placement: the Inspector's Open, and the Hierarchy and viewport menus. */
    openPrefabOf,
    /** Leave the prefab and rejoin the level it was opened from. */
    closePrefab,
    /** Reopen a level by name, as `openFile` does — used on the way back out of a prefab. */
    rejoinLevel,
    /** Unlink one placement (ADR 0111): it keeps what it was drawing and stops being a copy. */
    unlinkPlacement,
    saveAsPrefab,
    /** Throw this placement's overrides away and take the prefab's values back. */
    revertOverride,
    /** Push this placement's overrides into the prefab, for everyone (ADR 0091). */
    applyOverrides,
    /** The same two, from the placement root, over every piece of it (ADR 0122). */
    revertPlacement,
    applyPlacementOverrides,
  }
}
