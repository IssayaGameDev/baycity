import { vec3, type Vec3 } from '@mp/core'
import { COLLIDER, LIGHT, MATERIAL_OVERRIDE, RENDERER, SEQUENCE, SPAWN, compileSequence, readStages, sequenceOf, unitColliderFor, type ColliderDesc } from '@mp/content'
import { visibleParams, type AssetSpec, type ParamSpec } from '@mp/components'
import { QUANT_BOUND } from '@mp/net'
import { DEFAULT_POSTFX, DEFAULT_SKY_PARAMS } from '@mp/render-three'

import type { ComponentView, Doc } from './editorDoc'
import type { ContextMenu, MenuItem } from './menu'
import { isCurveSetting, type CurvePoint, type SettingDecls } from '@mp/mode'

import {
  checkField,
  closePopover,
  colorField,
  openPopover,
  popoverOpenFor,
  scrubField,
  scrubFieldOf,
  segmented,
  selectField,
  textField,
  type Choice,
  type Live,
  type ScrubHandle,
  type ScrubSpec,
} from './controls'
import { cardJustDragged, pressCardToDrag } from './cardDrag'
import { createCurveEditor } from './curveEditor'
import { icon, type IconName } from './icons'
import { sequenceSummary } from './sequenceEdit'
import { sequenceEditor } from './sequenceEditor'

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
  selected: () => number | null
  /**
   * The Environment row is selected instead of a node (ADR 0048). The panel then edits the level's sun, which
   * is a level setting rather than a component because the sun and the sky are one input (ADR 0046).
   */
  envSelected: () => boolean
  /** The Game row is picked (ADR 0052): the panel then edits which game the level is for. */
  gameSelected: () => boolean
  /** The installed games, for the Game section's picker. */
  games: () => readonly { name: string; label: string }[]
  /** The active game's declared settings and current values (ADR 0087/0088), or `null` when it declares none. */
  settings: () => { decls: SettingDecls; values: Record<string, number | CurvePoint[]> } | null
  onSettingChanged: (key: string, value: number | CurvePoint[]) => void
  /** The level was reassigned to another game: its registry changed, so panels and the world rebuild. */
  onModeChanged: () => void
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
  /** The name changed — the hierarchy row and status bar show it. */
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
  assetOptions: (of: AssetSpec['of']) => Record<string, string>
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
  Checkpoint: 'flag',
  Goal: 'goal',
  Hazard: 'hazard',
  Bumper: 'bumper',
  Death: 'death',
  Boss: 'boss',
}
export const componentIcon = (type: string): IconName => COMPONENT_ICONS[type] ?? 'component'

/**
 * How a number field drags, from what a declaration says (ADR 0113): a pixel is one `step`, landing on its
 * multiples; a bounded number without one crosses its range in 200 px, landing on the decade under that.
 *
 * The step shapes **the drag only**. Typed, any value in range is taken as it is — Tweakpane's `step` also
 * snapped what was typed, anchored to the value the field was built with, which made 33 unreachable from
 * 32.98 in steps of 0.05.
 */
