import { vec3, type Vec3 } from '@mp/core'
import { COLLIDER, LIGHT, MATERIAL_OVERRIDE, RENDERER, SEQUENCE, SPAWN, compileSequence, readStages, refPathOf, sequenceOf, unitColliderFor, type ColliderDesc } from '@mp/content'
import { sharedComponents, visibleParams, type AssetSpec, type ComponentRefSpec, type ParamSpec } from '@mp/components'
import { QUANT_BOUND } from '@mp/net'
import { DEFAULT_POSTFX, DEFAULT_SKY_PARAMS } from '@mp/render-three'

import type { ComponentView, Doc } from './editorDoc'
import type { ContextMenu, MenuItem } from './menu'

import {
  checkField,
  closePopover,
  colorField,
  colorFieldOf,
  fieldRow,
  numberScrub,
  openPopover,
  popoverOpenFor,
  scrubField,
  scrubFieldOf,
  segmented,
  selectField,
  textArea,
  textField,
  type Choice,
  type Live,
  type ScrubHandle,
  type ScrubSpec,
} from './controls'
import { cardJustDragged, pressCardToDrag } from './cardDrag'
import { icon, type IconName } from './icons'
import { refDropTarget, refField, refFieldAt, type RefDrag, type RefShown } from './refField'
import { folderTree, treePicker, type TreeItem } from './treePicker'
import { listField } from './listField'
import { byMenuFolder, menuFolderOf } from './componentMenu'
import { sequenceSummary } from './sequenceEdit'
import { sequenceEditor } from './sequenceEditor'
import { assetsRefusal, valuesRefusal, type Clip } from './componentClipboard'

/**
 * The Inspector panel: a card per component, with the fields inside each generated from that component's
 * declared parameters.
 *
 * Everything in it is ours (ADR 0152): the cards, the header's controls (ADR 0038), and every field — the
 * sequence editor's controls (`controls.ts`), so a number is dragged sideways or typed in the same way in every
 * card. Tweakpane drew the fields until then, a second visual language beside the sequence's; it is no longer in
 * the editor.
 *
 * What has to survive a rebuild — which cards are shut, where the panel was scrolled — is kept here.
 *
 * Holds no Three.js: the host reads and writes the selection's transform, so this file knows only about
 * documents and numbers.
 */
export interface TransformValues {
  position: Vec3
  /** Degrees — radians are the storage format, degrees are what a person types. */
  rotationDeg: Vec3
  scale: Vec3
}

export interface InspectorHost {
  doc: () => Doc | null
  /** Shared components the open level's game does not have yet, addable by adopting them (ADR 0077). */
  adoptable: () => readonly string[]
  /** Add a shared component to the game, rebuild the document, then resolve. */
  adopt: (type: string) => Promise<void>
  /** The open level's game, by its label: the folder its own components go in (ADR 0178). `null` for none. */
  gameLabel: () => string | null
  selected: () => number | null
  /**
   * The Environment row is selected instead of a node (ADR 0048). The panel then edits the level's sun, which
   * is a level setting rather than a component because the sun and the sky are one input (ADR 0046).
   */
  envSelected: () => boolean
  /** The Level row is picked (ADR 0162): the panel then edits the level's network bounds. */
  levelSelected: () => boolean
  /** The environment changed: rebake the sky and relight, since sun, ambient and sky move together. */
  onEnvironmentChanged: () => void
  /**
   * The header's active checkbox was clicked: switch the selected node and its subtree off, or back on
   * (ADR 0099/0102). Structural — what the level contains just changed.
   */
  onSetEnabled: (on: boolean) => void
  /** Whether the network-bounds box is currently drawn in the viewport (ADR 0093). */
  boundsBoxShown: () => boolean
  /** Turn the box on or off. It is off by default and never persists: it is a ruler, not scenery. */
  showBoundsBox: (on: boolean) => void
  /** Re-size the drawn box after the number changed, and mark the level edited. */
  onNetBoundsChanged: () => void
  /**
   * How much of the level sticks out of the bound, as `{ outside, reach }` — how many top-level objects have
   * any geometry beyond it, and the furthest metre anything reaches. `null` when nothing is loaded.
   *
   * This is the number that makes an authored bound safe: too small a box is visible here and in the
   * viewport, instead of being a peer who silently stops moving on someone else's screen (ADR 0092).
   */
  boundsReach: () => { outside: number; reach: number } | null
  /** How many objects are selected. The panel edits one and has to say so when there are more. */
  selectionCount: () => number
  /** Every selected index, primary last (ADR 0112). The panel edits what they have in common. */
  selectionIndices: () => readonly number[]
  /** The selection's current transform, or `null` if there isn't one. */
  readTransform: () => TransformValues | null
  /** Put these values on every selected object's transform, as one edit (ADR 0191: Paste Component Values). */
  pasteTransform: (v: TransformValues) => void
  writeTransform: (t: TransformValues) => void
  /**
   * Every selected node's transform, primary last. Empty when nothing is selected (ADR 0112).
   *
   * With more than one, an axis whose value differs is drawn **blank**, and each field writes its own axis to
   * every selected node.
   */
  selectionTransforms: () => readonly TransformValues[]
  /** Set one axis of one transform field on **every** selected node, as one undo entry (ADR 0112). */
  writeAxis: (field: 'position' | 'rotationDeg' | 'scale', axis: 'x' | 'y' | 'z', value: number) => void
  /**
   * A field is being dragged (ADR 0152): its writes go as it moves, so the viewport follows the pointer, and
   * are one history entry and one message to the room when `endDrag` comes — what a gizmo drag is. A remote
   * edit waits until then, as it does for the gizmo, since repainting would rebuild the panel under the pointer.
   */
  beginDrag: () => void
  endDrag: (label: string) => void
  /** Anything other than the transform changed — meshes and the physics world need rebuilding. */
  onPropsChanged: () => void
  /** The name changed — the hierarchy row shows it. */
  onRenamed: () => void
  /** A prefab's file name, by asset id, for the prefab bar; `null` when the asset list does not have it. */
  prefabName: (assetId: string) => string | null
  openPrefab: () => void
  /**
   * Assets of one kind to offer, as label → asset id; `''` for none.
   *
   * One accessor keyed by the kind the parameter declares, rather than one per kind: `AssetSpec['of']` is
   * the same list, so a new asset-valued parameter needs nothing here.
   */
  assetOptions: (of: AssetSpec['of'], dataType?: string) => Record<string, string>
  /**
   * The same assets, each with the folders it sits in as the Project window names them — `Keyboard`, `materials` —
   * and the built-in shapes in `Built-in`: a reference field's picker as a tree (ADR 0178).
   */
  assetFolders: (of: AssetSpec['of'], dataType?: string) => readonly { readonly id: string; readonly label: string; readonly folders: readonly string[] }[]
  /** A data type's name as a person reads it — `Keyboard Style` — from the open level's game (ADR 0181). */
  dataTypeLabel: (type: string) => string
  /** Why an asset cannot go in a field of that kind here, or `null` (ADR 0176): wrong kind, or not this game's. */
  assetRefusal: (of: AssetSpec['of'], id: string, dataType?: string) => string | null
  /** The assets a Project window drag carries right now, for a reference field (ADR 0176); empty when none. */
  draggedAssets: () => readonly string[]
  /** Flash a Hierarchy row, the selection left alone: where an object field points (ADR 0176). */
  pingNode: (index: number) => void
  /** Show an asset's tile in the Project window, the selection left alone (ADR 0176). */
  revealAsset: (id: string) => void
  /** Select an object: a reference field's double-click (ADR 0177). */
  selectNode: (index: number) => void
  /** Select an asset and show it: a reference field's double-click (ADR 0177). */
  openAsset: (id: string) => void
  /** Revert one override — `'transform'`, `'name'`, or a component id — or all of them. */
  revertOverride: (field?: string) => void
  /**
   * Turn this placement into a plain object, keeping what it draws (ADR 0111). The prefab file and every
   * other placement are untouched, and one Ctrl+Z puts the link back.
   */
  unlinkPrefab: () => void
  /** Push the selection's overrides into the shared prefab, so every placement of it follows. */
  applyOverrides: () => void
  /** The same two over a whole placement, from its root, which holds no override of its own (ADR 0122). */
  revertPlacement: (index: number) => void
  applyPlacementOverrides: (index: number) => Promise<void>
  /**
   * The editor's one context menu (`menu.ts`).
   *
   * Shared rather than built here, so a component's `⋯` and a right-click in the Hierarchy cannot both be open
   * at once, and so dismissal — Escape, a press elsewhere, a scroll, a resize — is written once.
   */
  menu: ContextMenu
  /**
   * The panel was rebuilt, so what the viewport draws for sequences may have changed: which move step is open,
   * or a point's numbers (ADR 0144).
   */
  pointsChanged: () => void
}

/** A move step open in the panel, whose point the viewport lets you drag (ADR 0144). */
export interface OpenPoint {
  /** The node the sequence is on. */
  readonly node: number
  readonly componentId: string
  readonly stepId: string
}

export interface Inspector {
  /** Selection changed, or the set of relevant fields did — rebuild the controls. */
  rebuild: () => void
  /** The gizmo moved the selection — refresh the numbers without rebuilding. */
  sync: () => void
  /**
   * The object shown changed elsewhere — a collaborator's edit (ADR 0168): its values follow in place, a field
   * being dragged or typed in keeping its own; the panel draws again only when what it is made of changed.
   */
  refresh: () => void
  /** Redraw just the name and the prefab bar (e.g. after Save as prefab changed the link). */
  renderHead: () => void
  /** The move step drawn open that was opened last, or `null` (ADR 0144). */
  openPoint: () => OpenPoint | null
}

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4

/** The transform section's key in the collapse set. Not a component id, so it cannot collide with one. */
const TRANSFORM = '@transform'

const AXES = ['x', 'y', 'z'] as const
type Axis = (typeof AXES)[number]

/**
 * Shapes offered for a `Collider`. **No cylinder**: the physics wrapper has no cylinder shape and the loader
 * throws on one, so offering it here would let the editor author a level that cannot load.
 */
const SHAPE_CHOICES: readonly Choice[] = ['box', 'ball', 'capsule', 'convex'].map((k) => ({ value: k, label: k }))

/** A fresh shape of a kind, for when the picker changes. Convex keeps whatever points it had, if any. */
const defaultShape = (kind: string, was: ColliderDesc): ColliderDesc => {
  switch (kind) {
    case 'ball':
      return { kind: 'ball', radius: 0.5 }
    case 'capsule':
      return { kind: 'capsule', halfHeight: 0.5, radius: 0.4 }
    case 'convex':
      return was.kind === 'convex' ? was : { kind: 'convex', points: [vec3(-0.5, 0, -0.5), vec3(0.5, 0, -0.5), vec3(0, 0, 0.5), vec3(0, 1, 0)] }
    default:
      return { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }
  }
}

/** The icon in a component's header. A game's own components, which the editor does not name, share one. */
const COMPONENT_ICONS: Readonly<Record<string, IconName>> = {
  [COLLIDER]: 'colliderOn',
  [RENDERER]: 'mesh',
  [MATERIAL_OVERRIDE]: 'material',
  [SPAWN]: 'spawn',
  [LIGHT]: 'light',
  [SEQUENCE]: 'motion',
  Hazard: 'hazard',
  Bumper: 'bumper',
  Death: 'death',
  Boss: 'boss',
}
export const componentIcon = (type: string): IconName => COMPONENT_ICONS[type] ?? 'component'

