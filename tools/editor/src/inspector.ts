import { vec3, type Vec3 } from '@mp/core'
import { SEQUENCE, compileSequence, readStages, sequenceOf, unitColliderFor, type ColliderDesc } from '@mp/content'
import { visibleParams, type AssetSpec, type ParamSpec } from '@mp/components'
import { QUANT_BOUND } from '@mp/net'
import { DEFAULT_POSTFX, DEFAULT_SKY_PARAMS } from '@mp/render-three'
import { Pane } from 'tweakpane'

import type { ComponentView, Doc } from './editorDoc'
import type { ContextMenu, MenuItem } from './menu'
import { isCurveSetting, type CurvePoint, type SettingDecls } from '@mp/mode'

import { closePopover, openPopover, popoverOpenFor, scrubField, segmented } from './controls'
import { createCurveEditor } from './curveEditor'
import { icon, type IconName } from './seqIcons'
import { sequenceSummary } from './sequenceEdit'
import { sequenceEditor } from './sequenceEditor'

/**
 * The Inspector panel: a stack of **sections**, one per component, with the fields inside each generated from
 * that component's declared parameters.
 *
 * The chrome is ours; the value widgets are Tweakpane's (ADR 0038). Tweakpane is genuinely good at one thing —
 * a labelled number you can drag to scrub — and bad at the rest of what a component list needs. Its folder
 * title is a plain string, so component state had to be spelled into it (`Track (added here) — off`); every
 * control is a full-width row, so an `enabled` checkbox and a `Remove` button cost two of them per component,
 * which on a four-component node was 8 of 30 rows; and a folder cannot remember whether it was open across a
 * rebuild, which every enum change forces.
 *
 * So: a header row we draw (twist, enable checkbox, name, badge, ⋯ menu), a Tweakpane pane per section for the
 * fields, and the state that has to survive a rebuild — which sections are shut, where the panel was scrolled —
 * kept here rather than inside a widget library.
 *
 * Holds no Three.js: the host reads and writes the selection's transform, so this file knows only about
 * documents and numbers. Holds no *animation* either (ADR 0029/0037): a `keys` parameter shows its count and a
 * button to the timeline, because a property grid can only show one instant of a track.
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
   * With more than one the panel draws its own rows instead of Tweakpane's: an axis whose value differs is
   * **blank**, and a Tweakpane number cannot be empty.
   */
  selectionTransforms: () => readonly TransformValues[]
  /** Set one axis of one transform field on **every** selected node, as one undo entry (ADR 0112). */
  writeAxis: (field: 'position' | 'rotationDeg' | 'scale', axis: 'x' | 'y' | 'z', value: number) => void
  /** Anything other than the transform changed — meshes and the physics world need rebuilding. */
  onPropsChanged: () => void
  /** The name changed — the hierarchy row and status bar show it. */
  onRenamed: () => void
  duplicate: () => void
  remove: () => void
  /** Write the selection into a prefab file and point it at that file (ADR 0091). */
  saveAsPrefab: () => void
  openPrefab: () => void
  /**
   * Assets of one kind to offer, as Tweakpane options (label → asset id; `''` for none).
   *
   * One accessor keyed by the kind the parameter declares, rather than one per kind: `AssetSpec['of']` is
   * the same list, so a new asset-valued parameter needs nothing here.
   */
  assetOptions: (of: AssetSpec['of']) => Record<string, string>
  /** Open the timeline on this component's keyframe parameter (ADR 0037). */
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
  /** Redraw just the name + prefab link (e.g. after Save as prefab changed the link). */
  renderHead: () => void
  /** The move step drawn open that was opened last, or `null` (ADR 0144). */
  openPoint: () => OpenPoint | null
}

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4

/** The transform section's key in the collapse set. Not a component id, so it cannot collide with one. */
const TRANSFORM = '@transform'

/**
 * Shapes offered for a `Collider`. **No cylinder**: the physics wrapper has no cylinder shape and the loader
 * throws on one, so offering it here would let the editor author a level that cannot load.
 */
const SHAPE_OPTIONS: Record<string, string> = { box: 'box', ball: 'ball', capsule: 'capsule', convex: 'convex' }

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

/**
 * The values a component's widgets are bound to: declared defaults, the authored params over them, and
 * **nothing shared with the document** (ADR 0101).
 *
 * The deep copy is load-bearing. A spread is shallow, so `state.shape` would be the very same object as
 * `params.shape` — and on an *inherited* component that object is the **prefab's own**, because
 * `bakeOverrides` hands back the prefab's objects untouched where no override changed them (deliberately, so
 * that editing a shared definition is not a silent no-op, ADR 0033).
 *
 * Tweakpane then writes *into* a bound object rather than replacing it: `writePoint3d` calls `writeProperty`,
 * which does `valueObj[name] = value`. So dragging `half extents` on one placement wrote straight into the
 * prefab definition, every frame, before any op existed. Every other placement of that prefab in the open
 * level redrew at the new size while only the one touched got an override, and the next placement's slider
 * started from the mutated number instead of the prefab's real one.
 *
 * Local and transient — a prefab file is only written through the prefab's own live room, whose copy comes
 * from the server — but the viewport was showing sizes the level did not have.
 */
