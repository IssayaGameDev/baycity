import { PRIMITIVE_LABELS, PRIMITIVE_ORDER } from '@mp/content'
import type { Vec3 } from '@mp/core'

import type { Doc } from './editorDoc'
import type { MenuItem } from './menu'

/**
 * What the right-click menus offer (ADR 0025, ADR 0121).
 *
 * Declarative: every entry is a label, whether it is available, why not when it is not, and one call into a
 * subsystem that owns the work. Nothing here does anything itself, which is exactly why it had to be
 * extracted **after** the action clusters rather than before — built first, its host would have needed the
 * sixteen loose functions the menus called, and moving it would have gained nothing.
 *
 * The `why` strings are the reason this is worth a module. A disabled entry that says nothing is a dead end;
 * every one here explains itself, and most of them explain the same thing — that the node is part of a
 * prefab, so its place belongs to the shared definition.
 */

/** What the menus need: the document to ask, and the subsystems that do the work. */
export interface MenuHost {
  doc: () => Doc | null
  selection: () => readonly number[]
  hierarchy: { beginRename: (index: number) => void; setAllOpen: (open: boolean) => void }
  edits: () => {
    recordEdit: (label: string) => void
    clipboardSize: () => number
    copySelected: () => void
    cutSelected: () => void
    pasteClipboard: (asChild: boolean) => void
  }
  nodes: {
    deleteSelected: () => void
    duplicateSelected: () => void
    createEmpty: (parent: number | null, at?: Vec3) => void
    createPrimitive: (kind: (typeof PRIMITIVE_ORDER)[number], parent: number | null, at?: Vec3) => void
    focusSelection: () => void
    pasteAt: (point: Vec3) => void
  }
  prefabs: {
    openPrefabOf: (index: number) => void
    unlinkPlacement: (index: number) => void
    saveAsPrefab: (index: number) => Promise<void>
    revertOverride: (field?: string) => void
    applyOverrides: () => Promise<void>
  }
  /** Shared components the game has not opted into: picking one adds it to the game first (ADR 0077). */
  adoptable: () => readonly string[]
  adopt: (types: string[]) => Promise<void>
  scheduleRebuild: () => void
  inspectorRebuild: () => void
  uiChanged: () => void
}