/** Why a reference field cannot take a row (`refTo` is `null`): one not in this document. Everything in it reaches (ADR 0219). */
const UNREACHABLE = 'that object is not in this document'

/**
 * The document's nodes as the Hierarchy lays them out, for a reference field's picker (ADR 0178): `offer(j)` says
 * what node `j` is there — its row, pickable or not, and anything listed under it before its children — and a
 * branch with nothing pickable anywhere in it is left out, so the tree holds only the way to what fits.
 */
const hierarchyTree = (doc: Doc, offer: (j: number) => { row: TreeItem; extra?: readonly TreeItem[] }): TreeItem[] =>
  doc.reading(() => {
    const kids = new Map<number | null, number[]>()
    for (let j = 0; j < doc.count(); j++) {
      const up = doc.parentOf(j)
      const list = kids.get(up) ?? []
      list.push(j)
      kids.set(up, list)
    }
    const build = (j: number): TreeItem | null => {
      const { row, extra = [] } = offer(j)
      const children = [...extra, ...(kids.get(j) ?? []).map(build).filter((x): x is TreeItem => x !== null)]
      if (!row.pickable && children.length === 0) return null
      return children.length === 0 ? row : { ...row, children }
    }
    return (kids.get(null) ?? []).map(build).filter((x): x is TreeItem => x !== null)
  })

/**
 * The values a component's fields are built from: declared defaults, the authored params over them, and
 * **nothing shared with the document** (ADR 0101).
 *
 * The deep copy was load-bearing when Tweakpane drew the fields: it wrote *into* a bound object, and on an
 * inherited component that object is the **prefab's own** (`bakeOverrides` hands back the prefab's objects
 * untouched where no override changed them, ADR 0033), so dragging a size on one placement edited the prefab
 * in memory. The fields now write new values, and the panel updates this copy as they do, so a second axis
 * dragged after a first starts from the first's new number — which still must not be the document's object.
 */
export const boundState = (defaults: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> =>
  structuredClone({ ...defaults, ...params })

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const vecOf = (v: unknown): Vec3 => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Partial<Record<Axis, unknown>>
  const n = (x: unknown): number => (typeof x === 'number' ? x : 0)
  return vec3(n(o.x), n(o.y), n(o.z))
}

/* --- editing several nodes at once (ADR 0112) --- */

/**
 * One component of one node, as a multi-edit target.
 *
 * `componentId` is that node's **own** id: ids are minted per component (`freshId`), so two cubes' colliders
 * are the same type and never the same id.
 */
export interface Peer {
  at: number
  componentId: string
  params: Record<string, unknown>
}

/** Value equality that copes with the vec3 and collider-shape objects a parameter can hold. */
export const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The same component on every selected node, or `null` when one of them has not got it.
 *
 * Matched by **type and ordinal** — the nth `Collider` lines up with the nth `Collider` — because ids cannot
 * line up and a node may legitimately carry two of the same type.
 *
 * `null` hides the section: a component only some of the selection has is not something they have in common,
 * and showing it would mean deciding what a write does to the ones without it (ADR 0112).
 */
export const peersOf = (doc: Doc, indices: readonly number[], at: number, view: ComponentView): Peer[] | null => {
  const ordinalOf = (i: number, id: string, type: string): number => {
    let n = 0
    for (const c of doc.components(i)) {
      if (c.id === id) return n
      if (c.type === type) n++
    }
    return -1
  }
  const ordinal = ordinalOf(at, view.id, view.type)
  if (ordinal < 0) return null
  const out: Peer[] = []
  for (const i of indices) {
    let n = 0
    let found: ComponentView | undefined
    for (const c of doc.components(i)) {
      if (c.type !== view.type) continue
      if (n === ordinal) {
        found = c
        break
      }
      n++
    }
    if (found === undefined) return null
    out.push({ at: i, componentId: found.id, params: found.params })
  }
  return out
}