export const numberScrub = (d: { readonly step?: number; readonly min?: number; readonly max?: number }): ScrubSpec => {
  const perPixel = d.step ?? (d.min !== undefined && d.max !== undefined ? (d.max - d.min) / 200 : 0.1)
  return {
    perPixel,
    grain: d.step ?? 10 ** Math.floor(Math.log10(perPixel)),
    ...(d.min === undefined ? {} : { min: d.min }),
    ...(d.max === undefined ? {} : { max: d.max }),
  }
}

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
    },
  ): Section => {
    const root = el('div', 'isec')
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
    }

    root.append(header)
    root.classList.toggle('off', opts.off === true)
    const body = el('div', 'isec-body')
    body.hidden = collapsed || opts.empty === true
    root.append(body)
    container.append(root)

    const field = (label: string, ...controls: HTMLElement[]): HTMLElement => {
      const line = el('div', 'irow')
      const slot = el('div', 'irow-c')
      slot.append(...controls)
      line.append(el('span', 'irow-l', label), slot)
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

    switch (spec.kind) {
      case 'number': {
        const v = state[key]
        line(
          numberField({
            value: mixed ? null : typeof v === 'number' ? v : spec.default,
            spec: numberScrub(spec),
            title: label,
            history: label,
            write: (n) => write({ [key]: n }),
          }).root,
        )
        return
      }
      case 'bool':
        line(checkField(mixed ? null : state[key] === true, (on) => write({ [key]: on }), label))
        return
      case 'string':
        line(textField(mixed ? null : String(state[key] ?? ''), (s) => write({ [key]: s }), { title: label }))
        return
      case 'color': {
        const w = liveWrite<string>(label, (c) => write({ [key]: c }))
        line(colorField(mixed ? null : String(state[key] ?? spec.default), w.commit, mixed ? undefined : w.live))
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
        line(
          ...AXES.map(
            (axis) =>
              numberField({
                value: peers === null ? own[axis] : agreed(axis),
                spec: numberScrub({ step: 0.1 }),
                title: `${label} ${axis}`,
                history: label,
                axis,
                write: (v) => writeAxis(axis, v),
              }).root,
          ),
        )
        return
      }
      case 'asset': {
        const choices = Object.entries(host.assetOptions(spec.of)).map(([text, id]) => ({ value: id, label: text }))
        line(
          selectField(
            choices,
            mixed ? null : String(state[key] ?? ''),
            (v) => {
              write({ [key]: v })
              // A built-in shape picked or dropped changes what the Collider card shows (ADR 0090).
              rebuildKeepingScroll()
            },
            label,
          ),
        )
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
        const size = (name: string, value: number, put: (v: number) => void): HTMLElement =>
          section.field(
            name,
            numberField({ value, spec: numberScrub({ step: 0.05, min: 0.01 }), title: name, history: name, write: put }).root,
          )
        if (shape.kind === 'box') {
          const half = vecOf(shape.halfExtents)
          section.field(
            'half extents',
            ...AXES.map(
              (axis) =>
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
                }).root,
            ),
          )
        } else if (shape.kind === 'ball') {
          size('radius', shape.radius, (v) => write({ [key]: { kind: 'ball', radius: v } }))
        } else if (shape.kind === 'capsule' || shape.kind === 'cylinder') {
          const dims = { kind: shape.kind, halfHeight: shape.halfHeight, radius: shape.radius }
          size('half height', dims.halfHeight, (v) => {
            dims.halfHeight = v
            write({ [key]: { ...dims } })
          })
          size('radius', dims.radius, (v) => {
            dims.radius = v
            write({ [key]: { ...dims } })
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
         * A dropdown of the nodes this one may name, rather than Unity's drag-an-object-into-the-field: the
         * scope is already narrow (`nodeChoices` refuses anything that would author a dangling reference), and a
         * picker cannot express a target the document does not have. `''` is "none"; the schema's is `null`.
         */
        if (mixed) return differs()
        const choices: Choice[] = [{ value: '', label: '(none)' }]
        for (const choice of doc.nodeChoices(at)) choices.push({ value: choice.id, label: `${choice.label} · ${choice.id.slice(0, 6)}` })
        const named = state[key]
        line(selectField(choices, typeof named === 'string' ? named : '', (v) => write({ [key]: v === '' ? null : v }), label))
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

    const state = boundState(doc.registry.defaults(view.type), view.params)
    const shown = def === undefined || view.type === SEQUENCE ? null : visibleParams(def.params, state)
    const seqHead = view.type === SEQUENCE && def !== undefined ? sequenceHead(doc, at, view, peers) : null
    const section = addSection(view.id, {
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
     * Dragged by its header to reorder (`cardDrag.ts`) — where Move up / Move down are offered: an own
     * component, one object selected. A press on the header's own controls is theirs.
     */
    if (!inherited && peers === null) {
      section.root.classList.add('movable')
      section.header.addEventListener('pointerdown', (e) => {
        if ((e.target as Element).closest('button, input, select') !== null) return
        pressCardToDrag(e, section.root, (from, to) => moveAndRebuild(doc, at, view.id, to - from))
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

  /** One button opening a filtered list, where a dropdown plus a button cost two rows and two clicks. */
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
      openMenu(button, [
        ...addable.map((type) => ({ label: doc.registry.get(type)?.label ?? type, run: () => place(doc, type) })),
        ...adoptable.map((type) => ({
          label: `${type} (adds to game)`,
          run: () => {
            // The document is rebuilt against the grown registry, so add to the one the host now holds.
            void host.adopt(type).then(() => {
              const fresh = host.doc()
              if (fresh !== null) place(fresh, type)
            })
          },
        })),
      ])
    })
    container.append(button)
  }

  /**
   * Which game this level is for (ADR 0052). One field, because that is all a game contributes to a level.
   *
   * Reassigning lives here rather than on the toolbar, deliberately: retagging a level is an edit with
   * consequences — its components are validated against the new game's registry — so it belongs where those
   * consequences are in front of you.
   */
  const addGameSection = (doc: Doc): void => {
    if (doc.mode === 'prefab') {
      addSection('@game', { title: 'Game' }).row('', 'a prefab belongs to no game')
      return
    }
    const section = addSection('@game', { title: 'Game' })
    const ref = doc.modeRef()
    const installed = host.games()

    const choices: Choice[] = [{ value: '', label: '(none)' }, ...installed.map((g) => ({ value: g.name, label: g.label }))]
    // A game the level names but this build does not have is offered as itself, so selecting something else is
    // a deliberate change rather than the only thing the dropdown will let you do.
    if (ref !== undefined && !installed.some((g) => g.name === ref.name)) choices.push({ value: ref.name, label: `${ref.name} (not installed)` })
    section.field(
      'game',
      selectField(choices, ref?.name ?? '', (game) => {
        edited(() => doc.setMode(game === '' ? null : game))
        host.onModeChanged()
      }),
    )

    if (ref === undefined) section.row('', 'unassigned — its components are checked against everything this build knows')
    else if (!installed.some((g) => g.name === ref.name)) section.row('', `'${ref.name}' is not installed: no rules, no rule gizmos`)

    addBoundsSection(doc)

    // The game's numbers (ADR 0087): one field per declaration, saved to the game's data file as each settles.
    const settings = host.settings()
    if (settings === null) return
    const tuning = addSection('@game-settings', { title: 'Game settings' })
    for (const [key, decl] of Object.entries(settings.decls)) {
      if (isCurveSetting(decl)) {
        // A curve gets its own card: a graph is not a line (ADR 0088).
        const sec = addSection(`@game-curve-${key}`, { title: decl.label })
        const pts = settings.values[key]
        const holder = el('div', 'icurve')
        sec.append(holder)
        createCurveEditor(holder, { decl, points: Array.isArray(pts) ? pts : decl.default, onChange: (points) => host.onSettingChanged(key, points) })
        if (decl.hint !== undefined) sec.row('', decl.hint)
        continue
      }
      const v = settings.values[key]
      tuning.field(
        decl.label,
        numberField({
          value: typeof v === 'number' ? v : decl.default,
          spec: numberScrub(decl),
          title: decl.label,
          history: decl.label,
          live: false,
          write: (n) => host.onSettingChanged(key, n),
        }).root,
      )
      if (decl.hint !== undefined) tuning.row('', decl.hint)
    }
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
    container.replaceChildren()
    renderHead()

    const doc = host.doc()
    if (doc !== null && host.gameSelected()) {
      addGameSection(doc)
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

  return { rebuild, sync, renderHead, openPoint }
}