export const createMenus = (host: MenuHost) => {
  /**
   * The Hierarchy's right-click menus.
   *
   * Almost every entry is a command that already existed and could only be reached from the keyboard or by a
   * gesture nobody discovers: rename was double-click only, Save as prefab and Open lived in the Inspector's header,
   * and delete on an inherited node did nothing at all with no explanation. The menu is where they become
   * findable, which is why every disabled entry carries a reason rather than being left out.
   */
  const menuFor = (index: number): MenuItem[] => {
    const open = host.doc()
    if (open === null) return []
    const inherited = open.kindOf(index) === 'inherited'
    const ref = open.refOf(index)
    const shared = ref === null ? 0 : open.refCount(ref)
    const own = !inherited
    const why = 'part of a prefab — its place belongs to the shared definition'
    return [
      { label: 'Rename', hint: 'double-click', run: () => host.hierarchy.beginRename(index) },
      {
        label: 'Add component',
        // The submenu the Inspector's Add Component button opens, reachable without going there first.
        items: [
          ...open.registry
            .all()
            .map((d) => d.type)
            .filter((type) => open.canAdd(index, type))
            .map((type) => ({
              label: type,
              run: () => {
                host.doc()?.addComponent(index, type)
                host.edits().recordEdit('add component')
                host.scheduleRebuild()
                host.inspectorRebuild()
                host.uiChanged()
              },
            })),
          // Shared components the game has not opted into: picking one adds it to the game first (ADR 0077).
          ...host.adoptable().map((type) => ({
            label: `${type} (adds to game)`,
            run: () => {
              void host.adopt([type]).then(() => {
                host.doc()?.addComponent(index, type)
                host.edits().recordEdit('add component')
                host.scheduleRebuild()
                host.inspectorRebuild()
                host.uiChanged()
              })
            },
          })),
        ],
      },
      { label: 'Create child', divider: true, enabled: own, why, items: createMenu(index) },
      { label: 'Duplicate', hint: 'Ctrl+D', enabled: own, why, run: () => host.nodes.duplicateSelected() },
      { label: 'Delete', hint: 'Del', enabled: own, why, run: () => host.nodes.deleteSelected() },
      { label: 'Copy', hint: 'Ctrl+C', divider: true, enabled: own, why, run: () => host.edits().copySelected() },
      { label: 'Cut', hint: 'Ctrl+X', enabled: own, why, run: () => host.edits().cutSelected() },
      { label: 'Paste as child', hint: 'Ctrl+Shift+V', enabled: own && host.edits().clipboardSize() > 0, why: own ? 'nothing copied' : why, run: () => host.edits().pasteClipboard(true) },
      {
        label: shared > 1 ? `Open prefab (${shared} placements)` : 'Open prefab',
        divider: true,
        enabled: ref !== null || inherited,
        why: 'not linked to a prefab',
        run: () => host.prefabs.openPrefabOf(index),
      },
      {
        label: 'Unlink from prefab',
        enabled: own && ref !== null,
        why: ref === null ? 'not a prefab placement' : inherited ? 'this is part of a prefab, not a placement of one' : why,
        run: () => host.prefabs.unlinkPlacement(index),
      },
      {
        label: 'Save as prefab…',
        enabled: own && ref === null && open.mode === 'level',
        why: ref !== null ? 'already a prefab' : open.mode === 'prefab' ? 'already inside a prefab' : why,
        run: () => void host.prefabs.saveAsPrefab(index),
      },
      { label: 'Revert to prefab', divider: true, enabled: inherited && open.overridesOf(index).length > 0, why: 'nothing overridden here', run: () => host.prefabs.revertOverride() },
      { label: 'Apply to prefab', enabled: inherited && open.overridesOf(index).length > 0, why: 'nothing overridden here', run: () => void host.prefabs.applyOverrides() },
    ]
  }

  /** What can be made: the built-in shapes at their preset sizes (ADR 0090), and an empty. */
  const createMenu = (parent: number | null, at?: Vec3): MenuItem[] => [
    ...PRIMITIVE_ORDER.map((kind) => ({ label: PRIMITIVE_LABELS[kind], run: () => host.nodes.createPrimitive(kind, parent, at) })),
    { label: 'Empty', divider: true, run: () => host.nodes.createEmpty(parent, at) },
  ]

  /** The blank-space menu: what you can make when you are not pointing at anything. */
  const blankMenu = (): MenuItem[] => [
    { label: 'Create', items: createMenu(null) },
    { label: 'Paste', hint: 'Ctrl+V', enabled: host.edits().clipboardSize() > 0, why: 'nothing copied', divider: true, run: () => host.edits().pasteClipboard(false) },
    { label: 'Expand all', divider: true, run: () => host.hierarchy.setAllOpen(true) },
    { label: 'Collapse all', run: () => host.hierarchy.setAllOpen(false) },
  ]

  /**
   * The viewport's right-click menu.
   *
   * On an object it is the Hierarchy's own list with Focus on top, because the same object should offer the same
   * things wherever it is right-clicked. On empty space it is what can be *made* at the point under the pointer.
   */
  const viewportMenu = (index: number | null, point: Vec3 | null): MenuItem[] => {
    if (index !== null) return [{ label: 'Focus', hint: 'F', run: () => host.nodes.focusSelection() }, ...menuFor(index).map((m, n) => (n === 0 ? { ...m, divider: true } : m))]
    return [
      { label: 'Paste here', enabled: host.edits().clipboardSize() > 0 && point !== null, why: host.edits().clipboardSize() === 0 ? 'nothing copied' : 'no surface under the pointer', run: () => point !== null && host.nodes.pasteAt(point) },
      { label: 'Create here', enabled: point !== null, why: 'no surface under the pointer', items: createMenu(null, point ?? undefined) },
      { label: 'Focus on the selection', divider: true, enabled: host.selection().length > 0, why: 'nothing selected', run: () => host.nodes.focusSelection() },
    ]
  }
  return {
    /** The menu for one node in the Hierarchy. */
    menuFor,
    /** The blank-space menu: what you can make when you are not pointing at anything. */
    blankMenu,
    /** The viewport's, which knows the world point that was clicked. */
    viewportMenu,
    /** What can be made: the built-in shapes at their preset sizes (ADR 0090), and an empty. */
    createMenu,
  }
}