export const boundState = (defaults: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> =>
  structuredClone({ ...defaults, ...params })

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * A Tweakpane number field's drag speed, **without quantising what can be typed** (ADR 0113).
 *
 * `step` does two jobs in Tweakpane and they cannot be separated: it sets the pointer-drag increment *and*
 * it constrains the value. Worse, the constraint is anchored to whatever the field showed when it was built
 * (`createStepConstraint(params, initialValue)` → `new StepConstraint(step, initialValue)`), so the reachable
 * values are `origin + n × step`. A field built showing 32.98 with `step: 0.05` can never be set to 33 — it
 * lands on 32.98 or 33.03, silently, with nothing in the console.
 *
 * A transform or a size has a continuous domain: no value is invalid, so nothing may be unreachable.
 * `pointerScale` is the drag increment on its own, which is the half of `step` actually wanted here.
 */
export const dragSpeed = (increment: number): { pointerScale: number } => ({ pointerScale: increment })

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
   * The header is ours, not Tweakpane's: Unity's name field is full-width and prominent, and a Tweakpane
   * binding would put it in the label column like any other property.
   */
  /**
   * The active checkbox, immediately left of the name (ADR 0102).
   *
   * Exactly a component section's header — `isec-en` then the name — because it is exactly the same control
   * one level up: a tick, then the thing it switches off. No label. Kodjo's call, and the Hierarchy is for
   * finding and arranging things, so a column of checkboxes down it competed with the names.
   *
   * The Hierarchy still **dims** a switched-off row. That is the feedback; this is where you change it.
   */
  const activeBox = el('input', 'isec-en')
  activeBox.type = 'checkbox'
  activeBox.addEventListener('change', () => host.onSetEnabled(activeBox.checked))

  const nameInput = el('input', 'ctl name')
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

  const linkRow = el('div', 'link')
  const linkWho = el('span', 'who')
  /**
   * Unlink sits **left of** Open, so the two read in the order of how far they reach: this object, then the
   * shared definition behind it. It is only ever shown on a placement, where the row says which prefab.
   */
  const unlinkButton = el('button', 'ctl')
  unlinkButton.textContent = 'Unlink'
  unlinkButton.title = 'make this a plain object keeping what it draws \u2014 the prefab and its other placements are untouched'
  const linkButton = el('button', 'ctl')
  linkRow.append(linkWho, unlinkButton, linkButton)
  const multiNote = el('div', 'multi')
  /** Tick and name on one line, the way a component section's header reads. */
  const nameRow = el('div', 'namerow')
  nameRow.append(activeBox, nameInput)
  head.append(nameRow, linkRow, multiNote)

  /** Name, prefab link, and the multi-selection note. Separate from `rebuild` so renaming is cheap. */
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

    // Selecting several and editing one was visible only in the status bar, which is the wrong place to learn
    // that the panel is not showing you everything you picked.
    const count = host.selectionCount()
    multiNote.hidden = count < 2
    // It used to read "editing <the primary>", which stopped being true: an edit reaches all of them
    // (ADR 0112), and what the panel shows is what they have in common.
    multiNote.textContent = count < 2 ? '' : `${count} selected · editing what they share`

    const ref = doc.refOf(at)
    linkRow.classList.toggle('linked', ref !== null)
    if (ref !== null) {
      const n = doc.refCount(ref)
      linkWho.textContent = `prefab: ${ref} · ${n} placement${n === 1 ? '' : 's'}`
      linkButton.textContent = 'Open'
      linkButton.title = 'edit the shared definition — every placement follows'
      linkButton.onclick = host.openPrefab
      linkButton.hidden = false
      // Only on a placement this document owns. An *inherited* node also has a `prefab` ref — it is part of
      // some prefab's definition — and there is nothing in this level to unlink for it.
      unlinkButton.hidden = doc.kindOf(at) !== 'own'
      unlinkButton.onclick = host.unlinkPrefab
    } else if (doc.mode === 'level' && doc.kindOf(at) === 'own') {
      linkWho.textContent = 'not saved as a prefab'
      unlinkButton.hidden = true
      linkButton.textContent = 'Save as prefab…'
      linkButton.title = 'write this into a prefab file — every level can then place it, and your edits reach all of them'
      linkButton.onclick = host.saveAsPrefab
      linkButton.hidden = false
    } else {
      linkWho.textContent = doc.kindOf(at) === 'inherited' ? 'part of a prefab — edits become overrides' : 'part of this prefab'
      unlinkButton.hidden = true
      linkButton.hidden = true
    }
  }

  const sel: TransformValues = { position: vec3(0, 0, 0), rotationDeg: vec3(0, 0, 0), scale: vec3(1, 1, 1) }

  /**
   * Which sections are shut, and it survives rebuilds *and* selections: somebody who collapses `Collider`
   * because they are working on one component means it for the session, not until the next dropdown change.
   *
   * Keyed by component id rather than by type, so two colliders on one node collapse independently.
   */
  const shut = new Set<string>()

  /** Every pane this build created, torn down on the next one. */
  let panes: Pane[] = []
  /** The transform pane, which is the only one `sync` has to refresh. */
  let transformPane: Pane | null = null

  /**
   * True while a build or `sync` is pushing values *into* a pane, so a refresh is not mistaken for a person
   * typing.
   *
   * Tweakpane's `refresh()` calls `fetch()`, which assigns `rawValue` — and that emits `change` exactly as a
   * keystroke does. During a gizmo drag that meant each frame's refresh re-entered `writeTransform`, which
   * re-posed the item from the document and threw away the drag's starting snapshot; a multi-selection then
   * stopped following the primary after the first frame. There is no option to suppress it, so the guard is
   * here, where the code knows it is the one writing.
   */
  let syncDepth = 0
  const syncing = (): boolean => syncDepth > 0

  const sync = (): void => {
    const t = host.readTransform()
    if (t === null || transformPane === null) return
    sel.position = vec3(r4(t.position.x), r4(t.position.y), r4(t.position.z))
    sel.rotationDeg = vec3(r4(t.rotationDeg.x), r4(t.rotationDeg.y), r4(t.rotationDeg.z))
    sel.scale = vec3(r4(t.scale.x), r4(t.scale.y), r4(t.scale.z))
    syncDepth++
    try {
      // Only the transform pane. The component panes are bound to their own snapshots and nothing a gizmo does
      // touches them, so refreshing them was work that also risked firing their handlers.
      transformPane.refresh()
    } finally {
      syncDepth--
    }
  }

  const applyTransform = (): void => {
    if (syncing()) return
    host.writeTransform({
      position: sel.position,
      rotationDeg: sel.rotationDeg,
      // A zero scale collapses the collider and makes the shape unrecoverable by dragging.
      scale: vec3(sel.scale.x || 1e-3, sel.scale.y || 1e-3, sel.scale.z || 1e-3),
    })
  }

  /** A change a person made, as opposed to one a refresh pushed in. */
  const edited = (write: () => void): void => {
    if (syncing()) return
    write()
    host.onPropsChanged()
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

  /** Open under a header button, which is where the pointer already is. */
  const openMenu = (at: HTMLElement, items: readonly MenuItem[], title?: string): void => {
    const rect = at.getBoundingClientRect()
    host.menu.open({ x: Math.round(rect.right), y: Math.round(rect.bottom + 2) }, items, title)
  }

  /**
   * A section's body, and how rows get into it in **declaration order**.
   *
   * Tweakpane owns one element per pane and appends inside it, so a row of ours emitted after a pane would
   * land after everything that pane ever holds. `pane()` therefore hands out the *current* pane and `row()`
   * retires it, so the next binding starts a fresh one further down. A `Track` comes out as `keys` (ours) then
   * `loop`/`phase` (Tweakpane's), which is the order they are declared in.
   */
  interface Section {
    readonly root: HTMLElement
    /** The pane to bind into, created on demand. */
    readonly pane: () => Pane
    /** Append one of our own rows, and end the current pane's run. */
    readonly row: (label: string, value: string) => HTMLElement
    /** Append something of our own that is not a row — the sequence editor — and end the pane's run too. */
    readonly append: (node: HTMLElement) => void
  }

  /**
   * One collapsible section, ours.
   *
   * The header is a row of small controls rather than a title string, which is the whole reason this is not a
   * Tweakpane folder: an enable checkbox and a ⋯ menu belong beside the name, not as two more full-width rows
   * inside it.
   */
  const addSection = (
    key: string,
    opts: {
      title: string
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
    },
  ): Section => {
    const root = el('div', 'isec')
    const header = el('div', 'isec-h')
    const collapsed = shut.has(key)

    const twist = el('button', 'isec-tw', collapsed ? '▸' : '▾')
    twist.title = collapsed ? 'expand' : 'collapse'
    twist.addEventListener('click', () => {
      if (shut.has(key)) shut.delete(key)
      else shut.add(key)
      rebuildKeepingScroll()
    })
    header.append(twist)

    if (opts.enable !== undefined) {
      const box = el('input', 'isec-en')
      box.type = 'checkbox'
      box.checked = opts.off !== true
      box.title = 'enabled — an off component is skipped by the loader and by the runtime'
      box.addEventListener('change', () => opts.enable?.(box.checked))
      header.append(box)
    }

    header.append(el('span', 'isec-t', opts.title))
    if (opts.summary !== undefined && opts.summary !== '') header.append(el('span', 'isec-sum', opts.summary))
    if (opts.badge !== undefined && opts.badge !== '') header.append(el('span', 'isec-badge', opts.badge))
    if (opts.warn !== undefined) {
      const w = el('span', 'isec-warn', '⚠')
      w.title = opts.warn
      header.append(w)
    }
    for (const tool of opts.tools ?? []) header.append(tool)

    if (opts.menu !== undefined && opts.menu.length > 0) {
      const dots = el('button', 'isec-m', '⋯')
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
    body.hidden = collapsed
    root.append(body)
    container.append(root)

    let current: Pane | null = null
    const pane = (): Pane => {
      if (current === null) {
        current = new Pane({ container: body })
        panes.push(current)
      }
      return current
    }
    const row = (label: string, value: string): HTMLElement => {
      current = null
      const line = el('div', 'irow')
      line.append(el('span', 'irow-l', label), el('span', 'irow-v', value))
      body.append(line)
      return line
    }
    const append = (node: HTMLElement): void => {
      current = null
      body.append(node)
    }
    return { root, pane, row, append }
  }

  /**
   * A parameter the selection disagrees about (ADR 0112): blank, and writing sets it on all of them.
   *
   * Drawn with plain inputs rather than Tweakpane, because Tweakpane's number box cannot be empty and a
   * pre-filled one would be a claim about values it has not got. An untouched control writes nothing.
   *
   * A compound value — a collider shape — is reported rather than offered: picking one shape for several
   * objects is a real intention, but it belongs to the shape picker, which is a row of its own and not
   * something to reconstruct blank.
   */
  const addMixedParam = (section: Section, label: string, key: string, spec: ParamSpec, write: (patch: Record<string, unknown>) => void): void => {
    const line = section.row(label, '')
    const slot = line.querySelector('.irow-v')
    if (slot === null) return
    slot.textContent = ''
    slot.classList.add('imulti')
    line.classList.add('mixed')

    const numberBox = (title: string, onSet: (v: number) => void, step?: number): HTMLInputElement => {
      const input = el('input', 'imulti-n') as HTMLInputElement
      input.type = 'number'
      if (step !== undefined) input.step = String(step)
      input.placeholder = '\u2014'
      input.title = `${title} \u2014 differs across the selection`
      const commit = (): void => {
        const v = Number(input.value)
        if (input.value.trim() === '' || !Number.isFinite(v)) return
        onSet(v)
      }
      input.addEventListener('change', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit()
      })
      return input
    }

    switch (spec.kind) {
      case 'number':
        slot.append(numberBox(label, (v) => write({ [key]: v }), spec.step))
        return
      case 'vec3': {
        // Per axis, like the transform's rows: one axis may agree while the others do not.
        const draft: Record<'x' | 'y' | 'z', number | null> = { x: null, y: null, z: null }
        for (const axis of ['x', 'y', 'z'] as const) {
          slot.append(
            numberBox(`${label} ${axis}`, (v) => {
              draft[axis] = v
              // Only the axes actually typed; an untouched one must stay each node's own.
              const patch: Record<string, number> = {}
              for (const a of ['x', 'y', 'z'] as const) if (draft[a] !== null) patch[a] = draft[a]!
              write({ [key]: patch })
            }, 0.1),
          )
        }
        return
      }
      case 'bool': {
        const box = el('input', 'imulti-c') as HTMLInputElement
        box.type = 'checkbox'
        box.indeterminate = true
        box.title = `${label} \u2014 differs across the selection`
        box.addEventListener('change', () => write({ [key]: box.checked }))
        slot.append(box)
        return
      }
      case 'string':
      case 'color': {
        const input = el('input', 'imulti-n') as HTMLInputElement
        input.type = 'text'
        input.placeholder = '\u2014'
        input.title = `${label} \u2014 differs across the selection`
        input.addEventListener('change', () => {
          if (input.value.trim() === '') return
          write({ [key]: input.value })
        })
        slot.append(input)
        return
      }
      case 'enum':
      case 'asset': {
        const select = el('select', 'imulti-n') as HTMLSelectElement
        select.title = `${label} \u2014 differs across the selection`
        const blank = el('option')
        blank.value = ''
        blank.textContent = '\u2014'
        select.append(blank)
        const options = spec.kind === 'enum' ? Object.fromEntries(spec.options.map((o) => [o, o])) : host.assetOptions(spec.of)
        for (const [text, value] of Object.entries(options)) {
          const opt = el('option')
          opt.value = value
          opt.textContent = text
          select.append(opt)
        }
        select.value = ''
        select.addEventListener('change', () => {
          // The blank entry is "leave them as they are", not a value to write.
          if (select.value === '' && spec.kind === 'enum') return
          write({ [key]: spec.kind === 'asset' && select.value === '' ? null : select.value })
        })
        slot.append(select)
        return
      }
      default:
        slot.classList.remove('imulti')
        slot.textContent = 'differs across the selection'
        return
    }
  }

  /**
   * One control per declared parameter.
   *
   * `state` is the component's values, completed with the declaration's defaults so a parameter added to a
   * component still has something to bind to in a level authored before it existed.
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

    /**
     * Does every selected node agree about this parameter? A differing value is drawn **blank** rather than
     * showing the primary's as if it spoke for all of them.
     *
     * The declaration's default stands in for a node that has no value written, which is what the bound state
     * does for the single case too.
     */
    const fallback = doc.registry.defaults(view.type)[key]
    const mixed =
      peers !== null && peers.length > 1 && !peers.every((pp) => sameValue(pp.params[key] ?? fallback, peers[0]!.params[key] ?? fallback))
    if (mixed) {
      addMixedParam(section, label, key, spec, write)
      return
    }
    /**
     * Mark an overridden row with a class, which CSS turns into a bar down its left edge — Unity's cue.
     *
     * `element` is Tweakpane's own public accessor for the row it built, so this is its API rather than a reach
     * into its internals. It replaced a `•` prefixed onto the label, which ate label width and was easy to
     * miss.
     */
    const mark = (blade: { element: HTMLElement }): void => {
      if (view.overridden.includes(key)) blade.element.classList.add('over')
    }

    switch (spec.kind) {
      case 'number': {
        const opts: Record<string, unknown> = { label }
        // The declared step is a drag increment, never a constraint on what may be typed (ADR 0113).
        if (spec.step !== undefined) Object.assign(opts, dragSpeed(spec.step))
        if (spec.min !== undefined) opts.min = spec.min
        if (spec.max !== undefined) opts.max = spec.max
        mark(section.pane().addBinding(state, key, opts).on('change', () => write({ [key]: state[key] })))
        return
      }
      case 'bool':
      case 'string':
        mark(section.pane().addBinding(state, key, { label }).on('change', () => write({ [key]: state[key] })))
        return
      case 'color':
        /**
         * No `view` option: Tweakpane's string-colour plugin picks the picker up from the **value's format**
         * (`detectStringColorFormat`), and only declines when told `view: 'text'`. Passing `view: 'color'` reads
         * as forcing it but is a no-op — `BaseInputParams` extends `Record<string, unknown>`, so any key,
         * including a typo, typechecks and is then ignored.
         *
         * What keeps this working is the declaration layer rejecting anything that is not `#rrggbb`, which is
         * exactly the format the plugin detects.
         */
        mark(section.pane().addBinding(state, key, { label }).on('change', () => write({ [key]: state[key] })))
        return
      case 'enum': {
        const options: Record<string, string> = {}
        for (const o of spec.options) options[o] = o
        mark(
          section.pane().addBinding(state, key, { label, options }).on('change', () => {
            write({ [key]: state[key] })
            // An enum can gate other parameters (`Visual.source` decides whether `model` is relevant), so the
            // set of rows may have changed. Scroll survives it now.
            rebuildKeepingScroll()
          }),
        )
        return
      }
      case 'vec3': {
        const step = dragSpeed(0.1)
        mark(section.pane().addBinding(state, key, { label, x: step, y: step, z: step }).on('change', () => write({ [key]: state[key] })))
        return
      }
      case 'asset': {
        const options = host.assetOptions(spec.of)
        mark(section.pane().addBinding(state, key, { label, options }).on('change', () => write({ [key]: state[key] })))
        return
      }
      case 'collider': {
        // A node drawing a built-in shape (ADR 0090): the collider is the unit shape and the scale is the size.
        const builtin = doc.builtinOf(at)
        if (builtin !== null) {
          section.row(label, `unit ${unitColliderFor(builtin).kind} · size is the object's scale`)
          return
        }
        const shape = (state[key] ?? spec.default) as ColliderDesc
        const picker = { kind: shape.kind as string }
        mark(
          section.pane().addBinding(picker, 'kind', { label, options: SHAPE_OPTIONS }).on('change', () => {
            write({ [key]: defaultShape(picker.kind, shape) })
            rebuildKeepingScroll()
          }),
        )
        const dims: Record<string, unknown> = { ...shape }
        const step = dragSpeed(0.05)
        if (shape.kind === 'box') {
          section.pane().addBinding(dims, 'halfExtents', { label: 'half extents', x: step, y: step, z: step }).on('change', () =>
            write({ [key]: { kind: 'box', halfExtents: dims.halfExtents } }),
          )
        } else if (shape.kind === 'ball') {
          section.pane().addBinding(dims, 'radius', { label: 'radius', ...dragSpeed(0.05), min: 0.01 }).on('change', () => write({ [key]: { kind: 'ball', radius: dims.radius } }))
        } else if (shape.kind === 'capsule' || shape.kind === 'cylinder') {
          const kind = shape.kind
          const push = (): void => write({ [key]: { kind, halfHeight: dims.halfHeight, radius: dims.radius } })
          section.pane().addBinding(dims, 'halfHeight', { label: 'half height', ...dragSpeed(0.05), min: 0.01 }).on('change', push)
          section.pane().addBinding(dims, 'radius', { label: 'radius', ...dragSpeed(0.05), min: 0.01 }).on('change', push)
        } else {
          // A hull is authored by whatever generated it (ADR 0017); there is no useful grid control for a
          // point cloud, so this states what is there and leaves it alone.
          section.row('hull', `${shape.points.length} points`)
        }
        return
      }
      case 'nodeRef': {
        /**
         * A dropdown of the nodes this one may name, rather than Unity's drag-an-object-into-the-field: the
         * scope is already narrow (`nodeChoices` refuses anything that would author a dangling reference), and a
         * picker cannot express a target the document does not have.
         *
         * `''` is the value for "none" so the binding has something to select; the schema's is `null`.
         */
        const options: Record<string, string> = { '(none)': '' }
        for (const choice of doc.nodeChoices(at)) options[`${choice.label} · ${choice.id.slice(0, 6)}`] = choice.id
        const pick = { ref: typeof state[key] === 'string' ? (state[key] as string) : '' }
        mark(section.pane().addBinding(pick, 'ref', { label, options }).on('change', () => write({ [key]: pick.ref === '' ? null : pick.ref })))
        return
      }
      case 'stages': {
        // A summary until the stage editor exists (ADR 0137): stages are drawn as boxes, not as a row.
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
        throw new Error(`inspector: no widget for parameter kind ${JSON.stringify(unhandled)}`)
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
  interface Choice {
    readonly value: string
    readonly icon: IconName
    readonly label: string
  }
  /** The three settings the header shows as icons, each first choice its default. */
  const SEQUENCE_TOGGLES: readonly { readonly key: 'clock' | 'loop' | 'axes'; readonly choices: readonly [Choice, Choice] }[] = [
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

  /** One section per component: header controls, then its visible parameters. */
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

    const seqHead = view.type === SEQUENCE && def !== undefined ? sequenceHead(doc, at, view, peers) : null
    const section = addSection(view.id, {
      title: seqHead?.title ?? def?.label ?? view.type,
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
    })
    if (overridden) section.root.classList.add('over-sec')

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
    const state = boundState(doc.registry.defaults(view.type), view.params)
    const shown = visibleParams(def.params, state)
    syncDepth++
    try {
      for (const key of shown) {
        const spec = def.params[key]
        if (spec !== undefined) addParam(section, doc, at, view, state, key, spec, peers)
      }
    } finally {
      syncDepth--
    }
    if (shown.length === 0) section.row('', 'no parameters')
  }

  /** The transform, as a section like any other — it used to be three rows floating with no owner. */
  const addTransformSection = (doc: Doc, at: number): void => {
    const overridden = doc.overridesOf(at).includes('transform')
    const items: MenuItem[] = overridden ? [{ label: 'Revert to prefab', run: () => host.revertOverride('transform') }] : []
    const section = addSection(TRANSFORM, { title: 'Transform', badge: overridden ? '1' : '', menu: items })
    const pane = section.pane()
    transformPane = pane
    if (overridden) section.root.classList.add('over-sec')

    const pos = dragSpeed(0.1)
    const rot = dragSpeed(1)
    const scl = dragSpeed(0.05)

    /**
     * Several selected: the panel draws the three rows itself (ADR 0112).
     *
     * Tweakpane binds a vec3 as one object and a number input cannot be empty, so there is no way to blank
     * the X of a position while Y and Z show numbers — which is exactly what an honest multi-selection has
     * to do. Three inputs per row, blank where the selection disagrees, and each writes its own axis to
     * every selected node.
     */
    const many = host.selectionTransforms()
    if (many.length > 1) {
      transformPane = null
      for (const [key, label, step] of [
        ['position', 'position', pos.pointerScale],
        ['rotationDeg', 'rotation °', rot.pointerScale],
        ['scale', 'scale', scl.pointerScale],
      ] as const) {
        const line = section.row(label, '')
        const slot = line.querySelector('.irow-v')
        if (slot === null) continue
        slot.textContent = ''
        slot.classList.add('imulti')
        for (const axis of ['x', 'y', 'z'] as const) {
          const values = many.map((t) => t[key][axis])
          const first = values[0] ?? 0
          const shared: number | null = values.every((v) => v === first) ? first : null
          const input = el('input', 'imulti-n') as HTMLInputElement
          input.type = 'number'
          input.step = String(step)
          input.title = `${label} ${axis}${shared === null ? ' — differs across the selection' : ''}`
          if (shared === null) input.placeholder = '—'
          else input.value = String(r4(shared))
          const commitAxis = (): void => {
            const v = Number(input.value)
            // An empty box means "leave it alone", which is the whole point of blanking a mixed value.
            if (input.value.trim() === '' || !Number.isFinite(v)) return
            host.writeAxis(key, axis, v)
          }
          input.addEventListener('change', commitAxis)
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commitAxis()
          })
          slot.append(input)
        }
      }
      return
    }

    syncDepth++
    try {
      const p = pane.addBinding(sel, 'position', { label: 'position', x: pos, y: pos, z: pos }).on('change', applyTransform)
      if (overridden) p.element.classList.add('over')
      pane.addBinding(sel, 'rotationDeg', { label: 'rotation °', x: rot, y: rot, z: rot }).on('change', applyTransform)
      pane.addBinding(sel, 'scale', { label: 'scale', x: scl, y: scl, z: scl }).on('change', applyTransform)
    } finally {
      syncDepth--
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
    const row = el('div', 'iadd')
    const button = el('button', 'ctl wide', 'Add Component')
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
        ...addable.map((type) => ({ label: type, run: () => place(doc, type) })),
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
    row.append(button)
    container.append(row)
  }

  /**
   * The override strip, right under the header where it describes what follows.
   *
   * **Two scopes** (ADR 0122). Overrides are stored per inherited **piece**, so selecting the prefab object
   * itself — the placement root, which holds no override of its own and never will — used to show nothing at
   * all, which is the first place an author looks after editing inside a prefab. The root now reports its
   * pieces and acts on all of them.
   *
   * The wording carries the scope, because the two buttons do very different amounts: on a piece they mean
   * this object, on the root they mean the whole instance.
   */
  const addOverrideStrip = (doc: Doc, at: number): void => {
    const kind = doc.kindOf(at)
    const isPlacement = kind === 'own' && doc.refOf(at) !== null
    if (kind !== 'inherited' && !isPlacement) return

    const strip = el('div', 'iover')
    if (isPlacement) {
      const changed = doc.placementOverrides(at)
      // Children dropped onto the placement are the level's, not the prefab's, until they are applied
      // (ADR 0130). They belong in this count or the strip would read "matches the prefab" beside one.
      const added = doc.placementAdded(at)
      // Pieces this placement does without (ADR 0133). No index, so `placementOverrides` cannot see them.
      const gone = doc.placementRemoved(at)
      if (changed.length === 0 && added.length === 0 && gone.length === 0) {
        strip.append(el('span', 'iover-t', 'matches the prefab'))
        container.append(strip)
        return
      }
      const total = changed.reduce((n, o) => n + o.fields.length, 0)
      strip.classList.add('on')
      const overridePart = total === 0 ? '' : `${total} override${total === 1 ? '' : 's'} on ${changed.length} object${changed.length === 1 ? '' : 's'}`
      const addedPart = added.length === 0 ? '' : `${added.length} added object${added.length === 1 ? '' : 's'}`
      const gonePart = gone.length === 0 ? '' : `${gone.length} removed piece${gone.length === 1 ? '' : 's'}`
      strip.append(el('span', 'iover-t', [overridePart, addedPart, gonePart].filter((x) => x !== '').join(', ')))
      const revert = el('button', 'ctl tiny', 'Revert all')
      const revertWhat = changed.map((o) => `${doc.label(o.index)}: ${o.fields.join(', ')}`)
      // Named one by one, because reverting deletes them and the button should say which.
      for (const i of added) revertWhat.push(`${doc.label(i)}: added, would be deleted`)
      for (const id of gone) revertWhat.push(`${id}: removed, would come back`)
      revert.title = `drop every change made inside this prefab (${revertWhat.join(' · ')})`
      revert.addEventListener('click', () => host.revertPlacement(at))
      const apply = el('button', 'ctl tiny', 'Apply all')
      apply.title = 'push every change inside this prefab into the shared definition — every placement of it follows'
      apply.addEventListener('click', () => void host.applyPlacementOverrides(at))
      strip.append(revert, apply)
      container.append(strip)
      return
    }

    const overridden = doc.overridesOf(at)
    if (overridden.length === 0) {
      strip.append(el('span', 'iover-t', 'matches the prefab'))
      container.append(strip)
      return
    }
    strip.classList.add('on')
    strip.append(el('span', 'iover-t', `${overridden.length} override${overridden.length === 1 ? '' : 's'}`))
    const revert = el('button', 'ctl tiny', 'Revert all')
    revert.title = `drop every override on this object (${overridden.join(', ')})`
    revert.addEventListener('click', () => host.revertOverride())
    const apply = el('button', 'ctl tiny', 'Apply')
    apply.title = 'push these into the shared prefab — every placement of it follows'
    apply.addEventListener('click', host.applyOverrides)
    strip.append(revert, apply)
    container.append(strip)
  }

  /** Object-level actions, compact and last: they are about the object, not about any component. */
  const addFooter = (doc: Doc, at: number): void => {
    if (doc.kindOf(at) !== 'own') return
    const row = el('div', 'ifoot')
    const dup = el('button', 'ctl', 'Duplicate')
    dup.title = 'Ctrl+D'
    dup.addEventListener('click', host.duplicate)
    const del = el('button', 'ctl danger', 'Delete')
    del.title = 'Del'
    del.addEventListener('click', host.remove)
    row.append(dup, del)
    container.append(row)
  }

  /**
   * The level's sun (ADR 0048), shown when the Environment row is selected.
   *
   * Hand-built rather than generated from declarations, because the sun is not a component: it is
   * `LevelConfig.sun`, sitting with the sky because the two are one input (ADR 0046). Every edit calls
   * `onSunChanged`, which rebakes the sky — moving the sun without rebaking is exactly how the light and the
   * sky would come to disagree again.
   */
  /**
   * Which game this level is for (ADR 0052). One field, because that is all a game contributes to a level.
   *
   * There were generated setting fields here too, from a `config: ParamDecls` on the descriptor — parkour's
   * `fallBehavior` and `fallY`. Both went when the kill plane became a `Hazard` on a collider (ADR 0053): a
   * rule belongs in a component, not in a settings panel, and no game has a level-wide *value* yet.
   *
   * Reassigning lives here rather than on the toolbar picker, deliberately: the picker is the authoring
   * context, and retagging a level is an edit with consequences — its components are validated against the new
   * game's registry — so it belongs where those consequences are in front of you.
   */
  const addGameSection = (doc: Doc): void => {
    if (doc.mode === 'prefab') {
      addSection('@game', { title: 'Game' }).row('', 'a prefab belongs to no game')
      return
    }
    const section = addSection('@game', { title: 'Game' })
    const ref = doc.modeRef()
    const installed = host.games()

    const options: Record<string, string> = { '(none)': '' }
    for (const g of installed) options[g.label] = g.name
    // A game the level names but this build does not have is offered as itself, so selecting something else is
    // a deliberate change rather than the only thing the dropdown will let you do.
    if (ref !== undefined && !installed.some((g) => g.name === ref.name)) options[`${ref.name} (not installed)`] = ref.name

    const pick = { game: ref?.name ?? '' }
    section
      .pane()
      .addBinding(pick, 'game', { label: 'game', options })
      .on('change', () => {
        edited(() => doc.setMode(pick.game === '' ? null : pick.game))
        host.onModeChanged()
      })

    if (ref === undefined) section.row('', 'unassigned — its components are checked against everything this build knows')
    else if (!installed.some((g) => g.name === ref.name)) section.row('', `'${ref.name}' is not installed: no rules, no rule gizmos`)

    addBoundsSection(doc)

    // The game's numbers (ADR 0087): one field per declaration, saved to the game's data file on change.
    const settings = host.settings()
    if (settings === null) return
    const numbers: Record<string, number> = {}
    for (const [k, v] of Object.entries(settings.values)) if (typeof v === 'number') numbers[k] = v
    const tuning = addSection('@game-settings', { title: 'Game settings' })
    for (const [key, decl] of Object.entries(settings.decls)) {
      if (isCurveSetting(decl)) {
        // A curve gets its own section: a graph is not a row (ADR 0088).
        const sec = addSection(`@game-curve-${key}`, { title: decl.label })
        const pts = settings.values[key]
        const holder = sec.row('', '')
        holder.replaceChildren()
        createCurveEditor(holder, { decl, points: Array.isArray(pts) ? pts : decl.default, onChange: (points) => host.onSettingChanged(key, points) })
        if (decl.hint !== undefined) sec.row('', decl.hint)
        continue
      }
      const opts: { label: string; min?: number; max?: number; step?: number } = { label: decl.label }
      if (decl.min !== undefined) opts.min = decl.min
      if (decl.max !== undefined) opts.max = decl.max
      if (decl.step !== undefined) opts.step = decl.step
      tuning
        .pane()
        .addBinding(numbers, key, opts)
        .on('change', (ev) => {
          if (ev.last) host.onSettingChanged(key, numbers[key] ?? decl.default)
        })
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
    const state = { metres: own ?? QUANT_BOUND, box: host.boundsBoxShown() }
    const sec = addSection('@net-bounds', { title: 'Network bounds' })

    sec
      .pane()
      .addBinding(state, 'metres', { min: 10, max: 20000, step: 10, label: 'reach ±m' })
      .on('change', (ev) => {
        if (!ev.last) return
        doc.setNetBounds(state.metres)
        host.onNetBoundsChanged()
      })
    // The whole trade in one line: a u16 an axis, so the step is the range over 65535.
    sec.row('step', `${(((2 * state.metres) / 65535) * 100).toFixed(1)} cm between positions a peer can be at`)

    sec
      .pane()
      .addBinding(state, 'box', { label: 'show box' })
      .on('change', () => host.showBoundsBox(state.box))

    const reach = host.boundsReach()
    if (reach === null) sec.row('', 'nothing loaded')
    else if (reach.outside > 0) {
      sec.row('outside', `${reach.outside} object${reach.outside === 1 ? '' : 's'} past the bound — peers out there stop moving for everyone else`)
      sec.row('', `the level reaches ${Math.ceil(reach.reach)} m`)
    } else sec.row('fits', `the level reaches ${Math.ceil(reach.reach)} m of ${state.metres}`)

    if (own === undefined) sec.row('', `unset — using the platform default of ${QUANT_BOUND} m`)
    else {
      const back = el('button', 'ctl', `use the default (${QUANT_BOUND} m)`)
      back.addEventListener('click', () => {
        doc.setNetBounds(null)
        host.onNetBoundsChanged()
      })
      sec.row('', '').replaceChildren(back)
    }
  }

  const addEnvironmentSections = (doc: Doc): void => {
    if (doc.mode === 'prefab') {
      addSection('@env', { title: 'Environment' }).row('', 'a prefab has no environment of its own')
      return
    }

    /**
     * The three blocks are written back **together**, because they are one field on the level and because they
     * are coupled: the sun's angles move the sky's glow, and `ambient` is the strength of the map the sky bakes
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

    const sunSection = addSection('@env-sun', { title: 'Sun' })
    sunSection.pane().addBinding(sun, 'elevation', { min: 1, max: 89, step: 1, label: 'elevation °' }).on('change', write)
    sunSection.pane().addBinding(sun, 'azimuth', { min: -180, max: 180, step: 1, label: 'azimuth °' }).on('change', write)
    sunSection.pane().addBinding(sun, 'intensity', { min: 0, max: 10, step: 0.05, label: 'intensity' }).on('change', write)
    sunSection.pane().addBinding(sun, 'color', { label: 'colour' }).on('change', write)
    sunSection.pane().addBinding(sun, 'shadows', { label: 'shadows' }).on('change', write)
    sunSection.row('', 'elevation and azimuth also move the sky')

    /**
     * The sky's own light, and the reason it needs a control: it is image-based, not a light object, so turning
     * every light off leaves it lighting the scene. At 1 this sky's irradiance is blue twenty-one times red.
     */
    const ambientSection = addSection('@env-ambient', { title: 'Ambient' })
    ambientSection.pane().addBinding(ambient, 'intensity', { min: 0, max: 1.5, step: 0.01, label: 'from the sky' }).on('change', write)
    ambientSection.row('', 'the sky lighting the level, not a light')

    const skySection = addSection('@env-sky', { title: 'Sky' })
    skySection.pane().addBinding(sky, 'topColor', { label: 'top' }).on('change', write)
    skySection.pane().addBinding(sky, 'bottomColor', { label: 'bottom' }).on('change', write)
    skySection.pane().addBinding(sky, 'gradientBias', { min: 0.3, max: 3, step: 0.05, label: 'ramp bias' }).on('change', write)
    skySection.pane().addBinding(sky, 'gain', { min: 0.1, max: 6, step: 0.05, label: 'gain' }).on('change', write)
    skySection.pane().addBinding(sky, 'glowColor', { label: 'sun tint' }).on('change', write)
    skySection.pane().addBinding(sky, 'glowStrength', { min: 0, max: 2, step: 0.01, label: 'glow' }).on('change', write)
    skySection.pane().addBinding(sky, 'glowSharpness', { min: 4, max: 600, step: 4, label: 'glow tight' }).on('change', write)
    skySection.pane().addBinding(sky, 'sunDiskIntensity', { min: 0, max: 2000, step: 10, label: 'sun disc' }).on('change', write)

    /**
     * The passes over the finished image. Here rather than in a preferences dialogue because they are the
     * level's: occlusion is most of what gives greybox its form, and both are tuned against the light above.
     *
     * These were hardcoded per app and had drifted — the editor asked for a stronger bloom than the game — so
     * the viewport was not showing what you would play.
     */
    const fxSection = addSection('@env-postfx', { title: 'Post-FX' })
    fxSection.pane().addBinding(postfx, 'ao', { label: 'ambient occl.' }).on('change', write)
    fxSection.pane().addBinding(postfx, 'bloom', { label: 'bloom' }).on('change', write)
    fxSection.pane().addBinding(postfx, 'bloomStrength', { min: 0, max: 1.5, step: 0.05, label: 'bloom str' }).on('change', write)
    fxSection.row('', 'bloom only fires on emissive materials')

    /**
     * The game camera (ADR 0148). Its own field on the level rather than part of `environment`, which is what
     * the renderer lights and draws with; this is what the camera does about a wall.
     */
    const camera = { seeThrough: doc.cameraSeeThrough() }
    const camSection = addSection('@env-camera', { title: 'Camera' })
    camSection
      .pane()
      .addBinding(camera, 'seeThrough', { label: 'see through' })
      .on('change', () => doc.setCameraSeeThrough(camera.seeThrough))
    camSection.row('', 'on: a wall in the way gets a hole · off: it stops the camera')
  }

  /** Every rebuild re-learns which move steps are open, and tells the viewport (ADR 0144). */
  const rebuild = (): void => {
    shownMoves = []
    build()
    host.pointsChanged()
  }

  const build = (): void => {
    // A popover belongs to the panel it came from; the new one opens its own again if it should.
    closePopover()
    for (const pane of panes) pane.dispose()
    panes = []
    transformPane = null
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

    addOverrideStrip(doc, at)
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
    addFooter(doc, at)
    sync()
  }

  return { rebuild, sync, renderHead, openPoint }
}