export const createInspector = (head: HTMLElement, container: HTMLElement, host: InspectorHost): Inspector => {
  /**
   * What Copy Component last took (ADR 0191), in this tab only: it lives here, so a rebuild, another selection,
   * another level or a prefab opened on top keeps it. A copy rebuilds the panel, so every card's menu offers it.
   */
  let clip: Clip | null = null
  /** Open under a header button, which is where the pointer already is. */
  const openMenu = (at: HTMLElement, items: readonly MenuItem[], title?: string): void => {
    const rect = at.getBoundingClientRect()
    host.menu.open({ x: Math.round(rect.right), y: Math.round(rect.bottom + 2) }, items, title)
  }

  /**
   * The header is ours: Unity's name field is full-width and prominent, above everything it names.
   *
   * The active checkbox sits immediately left of the name (ADR 0102) — exactly a component card's header one
   * level up: a tick, then the thing it switches off. The Hierarchy still **dims** a switched-off row. That is
   * the feedback; this is where you change it.
   */
  const activeBox = checkField(true, (on) => host.onSetEnabled(on))

  const nameInput = el('input', 'txt name')
  nameInput.type = 'text'
  nameInput.spellcheck = false
  nameInput.title = 'name — blank falls back to what the object is'
  const commitName = (): void => {
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null) return
    doc.setName(at, nameInput.value.trim())
    host.onRenamed()
    renderHead() // the placeholder/value swap when a name is cleared
  }
  nameInput.addEventListener('change', commitName)
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur() // blur fires `change`
  })

  /**
   * The prefab bar (ADR 0152): on a placement or a piece of one, which prefab, how many placements this level
   * has of it, **Open**, and **Overrides ▾** — Revert, Apply and Unlink behind one button with the count on it.
   * A plain object has none: Save as prefab is the Hierarchy menu's, as are Duplicate and Delete.
   */
  const bar = el('div', 'ipre')
  const barIcon = el('span', 'ipre-i')
  const barWho = el('span', 'ipre-t')
  /** How many placements this level has, as the Hierarchy counts them: `×2`. Spelled out would not fit a thin panel. */
  const barCount = el('span', 'ipre-c')
  const openButton = el('button', 'ipre-b', 'Open')
  openButton.type = 'button'
  openButton.title = 'edit the shared definition — every placement follows'
  openButton.addEventListener('click', () => host.openPrefab())
  const oversButton = el('button', 'ipre-b')
  oversButton.type = 'button'
  bar.append(barIcon, barWho, barCount, openButton, oversButton)

  const multiNote = el('div', 'multi')
  /** Tick and name on one line, the way a component card's header reads. */
  const nameRow = el('div', 'namerow')
  nameRow.append(activeBox, nameInput)
  head.append(nameRow, bar, multiNote)

  /** The prefab a piece belongs to: the placement above it, named by its prefab's file. */
  const ownerName = (doc: Doc, at: number): string => {
    for (let j = doc.parentOf(at); j !== null; j = doc.parentOf(j)) {
      const ref = doc.refOf(j)
      if (doc.kindOf(j) === 'own' && ref !== null) return host.prefabName(ref) ?? doc.label(j)
    }
    return 'a prefab'
  }

  /**
   * What the Overrides button counts and offers. **Two scopes** (ADR 0122): on a placement it is every change
   * inside it — overrides on its pieces, objects it added (ADR 0130), pieces it does without (ADR 0133) — and
   * the actions reach all of them; on a piece it is that piece's own.
   */
  const overridesOf = (doc: Doc, at: number, placement: boolean): { count: number; summary: string; items: MenuItem[] } => {
    const why = 'matches the prefab'
    const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
    if (placement) {
      const changed = doc.placementOverrides(at)
      const added = doc.placementAdded(at)
      const gone = doc.placementRemoved(at)
      const fields = changed.reduce((n, o) => n + o.fields.length, 0)
      const count = fields + added.length + gone.length
      const parts = [
        fields === 0 ? '' : `${plural(fields, 'override')} on ${plural(changed.length, 'object')}`,
        added.length === 0 ? '' : plural(added.length, 'added object'),
        gone.length === 0 ? '' : plural(gone.length, 'removed piece'),
      ].filter((p) => p !== '')
      return {
        count,
        summary: count === 0 ? why : parts.join(', '),
        items: [
          { label: 'Revert all', enabled: count > 0, why, run: () => host.revertPlacement(at) },
          { label: 'Apply all', enabled: count > 0, why, run: () => void host.applyPlacementOverrides(at) },
          { label: 'Unlink from prefab', divider: true, run: () => host.unlinkPrefab() },
        ],
      }
    }
    const fields = doc.overridesOf(at)
    return {
      count: fields.length,
      summary: fields.length === 0 ? why : `${plural(fields.length, 'override')}: ${fields.join(', ')}`,
      items: [
        { label: 'Revert all', enabled: fields.length > 0, why, run: () => host.revertOverride() },
        { label: 'Apply', enabled: fields.length > 0, why, run: () => host.applyOverrides() },
      ],
    }
  }

  /** Name, prefab bar, and the multi-selection note. Separate from `rebuild` so renaming is cheap. */
  const renderHead = (): void => {
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null) {
      head.hidden = true
      return
    }
    head.hidden = false

    // Off because a parent is off cannot be fixed here, so the control is disabled and the title says why —
    // a checkbox that changes nothing visible is worse than one you cannot click.
    const offAbove = doc.disabledByAncestor(at)
    activeBox.checked = doc.nodeEnabled(at)
    activeBox.disabled = offAbove
    activeBox.title = offAbove ? 'a parent is switched off' : 'switched off objects and everything under them are not in the level'

    // Value = the typed name; placeholder = the fallback, so a clean file shows a sensible name without one
    // being written into the JSON.
    if (document.activeElement !== nameInput) nameInput.value = doc.nameOf(at)
    nameInput.placeholder = doc.label(at)

    const count = host.selectionCount()
    multiNote.hidden = count < 2
    // What the panel shows is what they have in common, and an edit reaches all of them (ADR 0112).
    multiNote.textContent = count < 2 ? '' : `${count} selected · editing what they share`

    const kind = doc.kindOf(at)
    const ref = doc.refOf(at)
    const placement = kind === 'own' && ref !== null
    bar.hidden = !placement && kind !== 'inherited'
    if (bar.hidden) return
    // A piece drawn as the Hierarchy draws it; a nested placement inside a prefab is a prefab like any other.
    bar.classList.toggle('piece', ref === null)
    barIcon.replaceChildren(icon(ref === null ? 'object' : 'prefab'))
    barCount.hidden = ref === null
    if (ref !== null) {
      const n = doc.refCount(ref)
      barWho.textContent = host.prefabName(ref) ?? 'prefab'
      barCount.textContent = `×${n}`
      barCount.title = `${n} placement${n === 1 ? '' : 's'} in this level`
    } else barWho.textContent = `part of ${ownerName(doc, at)}`
    barWho.title = barWho.textContent
    openButton.hidden = ref === null
    const o = overridesOf(doc, at, placement)
    oversButton.replaceChildren(el('span', undefined, 'Overrides'), ...(o.count > 0 ? [el('span', 'ipre-n', String(o.count))] : []), icon('chevron', 'ic ic-s'))
    oversButton.classList.toggle('on', o.count > 0)
    oversButton.title = o.summary
    oversButton.onclick = (e) => {
      e.stopPropagation()
      openMenu(oversButton, o.items, o.summary)
    }
  }

  /**
   * What the panel is made of, as the document has it now (ADR 0168): the object, its cards and their lines, and
   * every value that decides them — an enum gating other lines, a collider's kind, a sequence, each card's switch and
   * overrides, the built-in shape a model field holds; with several selected, all of their values. What a line only
   * shows — a number, a tick, a text, a colour, a vector, a collider's sizes, what a reference field points at
   * (ADR 0176) — is left out: a change to one is followed in place. `null` for no object, or the level's or the environment's panel, which draw again every time.
   */
  const shapeNow = (): string | null => {
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null || host.levelSelected() || host.envSelected()) return null
    const followed = new Set<string>(['number', 'bool', 'string', 'color', 'vec3', 'asset', 'nodeRef', 'componentRef', 'list'])
    return doc.reading(() => {
      const indices = host.selectionIndices()
      const cards = doc.components(at).map((view) => {
        const def = doc.registry.get(view.type)
        const state = boundState(doc.registry.defaults(view.type), view.params)
        const shown = def === undefined || view.type === SEQUENCE ? null : visibleParams(def.params, state)
        const deciding = (shown ?? [])
          .filter((k) => !followed.has(def?.params[k]?.kind ?? ''))
          .map((k) => [k, def?.params[k]?.kind === 'collider' ? (state[k] as { kind?: unknown } | undefined)?.kind : state[k]])
        const sequence = view.type === SEQUENCE ? [view.params, doc.sequenceOverrideOf(at, view.id) ?? null] : null
        const peers = indices.length > 1 ? (peersOf(doc, indices, at, view)?.map((p) => p.params) ?? null) : null
        return [view.id, view.type, view.enabled, view.added, view.inherited, view.overridden, shown, deciding, sequence, peers]
      })
      return JSON.stringify([at, indices, doc.kindOf(at), doc.refOf(at), doc.builtinOf(at), doc.overridesOf(at), cards])
    })
  }
  /** The shape the panel was drawn with, and each line's way of showing its value as it is now. */
  let drawnShape: string | null = null
  let followers: (() => void)[] = []

  let sel: TransformValues = { position: vec3(0, 0, 0), rotationDeg: vec3(0, 0, 0), scale: vec3(1, 1, 1) }
  /** The transform's nine fields when one object is selected — what `sync` refreshes as the gizmo moves it. */
  let transformFields: { key: keyof TransformValues; axis: Axis; field: ScrubHandle }[] = []

  const readSel = (): boolean => {
    const t = host.readTransform()
    if (t === null) return false
    sel = {
      position: vec3(r4(t.position.x), r4(t.position.y), r4(t.position.z)),
      rotationDeg: vec3(r4(t.rotationDeg.x), r4(t.rotationDeg.y), r4(t.rotationDeg.z)),
      scale: vec3(r4(t.scale.x), r4(t.scale.y), r4(t.scale.z)),
    }
    return true
  }

  /** Only the transform: nothing a gizmo does touches a component's values. A field being dragged or typed in keeps its own. */
  const sync = (): void => {
    if (!readSel()) return
    for (const f of transformFields) f.field.set(sel[f.key][f.axis])
  }

  const applyTransform = (): void => {
    host.writeTransform({
      position: sel.position,
      rotationDeg: sel.rotationDeg,
      // A zero scale collapses the collider and makes the shape unrecoverable by dragging.
      scale: vec3(sel.scale.x || 1e-3, sel.scale.y || 1e-3, sel.scale.z || 1e-3),
    })
  }

  /**
   * The history label of the field being dragged, while one is (ADR 0152). A drag writes as it goes and is one
   * entry when it lets go; a rebuild in between closes it, since the field it belonged to is gone.
   */
  let dragLabel: string | null = null
  const endFieldDrag = (): void => {
    if (dragLabel === null) return
    const label = dragLabel
    dragLabel = null
    host.endDrag(label)
  }

  /**
   * A field's writes, live: each move of a drag writes, so the level follows the pointer, inside one history
   * entry; the commit that follows the drag is then nothing, the value being written already. A typed value is
   * the commit alone.
   */
  const liveWrite = <T>(history: string, write: (v: T) => void): { live: Live<T>; commit: (v: T) => void } => ({
    live: {
      start: () => {
        endFieldDrag()
        dragLabel = history
        host.beginDrag()
      },
      move: write,
      end: () => {
        endFieldDrag()
        renderHead()
      },
    },
    commit: (v) => {
      if (dragLabel === null) write(v)
    },
  })

  /** A number field. It writes as it is dragged unless `live` is `false` — a value saved to a file on each write. */
  const numberField = (o: {
    readonly value: number | null
    readonly spec: ScrubSpec
    readonly title: string
    readonly history: string
    readonly write: (v: number) => void
    readonly axis?: Axis
    readonly unit?: string
    readonly live?: boolean
  }): ScrubHandle => {
    const w = liveWrite(o.history, o.write)
    return scrubFieldOf({
      value: o.value,
      spec: o.spec,
      title: o.title,
      commit: w.commit,
      ...(o.axis === undefined ? {} : { axis: o.axis, label: o.axis.toUpperCase() }),
      ...(o.unit === undefined ? {} : { unit: o.unit }),
      ...(o.live === false ? {} : { live: w.live }),
    })
  }

  /** A change a person made to a component. The prefab bar's count follows, once a drag has let go. */
  const edited = (write: () => void): void => {
    write()
    host.onPropsChanged()
    if (dragLabel === null) renderHead()
  }

  /**
   * Rebuild, keeping the scroll position — every rebuild used to jump the panel back to the top, and a rebuild
   * happens on every enum change.
   *
   * The scroller is the panel's body, not our container: `#inspector` is a plain block inside it, and making it
   * a second scroller would nest two.
   */
  const scroller = (): HTMLElement => container.closest('.panel-body') ?? container
  const rebuildKeepingScroll = (): void => {
    const at = scroller()
    const top = at.scrollTop
    rebuild()
    at.scrollTop = top
  }

  /**
   * Which cards are shut, and it survives rebuilds *and* selections: somebody who collapses `Collider`
   * because they are working on one component means it for the session, not until the next dropdown change.
   *
   * Keyed by component id rather than by type, so two colliders on one node collapse independently.
   */
  const shut = new Set<string>()

  /** A card's body, and how lines get into it. */
  interface Section {
    readonly root: HTMLElement
    /** What a card is dragged by, when it can be (`cardDrag.ts`). */
    readonly header: HTMLElement
    /** A labelled line holding controls. */
    readonly field: (label: string, ...controls: HTMLElement[]) => HTMLElement
    /** A read-only line: a label and a value, or — with no label — a note across the card. */
    readonly row: (label: string, value: string) => HTMLElement
    /** Something of our own that is not a line: the sequence editor, a curve. */
    readonly append: (node: HTMLElement) => void
  }

  /**
   * One card (ADR 0152), shaped like a sequence's stage cards. Its header is a row of small controls rather
   * than a title string (ADR 0038): twist, enable, icon, name, badge, the component's own tools, ⋯. A click on
   * the header's empty part opens or shuts it too. A component with nothing to edit is its header alone, and
   * the Transform is always open. Neither has a twist; its place is kept, so the headers line up down the panel.
   */
  const addSection = (
    key: string,
    opts: {
      title: string
      icon?: IconName
      badge?: string
      off?: boolean
      enable?: (on: boolean) => void
      menu?: readonly MenuItem[]
      /** Dim text after the title, for what a component amounts to at a glance (a sequence's settings and length). */
      summary?: string
      /** A warning sign in the header, with the reason on hover — so a problem shows with the section closed. */
      warn?: string
      /** Buttons of the component's own, between the header's text and its ⋯. */
      tools?: readonly HTMLElement[]
      /** Nothing to edit: no body and nothing to open. */
      empty?: boolean
      /** Always open: the Transform. */
      fixed?: boolean
      /**
       * What every tab calls this card, for who is in which field (ADR 0160); the key when it says nothing. A
       * component's id is its own node's, so it is named by type and ordinal instead — as the selection matches it.
       */
      card?: string
    },
  ): Section => {
    const root = el('div', 'isec')
    root.dataset.card = opts.card ?? key
    const header = el('div', 'isec-h')
    const shuts = opts.empty !== true && opts.fixed !== true
    const collapsed = shuts && shut.has(key)
    root.classList.toggle('shut', collapsed)
    root.classList.toggle('isec-bare', opts.empty === true)
    root.classList.toggle('isec-fixed', opts.fixed === true)

    const toggle = (): void => {
      if (!shuts) return
      if (shut.has(key)) shut.delete(key)
      else shut.add(key)
      rebuildKeepingScroll()
    }
    const twist = el('button', 'isec-tw')
    twist.type = 'button'
    twist.append(icon('chevron'))
    twist.title = collapsed ? 'expand' : 'collapse'
    header.append(twist)
    header.addEventListener('click', (e) => {
      // The click a drag ends with is the drop, not a click.
      if (cardJustDragged()) return
      const control = (e.target as Element).closest('button, input, select')
      if (control === null || control === twist) toggle()
    })

    if (opts.enable !== undefined) {
      const box = checkField(opts.off !== true, (on) => opts.enable?.(on), 'enabled — an off component is skipped by the loader and by the runtime')
      box.classList.add('isec-en')
      header.append(box)
    }
    if (opts.icon !== undefined) header.append(icon(opts.icon, 'ic isec-i'))

    header.append(el('span', 'isec-t', opts.title))
    if (opts.summary !== undefined && opts.summary !== '') header.append(el('span', 'isec-sum', opts.summary))
    if (opts.badge !== undefined && opts.badge !== '') header.append(el('span', 'isec-badge', opts.badge))
    if (opts.warn !== undefined) {
      const w = el('span', 'isec-warn')
      w.append(icon('warn'))
      w.title = opts.warn
      header.append(w)
    }
    for (const tool of opts.tools ?? []) header.append(tool)

    if (opts.menu !== undefined && opts.menu.length > 0) {
      const dots = el('button', 'isec-m')
      dots.type = 'button'
      dots.append(icon('more'))
      dots.title = 'more'
      const items = opts.menu
      dots.addEventListener('click', (e) => {
        e.stopPropagation()
        openMenu(dots, items, opts.title)
      })
      header.append(dots)
      // Unity's: a right-click on a component's header is its menu, where the pointer is (ADR 0191).
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        host.menu.open({ x: e.clientX, y: e.clientY }, items, opts.title)
      })
    }

    root.append(header)
    root.classList.toggle('off', opts.off === true)
    const body = el('div', 'isec-body')
    body.hidden = collapsed || opts.empty === true
    root.append(body)
    container.append(root)

    const field = (label: string, ...controls: HTMLElement[]): HTMLElement => {
      const line = fieldRow(label, ...controls)
      body.append(line)
      return line
    }
    const row = (label: string, value: string): HTMLElement => {
      if (label === '') {
        const note = el('div', 'inote', value)
        body.append(note)
        return note
      }
      const line = el('div', 'irow')
      line.append(el('span', 'irow-l', label), el('span', 'irow-v', value))
      body.append(line)
      return line
    }
    return { root, header, field, row, append: (node) => body.append(node) }
  }

  /**
   * One control per declared parameter.
   *
   * `state` is the component's values, completed with the declaration's defaults so a parameter added to a
   * component still has something to show in a level authored before it existed.
   *
   * With several selected (ADR 0112), a value they disagree about is drawn **blank** rather than showing the
   * primary's as if it spoke for all of them, and writing it sets it on all of them. A compound value — a
   * collider shape, a node reference — is reported rather than offered: picking one for several objects
   * belongs to a field of its own.
   */
  const addParam = (
    section: Section,
    doc: Doc,
    at: number,
    view: ComponentView,
    state: Record<string, unknown>,
    key: string,
    spec: ParamSpec,
    peers: readonly Peer[] | null,
  ): void => {
    const label = spec.label ?? key
    /**
     * One write reaches every selected node (ADR 0112) — `setParamsAcross` is one commit, so it stays one
     * undo entry and one message to the room. With one node selected `peers` is `null` and nothing changes.
     */
    const write = (patch: Record<string, unknown>): void =>
      edited(() => (peers === null ? doc.setParams(at, view.id, patch) : doc.setParamsAcross(peers, patch)))

    // The declaration's default stands in for a node that has no value written, as the state does for one.
    const fallback = doc.registry.defaults(view.type)[key]
    const valueOf = (p: Peer): unknown => p.params[key] ?? fallback
    const mixed = peers !== null && peers.length > 1 && !peers.every((pp) => sameValue(valueOf(pp), valueOf(peers[0]!)))
    /** A line for this parameter; an overridden one gets a bar down its left edge — Unity's cue. */
    const line = (...controls: HTMLElement[]): HTMLElement => {
      const l = section.field(label, ...controls)
      if (view.overridden.includes(key)) l.classList.add('over')
      if (mixed) l.classList.add('mixed')
      return l
    }
    const differs = (): void => {
      section.row(label, 'differs across the selection').classList.add('mixed')
    }
    /**
     * Show the value as it is now when it changes elsewhere (`refresh`, ADR 0168) — one object selected; with
     * several, any change draws the panel again. The controls' own `set` leaves one being dragged or typed in.
     */
    const now = (): unknown => doc.components(at).find((c) => c.id === view.id)?.params[key] ?? fallback
    const follow = (show: (v: unknown) => void): void => {
      if (peers === null) followers.push(() => show(now()))
    }
    const idle = (control: HTMLElement): boolean => !control.contains(document.activeElement)
    /** How a reference field names node `j`, which `ref` points at: by its placement too when it points into one (ADR 0219). */
    const refLabel = (ref: string, j: number): string => {
      const path = refPathOf(ref)
      const placement = path === null ? null : doc.refTarget(at, path.placement)
      return placement === null ? doc.label(j) : `${doc.label(placement)} › ${doc.label(j)}`
    }

    /**
     * A component field (ADR 0177): Unity's field typed by a component. It shows `Zone (Collider)` — the ordinal too
     * where the object has several — and takes an Inspector card of its type by the header, or a Hierarchy row, whose
     * first component of the type it takes, as Unity's does. The reach is an object field's. One control for a
     * parameter and for a list's reference column (ADR 0222): `current` is what it holds, `store` writes a value, and
     * `twin` names an earlier row holding the same reference, shown as a warning.
     */
    const componentRefControl = (
      spec: ComponentRefSpec,
      title: string,
      current: () => unknown,
      store: (v: { node: string; component: string } | null) => void,
      twin?: () => number | null,
    ): { root: HTMLElement; show: (v: unknown) => void; refuse: (drag: RefDrag) => string | null; valueFor: (drag: RefDrag) => { node: string; component: string } | null } => {
      const typeLabel = doc.registry.get(spec.of)?.label ?? spec.of
      const glyph = componentIcon(spec.of)
      const ofType = (j: number): ComponentView[] => doc.components(j).filter((c) => c.type === spec.of)
      /** A component's name in the field: its object's, and the ordinal where the object has more than one. */
      const named = (j: number, id: string, node?: string): string => {
        const all = ofType(j)
        const n = all.findIndex((c) => c.id === id)
        return `${node === undefined ? doc.label(j) : refLabel(node, j)} (${typeLabel}${all.length > 1 ? ` ${n + 1}` : ''})`
      }
      /** Where it points: the node's index and the component, the old shape — a bare node id — read as its first. */
      const resolve = (v: unknown): { j: number; id: string; node: string } | null | 'missing' => {
        const ref: unknown = typeof v === 'string' ? { node: v, component: '' } : v
        if (typeof ref !== 'object' || ref === null) return null
        const { node, component } = ref as { node?: unknown; component?: unknown }
        if (typeof node !== 'string' || typeof component !== 'string') return null
        const j = doc.refTarget(at, node)
        const c = j === null ? undefined : component === '' ? ofType(j)[0] : ofType(j).find((x) => x.id === component)
        return j === null || c === undefined ? 'missing' : { j, id: c.id, node }
      }
      const shownFor = (v: unknown): RefShown => {
        const r = resolve(v)
        if (r === null) return null
        if (r === 'missing') return { label: `missing ${typeLabel}`, icon: 'warn', missing: true }
        const also = twin?.() ?? null
        return also === null ? { label: named(r.j, r.id, r.node), icon: glyph } : { label: `${named(r.j, r.id, r.node)} · also row ${also + 1}`, icon: 'warn', missing: true }
      }
      // Written, then shown as written, as an object field's is.
      const put = (v: { node: string; component: string } | null): void => {
        store(v)
        field.set(shownFor(current()))
      }
      /**
       * The picker's tree (ADR 0178): the Hierarchy's, keyed `<index>/<component id>`. An object in reach with one
       * of the type is itself the row to pick; one with several lists them under it, before its children.
       */
      const tree = (): TreeItem[] =>
        hierarchyTree(doc, (j) => {
          const found = doc.refTo(at, j) === null ? [] : ofType(j)
          const only = found.length === 1 ? found[0] : undefined
          const row: TreeItem =
            only !== undefined
              ? { key: `${j}/${only.id}`, label: named(j, only.id), icon: glyph, pickable: true }
              : { key: `node:${j}`, label: doc.label(j), icon: doc.refOf(j) === null ? 'object' : 'prefab', pickable: false }
          return found.length > 1 ? { row, extra: found.map((c) => ({ key: `${j}/${c.id}`, label: named(j, c.id), icon: glyph, pickable: true })) } : { row }
        })
      const refuse = (drag: RefDrag): string | null => {
        if (drag.kind === 'asset') return `this takes a ${typeLabel}, not an asset`
        if (drag.kind === 'component') {
          const c = doc.components(drag.index).find((x) => x.id === drag.component)
          if (c !== undefined && c.type !== spec.of) return `this takes a ${typeLabel}, not a ${doc.registry.get(c.type)?.label ?? c.type}`
        } else if (ofType(drag.index).length === 0) return `${doc.label(drag.index)} has no ${typeLabel}`
        return doc.refTo(at, drag.index) === null ? UNREACHABLE : null
      }
      /** What a drag `refuse` let through stores: a row gives its first of the type, as Unity's does; a card, itself. */
      const valueFor = (drag: RefDrag): { node: string; component: string } | null => {
        if (drag.kind === 'asset') return null
        const node = doc.refTo(at, drag.index)
        const component = drag.kind === 'component' ? drag.component : ofType(drag.index)[0]?.id
        return node === null || component === undefined ? null : { node, component }
      }
      const field = refField({
        shown: shownFor(current()),
        none: `None (${typeLabel})`,
        title,
        choices: tree,
        current: () => {
          const r = resolve(current())
          return r === null || r === 'missing' ? null : `${r.j}/${r.id}`
        },
        pick: (v) => {
          if (v === null) return put(null)
          const cut = v.indexOf('/')
          const node = doc.refTo(at, Number(v.slice(0, cut)))
          if (node !== null) put({ node, component: v.slice(cut + 1) })
        },
        ping: () => {
          const r = resolve(current())
          if (r !== null && r !== 'missing') host.pingNode(r.j)
        },
        open: () => {
          const r = resolve(current())
          if (r !== null && r !== 'missing') host.selectNode(r.j)
        },
        refuse,
        take: (drag) => {
          const v = valueFor(drag)
          if (v !== null) put(v)
        },
        draggedAssets: host.draggedAssets,
      })
      return { root: field.root, show: (v) => field.set(shownFor(v)), refuse, valueFor }
    }

    switch (spec.kind) {
      case 'number': {
        const v = state[key]
        const field = numberField({
          value: mixed ? null : typeof v === 'number' ? v : spec.default,
          spec: numberScrub(spec),
          title: label,
          history: label,
          write: (n) => write({ [key]: n }),
        })
        line(field.root)
        follow((n) => field.set(typeof n === 'number' ? n : spec.default))
        return
      }
      case 'bool': {
        const box = checkField(mixed ? null : state[key] === true, (on) => write({ [key]: on }), label)
        line(box)
        // A tick has nothing half-typed to keep, and keeps the focus after a click: always shown.
        follow((on) => void (box.checked = on === true))
        return
      }
      case 'string': {
        const make = spec.multiline === true ? textArea : textField
        const input = make(mixed ? null : String(state[key] ?? ''), (s) => write({ [key]: s }), { title: label })
        line(input)
        follow((s) => void (idle(input) && (input.value = String(s ?? ''))))
        return
      }
      case 'color': {
        const w = liveWrite<string>(label, (c) => write({ [key]: c }))
        const field = colorFieldOf(mixed ? null : String(state[key] ?? spec.default), w.commit, mixed ? undefined : w.live)
        line(field.root)
        follow((c) => field.set(String(c ?? spec.default)))
        return
      }
      case 'enum':
        line(
          selectField(
            spec.options.map((o) => ({ value: o, label: o })),
            mixed ? null : String(state[key]),
            (v) => {
              write({ [key]: v })
              // An enum can gate other parameters (`when`), so the set of lines may have changed.
              rebuildKeepingScroll()
            },
            label,
          ),
        )
        return
      case 'vec3': {
        /**
         * Per axis: one may agree while the others do not. Each node keeps its own value on the axes not
         * written — a patch replaces a parameter whole, so each gets its own (`setParamsAcross` with a
         * function), and the local copies follow each write so the next axis starts from it.
         */
        const own = vecOf(state[key])
        const theirs = (peers ?? []).map((p) => vecOf(valueOf(p)))
        const agreed = (axis: Axis): number | null => (theirs.every((t) => t[axis] === theirs[0]![axis]) ? (theirs[0]?.[axis] ?? own[axis]) : null)
        const writeAxis = (axis: Axis, v: number): void => {
          if (peers === null) {
            own[axis] = v
            state[key] = { ...own }
            write({ [key]: { ...own } })
            return
          }
          theirs.forEach((t) => (t[axis] = v))
          edited(() => doc.setParamsAcross(peers, (p) => ({ [key]: { ...theirs[peers.indexOf(p)]! } })))
        }
        const axes = AXES.map((axis) =>
          numberField({
            value: peers === null ? own[axis] : agreed(axis),
            spec: numberScrub({ step: 0.1 }),
            title: `${label} ${axis}`,
            history: label,
            axis,
            write: (v) => writeAxis(axis, v),
          }),
        )
        line(...axes.map((a) => a.root))
        // Its own copy follows too, so the next axis written starts from the others' values as they are now.
        follow((v) => {
          const next = vecOf(v)
          AXES.forEach((axis, n) => {
            own[axis] = next[axis]
            axes[n]!.set(next[axis])
          })
        })
        return
      }
      case 'asset': {
        /**
         * A reference field (ADR 0176, ADR 0177): the asset's name, a picker, and a tile dropped from the Project
         * window. The names are the picker's own, so a built-in shape (ADR 0090) reads as it does there.
         */
        const glyph = (id: string): IconName => (id.startsWith('builtin:') ? 'object' : spec.of === 'model' ? 'mesh' : spec.of === 'data' ? 'data' : 'material')
        // A data field takes one type, by name (ADR 0181).
        const kindName = spec.of === 'model' ? 'Model' : spec.of === 'data' ? host.dataTypeLabel(spec.dataType ?? 'Data') : 'Material'
        const shownFor = (v: unknown): RefShown => {
          if (typeof v !== 'string' || v === '') return null
          const options = host.assetOptions(spec.of, spec.dataType)
          const name = Object.keys(options).find((k) => options[k] === v)
          return name === undefined ? { label: `missing ${kindName}`, icon: 'warn', missing: true } : { label: name, icon: glyph(v) }
        }
        const set = (v: string): void => {
          write({ [key]: v })
          // A built-in shape picked or dropped changes what the Collider card shows (ADR 0090).
          rebuildKeepingScroll()
        }
        const field = refField({
          shown: mixed ? 'mixed' : shownFor(state[key]),
          none: `None (${kindName})`,
          title: label,
          choices: () => folderTree(host.assetFolders(spec.of, spec.dataType).map((a) => ({ key: a.id, label: a.label, icon: glyph(a.id), folders: a.folders }))),
          current: () => {
            const v = now()
            return typeof v === 'string' && v !== '' ? v : null
          },
          pick: (v) => set(v ?? ''),
          ping: () => {
            const v = now()
            if (typeof v === 'string' && v !== '' && !v.startsWith('builtin:')) host.revealAsset(v)
          },
          open: () => {
            const v = now()
            if (typeof v === 'string' && v !== '' && !v.startsWith('builtin:')) host.openAsset(v)
          },
          refuse: (drag) =>
            drag.kind === 'asset' ? host.assetRefusal(spec.of, drag.id, spec.dataType) : `this takes a ${kindName}, not ${drag.kind === 'node' ? 'an object' : 'a component'}`,
          take: (drag) => {
            if (drag.kind === 'asset') set(drag.id)
          },
          draggedAssets: host.draggedAssets,
        })
        line(field.root)
        follow((v) => field.set(shownFor(v)))
        return
      }
      case 'collider': {
        // A node drawing a built-in shape (ADR 0090): the collider is the unit shape and the scale is the size.
        const builtin = doc.builtinOf(at)
        if (builtin !== null) {
          section.row(label, `unit ${unitColliderFor(builtin).kind} · size is the object's scale`)
          return
        }
        if (mixed) return differs()
        const shape = (state[key] ?? spec.default) as ColliderDesc
        line(
          selectField(SHAPE_CHOICES, shape.kind, (kind) => {
            write({ [key]: defaultShape(kind, shape) })
            rebuildKeepingScroll()
          }),
        )
        const size = (name: string, value: number, put: (v: number) => void): ScrubHandle => {
          const field = numberField({ value, spec: numberScrub({ step: 0.05, min: 0.01 }), title: name, history: name, write: put })
          section.field(name, field.root)
          return field
        }
        // The shape's kind is in the panel's shape: a change of kind draws again, so these follow sizes only.
        if (shape.kind === 'box') {
          const half = vecOf(shape.halfExtents)
          const axes = AXES.map((axis) =>
            numberField({
              value: half[axis],
              spec: numberScrub({ step: 0.05 }),
              title: `half extents ${axis}`,
              history: 'half extents',
              axis,
              write: (v) => {
                half[axis] = v
                write({ [key]: { kind: 'box', halfExtents: { ...half } } })
              },
            }),
          )
          section.field('half extents', ...axes.map((a) => a.root))
          follow((v) => {
            const next = vecOf((v as { halfExtents?: unknown } | undefined)?.halfExtents)
            AXES.forEach((axis, n) => {
              half[axis] = next[axis]
              axes[n]!.set(next[axis])
            })
          })
        } else if (shape.kind === 'ball') {
          const radius = size('radius', shape.radius, (v) => write({ [key]: { kind: 'ball', radius: v } }))
          follow((v) => {
            const r = (v as { radius?: unknown } | undefined)?.radius
            if (typeof r === 'number') radius.set(r)
          })
        } else if (shape.kind === 'capsule' || shape.kind === 'cylinder') {
          const dims = { kind: shape.kind, halfHeight: shape.halfHeight, radius: shape.radius }
          const height = size('half height', dims.halfHeight, (v) => {
            dims.halfHeight = v
            write({ [key]: { ...dims } })
          })
          const radius = size('radius', dims.radius, (v) => {
            dims.radius = v
            write({ [key]: { ...dims } })
          })
          follow((v) => {
            const s = (v ?? {}) as { halfHeight?: unknown; radius?: unknown }
            if (typeof s.halfHeight === 'number') height.set((dims.halfHeight = s.halfHeight))
            if (typeof s.radius === 'number') radius.set((dims.radius = s.radius))
          })
        } else {
          // A hull is authored by whatever generated it (ADR 0017); there is no useful field for a point cloud,
          // so this states what is there and leaves it alone.
          section.row('hull', `${shape.points.length} points`)
        }
        return
      }
      case 'nodeRef': {
        /**
         * A reference field (ADR 0176): the object's name — a press pings its row — a picker of the nodes this one
         * may name, and a Hierarchy row dropped on it, or a card, which names its object as Unity's does. The reach
         * is `nodeChoices`' (`refTo` for a drop), which refuses anything that would author a dangling reference.
         * The schema's none is `null`.
         */
        if (mixed) return differs()
        const target = (): number | null => {
          const v = now()
          return typeof v === 'string' ? doc.refTarget(at, v) : null
        }
        const shownFor = (v: unknown): RefShown => {
          if (typeof v !== 'string') return null
          const j = doc.refTarget(at, v)
          return j === null ? { label: `missing · ${v.slice(0, 6)}`, icon: 'warn', missing: true } : { label: refLabel(v, j), icon: doc.refOf(j) === null ? 'object' : 'prefab' }
        }
        // Written, then shown as written: nothing redraws a field for this tab's own edit — the room's refresh is for
        // everyone else's — so it showed None until a reload.
        const store = (v: string | null): void => {
          write({ [key]: v })
          field.set(shownFor(now()))
        }
        const field = refField({
          shown: shownFor(state[key]),
          none: 'None (Object)',
          title: label,
          // The Hierarchy's tree, what this node may name pickable (`refTo`): by index, so a key is a row.
          choices: () =>
            hierarchyTree(doc, (j) => ({
              row: { key: String(j), label: doc.label(j), icon: doc.refOf(j) === null ? 'object' : 'prefab', pickable: doc.refTo(at, j) !== null },
            })),
          current: () => {
            const j = target()
            return j === null ? null : String(j)
          },
          pick: (v) => store(v === null ? null : doc.refTo(at, Number(v))),
          ping: () => {
            const j = target()
            if (j !== null) host.pingNode(j)
          },
          open: () => {
            const j = target()
            if (j !== null) host.selectNode(j)
          },
          refuse: (drag) => (drag.kind === 'asset' ? 'this takes an object, not an asset' : doc.refTo(at, drag.index) === null ? UNREACHABLE : null),
          take: (drag) => {
            const id = drag.kind === 'asset' ? null : doc.refTo(at, drag.index)
            if (id !== null) store(id)
          },
          draggedAssets: host.draggedAssets,
        })
        line(field.root)
        follow((v) => field.set(shownFor(v)))
        return
      }
      case 'componentRef': {
        // A component field (ADR 0177); its control is shared with a list's reference column (ADR 0222).
        if (mixed) return differs()
        const control = componentRefControl(spec, label, now, (v) => write({ [key]: v }))
        line(control.root)
        follow((v) => control.show(v))
        return
      }
      case 'list': {
        // Rows (ADR 0182): every edit is the whole list; a row's number or colour writes when it lets go.
        if (mixed) return differs()
        const rowsOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
        // A reference column (ADR 0222): a component field per row, warning on a row holding what an earlier one does.
        const same = (a: unknown, b: unknown): boolean =>
          typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && (a as { node?: unknown }).node === (b as { node?: unknown }).node && (a as { component?: unknown }).component === (b as { component?: unknown }).component
        const refColumn = Object.entries(spec.item).find(([, s]) => s.kind === 'componentRef') as [string, ComponentRefSpec] | undefined
        const field = listField({
          item: spec.item,
          value: rowsOf(state[key]),
          title: label,
          write: (rows, ongoing) => {
            if (ongoing !== true) write({ [key]: rows })
          },
          settle: () => undefined,
          cellFor: (n, column, cellSpec, value, put, rows) => {
            if (cellSpec.kind !== 'componentRef') return null
            const twin = (): number | null => {
              const k = rows.findIndex((r, i) => i < n && value !== null && same(r[column], value))
              return k < 0 ? null : k
            }
            return componentRefControl(cellSpec, cellSpec.label ?? column, () => value, put, twin).root
          },
          // A Hierarchy row or a card dropped on **Add** is a new row holding it (ADR 0222).
          ...(refColumn === undefined
            ? {}
            : {
                onAddButton: (add: HTMLElement, append: (row: Record<string, unknown>) => void) => {
                  const control = componentRefControl(refColumn[1], refColumn[1].label ?? refColumn[0], () => null, () => undefined)
                  refDropTarget(add, {
                    refuse: control.refuse,
                    take: (drag) => {
                      const v = control.valueFor(drag)
                      if (v !== null) append({ [refColumn[0]]: v })
                    },
                  })
                },
              }),
        })
        line(field.root)
        follow((v) => field.set(rowsOf(v)))
        return
      }
      case 'stages': {
        // Stages are drawn as cards where they are a `Sequence`'s (ADR 0147); anywhere else, a summary.
        if (mixed) return differs()
        const stages = Array.isArray(state[key]) ? (state[key] as readonly { steps?: readonly unknown[] }[]) : []
        const steps = stages.reduce((n, s) => n + (s.steps?.length ?? 0), 0)
        section.row(label, `${stages.length} stage${stages.length === 1 ? '' : 's'} · ${steps} step${steps === 1 ? '' : 's'}`)
        return
      }
      default: {
        /**
         * Exhaustiveness guard. A parameter kind with no case here renders **nothing** — the field simply is
         * not there, with no error anywhere, which is exactly how `color` shipped invisible. Now adding a kind
         * to `ParamSpec` fails typecheck until this switch handles it.
         */
        const unhandled: never = spec
        throw new Error(`inspector: no field for parameter kind ${JSON.stringify(unhandled)}`)
      }
    }
  }

  const moveAndRebuild = (doc: Doc, at: number, componentId: string, delta: number): void => {
    doc.moveComponent(at, componentId, delta)
    host.onPropsChanged()
    rebuildKeepingScroll()
  }

  /**
   * The sequence whose ⚙ popover is open, by component id (ADR 0147). An edit in it rebuilds the panel, which
   * takes the popover with it, so the new header opens it again; a press elsewhere or Escape forgets it.
   */
  let settingsOpen: string | null = null
  /** Which of a sequence's steps are open, by step id — kept across the rebuild every edit causes. */
  const openSteps = new Set<string>()
  /**
   * The move steps this build drew open, in a section that is itself open. The viewport edits the one opened
   * last (ADR 0144): `openSteps` keeps the order they were opened in.
   */
  let shownMoves: OpenPoint[] = []
  const openPoint = (): OpenPoint | null => {
    let last: OpenPoint | null = null
    for (const id of openSteps) last = shownMoves.find((m) => m.stepId === id) ?? last
    return last
  }

  /** A step or stage id, minted the way every other id in the editor is: four random bytes, hex. */
  const freshId = (): string => {
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** One of a setting's two values: what it is called, and how the header draws it. */
  interface Toggle {
    readonly value: string
    readonly icon: IconName
    readonly label: string
  }
  /** The three settings the header shows as icons, each first choice its default. */
  const SEQUENCE_TOGGLES: readonly { readonly key: 'clock' | 'loop' | 'axes'; readonly choices: readonly [Toggle, Toggle] }[] = [
    {
      key: 'clock',
      choices: [
        { value: 'shared', icon: 'shared', label: 'Shared clock: the same on every screen' },
        { value: 'local', icon: 'local', label: 'Local clock: this screen’s own' },
      ],
    },
    {
      key: 'loop',
      choices: [
        { value: 'restart', icon: 'restart', label: 'Restart: plays again from the start' },
        { value: 'yoyo', icon: 'yoyo', label: 'Yo-yo: plays back the way it came' },
      ],
    },
    {
      key: 'axes',
      choices: [
        { value: 'object', icon: 'object', label: 'Object axes: points and turns go with the object' },
        { value: 'level', icon: 'level', label: 'Level axes: up stays up' },
      ],
    },
  ]

  /**
   * A `Sequence`'s header (ADR 0143, ADR 0147): its name, clock, loop and axes as icons you click to flip —
   * lit when not the default — the length, and ⚙ for the name, repeat and offset. ⚠ when anything inside is
   * wrong, so a problem shows with the section closed. With several selected, a click sets every one of them.
   */
  const sequenceHead = (doc: Doc, at: number, view: ComponentView, peers: readonly Peer[] | null): { title: string; summary: string; warn?: string; tools: HTMLElement[]; settings: HTMLElement } => {
    const data = sequenceOf({ id: view.id, type: view.type, params: view.params })
    const compiled = compileSequence(data)
    const targets = new Set(doc.childTargets(at).map((t) => t.id))
    let gone = 0
    for (const stage of data.stages) for (const step of stage.steps) if (step.target !== undefined && !targets.has(step.target)) gone++
    const count = compiled.problems.length + gone
    const defaults = doc.registry.defaults(view.type)
    const write = (patch: Record<string, unknown>): void => {
      edited(() => (peers === null ? doc.setParams(at, view.id, patch) : doc.setParamsAcross(peers, patch)))
      rebuildKeepingScroll()
    }
    const mixed = (key: string): boolean =>
      peers !== null && peers.length > 1 && !peers.every((pp) => sameValue(pp.params[key] ?? defaults[key], peers[0]!.params[key] ?? defaults[key]))

    const tools: HTMLElement[] = SEQUENCE_TOGGLES.map(({ key, choices }) => {
      const current = data[key]
      const at0 = choices[0].value === current
      const shown = at0 ? choices[0] : choices[1]
      const next = at0 ? choices[1] : choices[0]
      const b = el('button', 'isec-g seq-tog')
      b.type = 'button'
      b.append(icon(shown.icon))
      b.classList.toggle('lit', !at0)
      if (view.overridden.includes(key)) b.classList.add('over')
      if (mixed(key)) b.classList.add('mixed')
      b.title = `${mixed(key) ? 'Mixed across the selection. ' : ''}${shown.label} — click for ${next.label.split(':')[0]!.toLowerCase()}`
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        write({ [key]: next.value })
      })
      return b
    })

    const gear = el('button', 'isec-g seq-gear')
    gear.type = 'button'
    gear.append(icon('settings'))
    gear.title = 'name, repeat and offset'
    if (['name', 'times', 'offset'].some((k) => view.overridden.includes(k))) gear.classList.add('over')
    const panel = (): HTMLElement => {
      const box = el('div', 'seq-settings')
      const row = (key: string, label: string, ...controls: HTMLElement[]): void => {
        const r = el('div', `seq-f${view.overridden.includes(key) ? ' over' : ''}`)
        const c = el('div', 'seq-fc')
        c.append(...controls)
        r.append(el('span', 'seq-fl', label), c)
        box.append(r)
      }
      const name = el('input', 'seq-text')
      name.type = 'text'
      name.placeholder = 'unnamed'
      name.value = data.name
      name.addEventListener('change', () => write({ name: name.value.trim() }))
      row('name', 'Name', name)
      const forever = data.times <= 0
      const repeat = segmented(
        [
          { value: 'forever', label: 'Forever' },
          { value: 'count', label: 'Count' },
        ],
        forever ? 'forever' : 'count',
        (v) => write({ times: v === 'forever' ? 0 : 2 }),
      )
      const passes = forever
        ? []
        : [scrubField({ value: data.times, unit: '×', spec: { perPixel: 0.1, grain: 1, min: 1 }, title: 'passes before it holds — a yo-yo’s out and back is two', commit: (v) => write({ times: Math.max(1, Math.round(v)) }) })]
      row('times', 'Repeat', repeat, ...passes)
      row(
        'offset',
        'Offset',
        scrubField({
          value: data.offset,
          unit: '%',
          spec: { perPixel: 0.5, grain: 1, min: 0, max: 100 },
          title: 'where in its cycle it starts, for staggering a row',
          toShown: (v) => v * 100,
          fromShown: (v) => v / 100,
          commit: (v) => write({ offset: v }),
        }),
      )
      return box
    }
    gear.addEventListener('click', (e) => {
      e.stopPropagation()
      if (popoverOpenFor(gear)) {
        settingsOpen = null
        closePopover()
        return
      }
      settingsOpen = view.id
      openPopover(gear, panel(), { className: 'pop-settings', onDismiss: () => (settingsOpen = null) })
    })
    tools.push(gear)
    return {
      title: data.name === '' ? 'Sequence' : `Sequence  ${data.name}`,
      summary: sequenceSummary(data, compiled.passSeconds),
      ...(count > 0 ? { warn: `${count} thing${count === 1 ? '' : 's'} in this sequence will not work as written — see ⚠ below` } : {}),
      tools,
      settings: gear,
    }
  }

  const addSequenceBody = (section: Section, doc: Doc, at: number, view: ComponentView, peers: readonly Peer[] | null): void => {
    // Stages differ per object, so a multi-selection edits the settings they share and nothing else.
    if (peers !== null && peers.length > 1) {
      section.row('stages', 'select one object to edit its stages')
      return
    }
    const data = sequenceOf({ id: view.id, type: view.type, params: view.params })
    if (!shut.has(view.id))
      for (const stage of data.stages)
        for (const step of stage.steps) if (step.kind === 'move' && openSteps.has(step.id)) shownMoves.push({ node: at, componentId: view.id, stepId: step.id })
    const diff = doc.sequenceOverrideOf(at, view.id)
    const marked = new Set([...Object.keys(diff?.steps ?? {}), ...(diff?.addedSteps ?? []).map((s) => s.id), ...(diff?.addedStages ?? [])])
    const afterEdit = (): void => {
      host.onPropsChanged()
      rebuildKeepingScroll()
    }
    section.append(
      sequenceEditor({
        node: at,
        componentId: view.id,
        stages: data.stages,
        compiled: compileSequence(data),
        targets: doc.childTargets(at),
        commit: (stages) => {
          doc.setSequenceStages(at, view.id, stages)
          afterEdit()
        },
        stagesOf: (componentId) => {
          const other = doc.components(at).find((c) => c.id === componentId && c.type === SEQUENCE)
          return other === undefined ? null : readStages(other.params.stages)
        },
        commitMany: (changes) => {
          doc.setSequencesStages(at, changes)
          afterEdit()
        },
        openMenu: (where, items, title) => host.menu.open(where, items, title),
        open: openSteps,
        rerender: rebuildKeepingScroll,
        freshId,
        marked,
      }),
    )
  }

  /**
   * A copied component's values into this document's, or why not (ADR 0191): an asset another game owns is refused
   * here as it would be dropped on the field.
   */
  const clipAssetsRefusal = (doc: Doc, c: Extract<Clip, { kind: 'component' }>): string | null => {
    const decls = doc.registry.get(c.type)?.params
    return decls === undefined ? null : assetsRefusal(c.params, decls, (of, id, dataType) => host.assetRefusal(of, id, dataType))
  }

  /** Write a copied component's values onto one component: a sequence's stages by their own route (ADR 0139). */
  const writeClip = (doc: Doc, i: number, componentId: string, c: Extract<Clip, { kind: 'component' }>): void => {
    if (c.type === SEQUENCE) {
      const { stages, ...rest } = c.params
      doc.setParams(i, componentId, { ...rest })
      doc.setSequenceStages(i, componentId, readStages(stages))
    } else doc.setParams(i, componentId, structuredClone({ ...c.params }))
  }

  /** Paste Component As New (ADR 0191): the copy added to each of `into` that may take it, as one edit. */
  const pasteAsNewItem = (doc: Doc, into: readonly number[]): MenuItem => {
    const c = clip?.kind === 'component' ? clip : null
    const able = c === null ? [] : into.filter((i) => doc.canAdd(i, c.type))
    const why =
      c === null
        ? 'nothing copied — Copy Component first'
        : !doc.registry.has(c.type)
          ? `this game has no ${c.label}`
          : able.length === 0
            ? doc.registry.get(c.type)?.singleton === true
              ? `${c.label} can only be on an object once, and ${into.length > 1 ? 'these have one' : 'this has one'}`
              : `${c.label} cannot go here`
            : clipAssetsRefusal(doc, c)
    return {
      label: into.length > 1 && able.length > 0 ? `Paste Component As New (${able.length})` : 'Paste Component As New',
      ...(why === null ? {} : { enabled: false, why }),
      run: () => {
        if (c === null || why !== null) return
        edited(() => {
          for (const i of able) {
            const id = doc.addComponent(i, c.type)
            if (id === null) continue
            writeClip(doc, i, id, c)
            if (!c.enabled) doc.setComponentEnabled(i, id, false)
          }
        })
        rebuildKeepingScroll()
      },
    }
  }

  /** A component card's Copy Component, Paste Component As New and Paste Component Values — Unity's three. */
  const clipboardItems = (doc: Doc, at: number, view: ComponentView, peers: readonly Peer[] | null): MenuItem[] => {
    const label = doc.registry.get(view.type)?.label ?? view.type
    const targets = peers ?? [{ at, componentId: view.id }]
    const c = clip?.kind === 'component' ? clip : null
    const valuesWhy = valuesRefusal(clip, view.type) ?? (c === null ? null : clipAssetsRefusal(doc, c))
    return [
      {
        label: 'Copy Component',
        divider: true,
        run: () => {
          // Every value, the defaults filled in, so a paste sets all of them as Unity's does.
          clip = { kind: 'component', type: view.type, label, params: structuredClone({ ...doc.registry.defaults(view.type), ...view.params }), enabled: view.enabled }
          rebuildKeepingScroll()
        },
      },
      pasteAsNewItem(doc, peers === null ? [at] : peers.map((p) => p.at)),
      {
        label: peers === null ? 'Paste Component Values' : `Paste Component Values (${peers.length})`,
        ...(valuesWhy === null ? {} : { enabled: false, why: valuesWhy }),
        run: () => {
          if (c === null || valuesWhy !== null) return
          edited(() => {
            for (const t of targets) writeClip(doc, t.at, t.componentId, c)
          })
          rebuildKeepingScroll()
        },
      },
    ]
  }

  /** One card per component: header controls, then its visible parameters. */
  const addComponentSection = (doc: Doc, at: number, view: ComponentView, peers: readonly Peer[] | null): void => {
    const def = doc.registry.get(view.type)
    // Per component, not per node: a placement's root shows its prefab root's components beside its own.
    const inherited = doc.kindOf(at) === 'inherited' || view.inherited
    // A sequence's differences are recorded apart from its params (ADR 0139), so they are counted apart too.
    const sequenceDiff = view.type === SEQUENCE ? doc.sequenceOverrideOf(at, view.id) : undefined
    const sequenceChanges =
      sequenceDiff === undefined
        ? 0
        : Object.keys(sequenceDiff.steps ?? {}).length + (sequenceDiff.addedSteps?.length ?? 0) + (sequenceDiff.removedSteps?.length ?? 0) + (sequenceDiff.addedStages?.length ?? 0)
    const overridden = view.overridden.length > 0 || sequenceChanges > 0
    const items: MenuItem[] = []
    /**
     * Reset and Revert are the same gesture pointed at different baselines, and only one of them applies at a
     * time. On an own component the baseline is the declaration's defaults. On an inherited one it is the
     * prefab — and offering "reset to defaults" there would *write* an override for every parameter, which is
     * the opposite of what somebody reaching for it wants.
     */
    if (inherited) {
      if (overridden) items.push({ label: 'Revert to prefab', run: () => host.revertOverride(view.id) })
    } else if (def !== undefined) {
      items.push({
        label: peers === null ? 'Reset to defaults' : `Reset to defaults (${peers.length})`,
        run: () => {
          const defaults = { ...doc.registry.defaults(view.type) }
          edited(() => (peers === null ? doc.setParams(at, view.id, defaults) : doc.setParamsAcross(peers, defaults)))
          rebuildKeepingScroll()
        },
      })
    }
    if (!inherited) {
      items.push({ label: 'Move up', run: () => moveAndRebuild(doc, at, view.id, -1) })
      items.push({ label: 'Move down', run: () => moveAndRebuild(doc, at, view.id, 1) })
    }
    items.push({
      label: `${inherited ? (view.added ? 'Remove (undo add)' : 'Remove here') : 'Remove'}${peers === null ? '' : ` (${peers.length})`}`,
      run: () => {
        // Each node's own component, matched by type and ordinal (ADR 0112). Not one commit — `removeComponent`
        // owns its own, and a removal is already its own undo entry per node.
        for (const pp of peers ?? [{ at, componentId: view.id }]) doc.removeComponent(pp.at, pp.componentId)
        host.onPropsChanged()
        rebuildKeepingScroll()
      },
    })
    items.push(...clipboardItems(doc, at, view, peers))

    const state = boundState(doc.registry.defaults(view.type), view.params)
    const shown = def === undefined || view.type === SEQUENCE ? null : visibleParams(def.params, state)
    const seqHead = view.type === SEQUENCE && def !== undefined ? sequenceHead(doc, at, view, peers) : null
    const ordinal = doc.components(at).filter((c) => c.type === view.type).findIndex((c) => c.id === view.id)
    const section = addSection(view.id, {
      card: `${view.type}#${ordinal}`,
      title: seqHead?.title ?? def?.label ?? view.type,
      icon: componentIcon(view.type),
      ...(seqHead === null ? {} : { summary: seqHead.summary, tools: seqHead.tools, ...(seqHead.warn === undefined ? {} : { warn: seqHead.warn }) }),
      // What used to be spelled into the folder's title string, as a badge that cannot push the name out.
      badge: view.added ? 'added' : overridden ? String(view.overridden.length + sequenceChanges) : '',
      off: !view.enabled,
      enable: (on) => {
        edited(() => {
          for (const pp of peers ?? [{ at, componentId: view.id }]) doc.setComponentEnabled(pp.at, pp.componentId, on)
        })
        rebuildKeepingScroll()
      },
      menu: items,
      empty: shown !== null && shown.length === 0,
    })
    if (overridden) section.root.classList.add('over-sec')
    /**
     * Dragged by its header (`cardDrag.ts`): to reorder — where Move up / Move down are offered, an own component —
     * and onto a reference field, which takes this component as Unity's does a dragged header (ADR 0177), a
     * prefab's included. One object selected. A press on the header's own controls is theirs.
     */
    if (peers === null) {
      const movable = !inherited
      if (movable) section.root.classList.add('movable')
      section.header.addEventListener('pointerdown', (e) => {
        if ((e.target as Element).closest('button, input, select') !== null) return
        pressCardToDrag(e, section.root, {
          ...(movable ? { drop: (from: number, to: number) => moveAndRebuild(doc, at, view.id, to - from) } : {}),
          label: { icon: componentIcon(view.type), text: `${doc.label(at)} (${def?.label ?? view.type})` },
          outside: (x, y) => {
            const field = refFieldAt(x, y)
            if (field === null) return null
            const drag = { kind: 'component', index: at, component: view.id } as const
            return { key: field, offer: () => field.offer(drag), leave: () => field.leave(), take: () => field.take(drag) }
          },
        })
      })
    }

    if (def === undefined) {
      // A level authored by a build that had a component this one does not. Saying so beats showing nothing
      // and silently dropping it on the next save.
      section.row('unknown', `no '${view.type}' in this build`)
      return
    }

    if (view.type === SEQUENCE) {
      // Open again what the edit's rebuild took away (see `settingsOpen`) — once the rebuild has put the scroll
      // back, or it would hang where the header was before.
      if (seqHead !== null && settingsOpen === view.id) {
        const gear = seqHead.settings
        queueMicrotask(() => {
          if (gear.isConnected && !popoverOpenFor(gear)) gear.click()
        })
      }
      addSequenceBody(section, doc, at, view, peers)
      return
    }
    for (const key of shown ?? []) {
      const spec = def.params[key]
      if (spec !== undefined) addParam(section, doc, at, view, state, key, spec, peers)
    }
  }

  /** How the transform's three lines drag: a tenth of a metre, a degree, a twentieth, a pixel. */
  const TRANSFORM_LINES = [
    ['position', 'position', 0.1],
    ['rotationDeg', 'rotation °', 1],
    ['scale', 'scale', 0.05],
  ] as const

  /** The transform, as a card like any other — it used to be three rows floating with no owner. */
  const addTransformSection = (doc: Doc, at: number): void => {
    const overridden = doc.overridesOf(at).includes('transform')
    const items: MenuItem[] = overridden ? [{ label: 'Revert to prefab', run: () => host.revertOverride('transform') }] : []
    // Unity's Transform menu (ADR 0191): its three lines copied and pasted, and a copied component added here.
    const values = host.readTransform()
    const count = host.selectionCount()
    items.push(
      {
        label: 'Copy Component',
        divider: items.length > 0,
        enabled: values !== null,
        run: () => {
          if (values === null) return
          clip = { kind: 'transform', position: { ...values.position }, rotationDeg: { ...values.rotationDeg }, scale: { ...values.scale } }
          rebuildKeepingScroll()
        },
      },
      pasteAsNewItem(doc, count > 1 ? host.selectionIndices() : [at]),
      {
        label: count > 1 ? `Paste Component Values (${count})` : 'Paste Component Values',
        ...(clip?.kind === 'transform' ? {} : { enabled: false, why: 'nothing copied — Copy Component on a Transform first' }),
        run: () => {
          if (clip?.kind !== 'transform') return
          host.pasteTransform({ position: { ...clip.position }, rotationDeg: { ...clip.rotationDeg }, scale: { ...clip.scale } })
          rebuildKeepingScroll()
        },
      },
    )
    const section = addSection(TRANSFORM, { title: 'Transform', icon: 'toolMove', badge: overridden ? '1' : '', menu: items, fixed: true })
    if (overridden) section.root.classList.add('over-sec')

    /**
     * Several selected (ADR 0112): an axis whose value differs is blank, and each field writes its own axis to
     * every selected node — as it settles, since `writeAxis` is itself one history entry.
     */
    const many = host.selectionTransforms()
    if (many.length > 1) {
      for (const [key, label, step] of TRANSFORM_LINES) {
        const fields = AXES.map((axis) => {
          const values = many.map((t) => t[key][axis])
          const first = values[0] ?? 0
          return numberField({
            value: values.every((v) => v === first) ? r4(first) : null,
            spec: numberScrub({ step }),
            title: `${label} ${axis}`,
            history: key,
            axis,
            live: false,
            write: (v) => host.writeAxis(key, axis, v),
          }).root
        })
        section.field(label, ...fields)
      }
      return
    }

    readSel()
    for (const [key, label, step] of TRANSFORM_LINES) {
      const fields = AXES.map((axis) => {
        const field = numberField({
          value: sel[key][axis],
          spec: numberScrub({ step }),
          title: `${label} ${axis}`,
          history: 'transform',
          axis,
          write: (v) => {
            sel = { ...sel, [key]: { ...sel[key], [axis]: v } }
            applyTransform()
          },
        })
        transformFields.push({ key, axis, field })
        return field.root
      })
      const line = section.field(label, ...fields)
      if (overridden) line.classList.add('over')
    }
  }

  /**
   * One button opening a searchable tree of components by folder (ADR 0178) — Unity's Add Component: Physics,
   * Rendering, Gameplay, Animation, then the game's own under its name. A search lists every match flat.
   */
  const addAddButton = (doc: Doc, at: number): void => {
    /**
     * With several selected, offer a component **any** of them can take, and add it to each that can
     * (ADR 0112) — which is Unity's behaviour. Offering only what all of them lack would hide the case the
     * gesture is for: three objects, one of which already has a Collider.
     */
    const targets = host.selectionIndices().length > 1 ? host.selectionIndices() : [at]
    const addable = doc.registry
      .all()
      .map((d) => d.type)
      .filter((type) => targets.some((i) => doc.canAdd(i, type)))
    // Shared components this game has not opted into yet. Picking one adds it to the game first (ADR 0077).
    const adoptable = host.adoptable()
    const button = el('button', 'iadd')
    button.type = 'button'
    button.append(icon('plus'), el('span', undefined, 'Add Component'))
    button.disabled = addable.length === 0 && adoptable.length === 0
    button.title = button.disabled
      ? 'these objects already have one of everything'
      : targets.length > 1
        ? `add a component to all ${targets.length} selected`
        : 'add a component to this object'
    const place = (d: Doc, type: string): void => {
      let opened: string | null = null
      for (const i of targets) {
        if (!d.canAdd(i, type)) continue // already has one, and it is a singleton
        const id = d.addComponent(i, type)
        if (i === at) opened = id
      }
      host.onPropsChanged()
      if (opened !== null) shut.delete(opened) // what you just added should be open
      rebuildKeepingScroll()
    }
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      if (popoverOpenFor(button)) return closePopover()
      const entries = [
        ...addable.map((type) => ({ type, def: doc.registry.get(type), adopts: false })),
        // Not in the game's registry yet: its definition comes from the shared set.
        ...adoptable.map((type) => ({ type, def: sharedComponents([type])[0], adopts: true })),
      ]
      const items: TreeItem[] = byMenuFolder(entries, (x) => menuFolderOf(x.def, host.gameLabel())).map((g) => ({
        key: `folder:${g.folder}`,
        label: g.folder,
        icon: 'folder',
        pickable: false,
        children: g.entries.map((x) => ({ key: x.type, label: x.def?.label ?? x.type, icon: componentIcon(x.type), pickable: true, ...(x.adopts ? { hint: 'adds to game' } : {}) })),
      }))
      const picker = treePicker({
        items,
        openAll: true,
        pick: (type) => {
          closePopover()
          const x = entries.find((en) => en.type === type)
          if (x === undefined) return
          if (!x.adopts) return place(doc, x.type)
          // The document is rebuilt against the grown registry, so add to the one the host now holds.
          void host.adopt(x.type).then(() => {
            const fresh = host.doc()
            if (fresh !== null) place(fresh, x.type)
          })
        },
      })
      openPopover(button, picker.root, { className: 'pop-ref pop-add' })
      picker.focus()
    })
    container.append(button)
  }

  /**
   * The level's own settings (ADR 0162): its network bounds. Which game it is for is its folder, and that game's
   * settings are the games window's.
   */
  const addLevelSection = (doc: Doc): void => {
    if (doc.mode === 'prefab') {
      addSection('@level', { title: 'Level' }).row('', 'a prefab has no network bounds of its own')
      return
    }
    addBoundsSection(doc)
  }

  /**
   * How far this level reaches on the wire (ADR 0093), and a box in the viewport showing it.
   *
   * The box is the point. The same number in a config file was a silent trap: set it too small and peers
   * freeze past the edge with no error anywhere, in multiplayer only, on somebody else's screen (ADR 0092).
   * Drawn, a bound that does not fit the level is something you can see. It is off by default and toggled
   * here, never left on: it is a ruler, not scenery.
   */
  const addBoundsSection = (doc: Doc): void => {
    const own = doc.netBounds()
    const metres = own ?? QUANT_BOUND
    const sec = addSection('@net-bounds', { title: 'Network bounds' })

    sec.field(
      'reach ±m',
      numberField({
        value: metres,
        spec: numberScrub({ min: 10, max: 20000, step: 10 }),
        title: 'reach ±m',
        history: 'network bounds',
        live: false,
        write: (v) => {
          doc.setNetBounds(v)
          host.onNetBoundsChanged()
          // The lines below are worked out from it.
          rebuildKeepingScroll()
        },
      }).root,
    )
    // The whole trade in one line: a u16 an axis, so the step is the range over 65535.
    sec.row('step', `${(((2 * metres) / 65535) * 100).toFixed(1)} cm between positions a peer can be at`)
    sec.field('show box', checkField(host.boundsBoxShown(), (on) => host.showBoundsBox(on)))

    const reach = host.boundsReach()
    if (reach === null) sec.row('', 'nothing loaded')
    else if (reach.outside > 0) {
      sec.row('outside', `${reach.outside} object${reach.outside === 1 ? '' : 's'} past the bound — peers out there stop moving for everyone else`)
      sec.row('', `the level reaches ${Math.ceil(reach.reach)} m`)
    } else sec.row('fits', `the level reaches ${Math.ceil(reach.reach)} m of ${metres}`)

    if (own === undefined) sec.row('', `unset — using the platform default of ${QUANT_BOUND} m`)
    else {
      const back = el('button', 'ctl', `use the default (${QUANT_BOUND} m)`)
      back.addEventListener('click', () => {
        doc.setNetBounds(null)
        host.onNetBoundsChanged()
        rebuildKeepingScroll()
      })
      sec.append(back)
    }
  }

  const addEnvironmentSections = (doc: Doc): void => {
    if (doc.mode === 'prefab') {
      addSection('@env', { title: 'Environment' }).row('', 'a prefab has no environment of its own')
      return
    }

    /**
     * The blocks are written back **together**, because they are one field on the level and because they are
     * coupled: the sun's angles move the sky's glow, and `ambient` is the strength of the map the sky bakes
     * (ADR 0048). Writing one at a time would drop the others on a fresh level, which has none of them.
     */
    const current = doc.environment() ?? {}
    const sun = { ...(current.sun ?? { elevation: 30, azimuth: 38, intensity: 2.4, color: '#ffffff', shadows: true }) }
    const ambient = { ...(current.ambient ?? { intensity: 0.2 }) }
    const sky = { ...(current.sky ?? DEFAULT_SKY_PARAMS) }
    const postfx = { ...(current.postfx ?? DEFAULT_POSTFX) }
    const write = (): void => {
      doc.setEnvironment({ sun: { ...sun }, ambient: { ...ambient }, sky: { ...sky }, postfx: { ...postfx } })
      host.onEnvironmentChanged()
    }
    /** A number of the environment, which the sky and the light follow as it is dragged. */
    const number = (sec: Section, label: string, value: number, d: { min: number; max: number; step: number }, put: (v: number) => void): void => {
      sec.field(
        label,
        numberField({
          value,
          spec: numberScrub(d),
          title: label,
          history: 'environment',
          write: (v) => {
            put(v)
            write()
          },
        }).root,
      )
    }
    const colour = (sec: Section, label: string, value: string, put: (v: string) => void): void => {
      const w = liveWrite<string>('environment', (c) => {
        put(c)
        write()
      })
      sec.field(label, colorField(value, w.commit, w.live))
    }
    const tick = (sec: Section, label: string, value: boolean, put: (on: boolean) => void): void => {
      sec.field(
        label,
        checkField(value, (on) => {
          put(on)
          write()
        }),
      )
    }

    const sunSection = addSection('@env-sun', { title: 'Sun' })
    number(sunSection, 'elevation °', sun.elevation, { min: 1, max: 89, step: 1 }, (v) => (sun.elevation = v))
    number(sunSection, 'azimuth °', sun.azimuth, { min: -180, max: 180, step: 1 }, (v) => (sun.azimuth = v))
    number(sunSection, 'intensity', sun.intensity, { min: 0, max: 10, step: 0.05 }, (v) => (sun.intensity = v))
    colour(sunSection, 'colour', sun.color, (v) => (sun.color = v))
    tick(sunSection, 'shadows', sun.shadows, (on) => (sun.shadows = on))
    sunSection.row('', 'elevation and azimuth also move the sky')

    /**
     * The sky's own light, and the reason it needs a control: it is image-based, not a light object, so turning
     * every light off leaves it lighting the scene. At 1 this sky's irradiance is blue twenty-one times red.
     */
    const ambientSection = addSection('@env-ambient', { title: 'Ambient' })
    number(ambientSection, 'from the sky', ambient.intensity, { min: 0, max: 1.5, step: 0.01 }, (v) => (ambient.intensity = v))
    ambientSection.row('', 'the sky lighting the level, not a light')

    const skySection = addSection('@env-sky', { title: 'Sky' })
    colour(skySection, 'top', sky.topColor, (v) => (sky.topColor = v))
    colour(skySection, 'bottom', sky.bottomColor, (v) => (sky.bottomColor = v))
    number(skySection, 'ramp bias', sky.gradientBias, { min: 0.3, max: 3, step: 0.05 }, (v) => (sky.gradientBias = v))
    number(skySection, 'gain', sky.gain, { min: 0.1, max: 6, step: 0.05 }, (v) => (sky.gain = v))
    colour(skySection, 'sun tint', sky.glowColor, (v) => (sky.glowColor = v))
    number(skySection, 'glow', sky.glowStrength, { min: 0, max: 2, step: 0.01 }, (v) => (sky.glowStrength = v))
    number(skySection, 'glow tight', sky.glowSharpness, { min: 4, max: 600, step: 4 }, (v) => (sky.glowSharpness = v))
    number(skySection, 'sun disc', sky.sunDiskIntensity, { min: 0, max: 2000, step: 10 }, (v) => (sky.sunDiskIntensity = v))

    /**
     * The passes over the finished image. Here rather than in a preferences dialogue because they are the
     * level's: occlusion is most of what gives greybox its form, and both are tuned against the light above.
     */
    const fxSection = addSection('@env-postfx', { title: 'Post-FX' })
    tick(fxSection, 'ambient occl.', postfx.ao, (on) => (postfx.ao = on))
    tick(fxSection, 'bloom', postfx.bloom, (on) => (postfx.bloom = on))
    number(fxSection, 'bloom str', postfx.bloomStrength, { min: 0, max: 1.5, step: 0.05 }, (v) => (postfx.bloomStrength = v))
    fxSection.row('', 'bloom only fires on emissive materials')

    /**
     * The game camera (ADR 0148). Its own field on the level rather than part of `environment`, which is what
     * the renderer lights and draws with; this is what the camera does about a wall.
     */
    const camSection = addSection('@env-camera', { title: 'Camera' })
    camSection.field('see through', checkField(doc.cameraSeeThrough(), (on) => doc.setCameraSeeThrough(on)))
    camSection.row('', 'on: a wall in the way gets a hole · off: it stops the camera')
  }

  /** Every rebuild re-learns which move steps are open, and tells the viewport (ADR 0144). */
  const rebuild = (): void => {
    shownMoves = []
    build()
    host.pointsChanged()
  }

  const build = (): void => {
    // A drag whose field this rebuild takes away is over.
    endFieldDrag()
    document.body.classList.remove('scrubbing')
    // A popover belongs to the panel it came from; the new one opens its own again if it should.
    closePopover()
    transformFields = []
    followers = []
    container.replaceChildren()
    renderHead()
    drawnShape = shapeNow()

    const doc = host.doc()
    if (doc !== null && host.levelSelected()) {
      addLevelSection(doc)
      return
    }
    if (doc !== null && host.envSelected()) {
      addEnvironmentSections(doc)
      return
    }
    const at = host.selected()
    if (doc === null || at === null) return

    addTransformSection(doc, at)
    /**
     * With several selected, a component is shown only when **every** one of them has it (ADR 0112): the
     * panel edits what they have in common, and a component only some of them carry is not that. Hidden
     * rather than shown-and-refused, which is what Unity does and what stops a write having to decide what it
     * means for a node without the component.
     */
    const indices = host.selectionIndices()
    const multi = indices.length > 1
    for (const view of doc.components(at)) {
      const peers = multi ? peersOf(doc, indices, at, view) : null
      if (multi && peers === null) continue
      addComponentSection(doc, at, view, peers)
    }
    addAddButton(doc, at)
  }

  const refresh = (): void => {
    const shape = shapeNow()
    if (shape === null || shape !== drawnShape) {
      rebuildKeepingScroll()
      return
    }
    renderHead()
    sync()
    const doc = host.doc()
    if (doc !== null) doc.reading(() => followers.forEach((show) => show()))
  }

  return { rebuild, sync, refresh, renderHead, openPoint }
}
