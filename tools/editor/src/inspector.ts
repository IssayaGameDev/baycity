import { vec3, type Vec3 } from '@mp/core'
import type { ColliderDesc } from '@mp/content'
import { visibleParams, type AssetSpec, type ParamSpec } from '@mp/components'
import { DEFAULT_SKY_PARAMS } from '@mp/render-three'
import { Pane } from 'tweakpane'

import type { ComponentView, Doc } from './editorDoc'
import type { ContextMenu, MenuItem } from './menu'

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
  /** The level was reassigned to another game: its registry changed, so panels and the world rebuild. */
  onModeChanged: () => void
  /** The environment changed: rebake the sky and relight, since sun, ambient and sky move together. */
  onEnvironmentChanged: () => void
  /** How many objects are selected. The panel edits one and has to say so when there are more. */
  selectionCount: () => number
  /** The selection's current transform, or `null` if there isn't one. */
  readTransform: () => TransformValues | null
  writeTransform: (t: TransformValues) => void
  /** Anything other than the transform changed — meshes and the physics world need rebuilding. */
  onPropsChanged: () => void
  /** The name changed — the hierarchy row and status bar show it. */
  onRenamed: () => void
  duplicate: () => void
  remove: () => void
  extract: () => void
  openPrefab: () => void
  /**
   * Assets of one kind to offer, as Tweakpane options (label → asset id; `''` for none).
   *
   * One accessor keyed by the kind the parameter declares, rather than one per kind: `AssetSpec['of']` is
   * the same list, so a new asset-valued parameter needs nothing here.
   */
  assetOptions: (of: AssetSpec['of']) => Record<string, string>
  /** Open the timeline on this component's keyframe parameter (ADR 0037). */
  editKeys: (componentId: string, param: string) => void
  /** Revert one override — `'transform'`, `'name'`, or a component id — or all of them. */
  revertOverride: (field?: string) => void
  /** Push the selection's overrides into the shared prefab, so every placement of it follows. */
  applyOverrides: () => void
  /**
   * The editor's one context menu (`menu.ts`).
   *
   * Shared rather than built here, so a component's `⋯` and a right-click in the Hierarchy cannot both be open
   * at once, and so dismissal — Escape, a press elsewhere, a scroll, a resize — is written once.
   */
  menu: ContextMenu
}

export interface Inspector {
  /** Selection changed, or the set of relevant fields did — rebuild the controls. */
  rebuild: () => void
  /** The gizmo moved the selection — refresh the numbers without rebuilding. */
  sync: () => void
  /** Redraw just the name + prefab link (e.g. after an Extract changed the link). */
  renderHead: () => void
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

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export const createInspector = (head: HTMLElement, container: HTMLElement, host: InspectorHost): Inspector => {
  /**
   * The header is ours, not Tweakpane's: Unity's name field is full-width and prominent, and a Tweakpane
   * binding would put it in the label column like any other property.
   */
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
  const linkButton = el('button', 'ctl')
  linkRow.append(linkWho, linkButton)
  const multiNote = el('div', 'multi')
  head.append(nameInput, linkRow, multiNote)

  /** Name, prefab link, and the multi-selection note. Separate from `rebuild` so renaming is cheap. */
  const renderHead = (): void => {
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null) {
      head.hidden = true
      return
    }
    head.hidden = false

    // Value = the typed name; placeholder = the fallback, so a clean file shows a sensible name without one
    // being written into the JSON.
    if (document.activeElement !== nameInput) nameInput.value = doc.nameOf(at)
    nameInput.placeholder = doc.label(at)

    // Selecting several and editing one was visible only in the status bar, which is the wrong place to learn
    // that the panel is not showing you everything you picked.
    const count = host.selectionCount()
    multiNote.hidden = count < 2
    multiNote.textContent = count < 2 ? '' : `${count} selected · editing ${doc.label(at)}`

    const ref = doc.refOf(at)
    linkRow.classList.toggle('linked', ref !== null)
    if (ref !== null) {
      const n = doc.refCount(ref)
      linkWho.textContent = `prefab: ${ref} · ${n} placement${n === 1 ? '' : 's'}`
      linkButton.textContent = 'Open'
      linkButton.title = 'edit the shared definition — every placement follows'
      linkButton.onclick = host.openPrefab
      linkButton.hidden = false
    } else if (doc.mode === 'level' && doc.kindOf(at) === 'own') {
      linkWho.textContent = 'not linked to a prefab'
      linkButton.textContent = 'Extract'
      linkButton.title = 'promote this one-off into a shared prefab'
      linkButton.onclick = host.extract
      linkButton.hidden = false
    } else {
      linkWho.textContent = doc.kindOf(at) === 'inherited' ? 'part of a prefab — edits become overrides' : 'part of this prefab'
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
    opts: { title: string; badge?: string; off?: boolean; enable?: (on: boolean) => void; menu?: readonly MenuItem[] },
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
    if (opts.badge !== undefined && opts.badge !== '') header.append(el('span', 'isec-badge', opts.badge))

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
    return { root, pane, row }
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
  ): void => {
    const label = spec.label ?? key
    const write = (patch: Record<string, unknown>): void => edited(() => doc.setParams(at, view.id, patch))
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
        if (spec.step !== undefined) opts.step = spec.step
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
        const step = { step: 0.1 }
        mark(section.pane().addBinding(state, key, { label, x: step, y: step, z: step }).on('change', () => write({ [key]: state[key] })))
        return
      }
      case 'asset': {
        const options = host.assetOptions(spec.of)
        mark(section.pane().addBinding(state, key, { label, options }).on('change', () => write({ [key]: state[key] })))
        return
      }
      case 'collider': {
        const shape = (state[key] ?? spec.default) as ColliderDesc
        const picker = { kind: shape.kind as string }
        mark(
          section.pane().addBinding(picker, 'kind', { label, options: SHAPE_OPTIONS }).on('change', () => {
            write({ [key]: defaultShape(picker.kind, shape) })
            rebuildKeepingScroll()
          }),
        )
        const dims: Record<string, unknown> = { ...shape }
        const step = { step: 0.05 }
        if (shape.kind === 'box') {
          section.pane().addBinding(dims, 'halfExtents', { label: 'half extents', x: step, y: step, z: step }).on('change', () =>
            write({ [key]: { kind: 'box', halfExtents: dims.halfExtents } }),
          )
        } else if (shape.kind === 'ball') {
          section.pane().addBinding(dims, 'radius', { label: 'radius', step: 0.05, min: 0.01 }).on('change', () => write({ [key]: { kind: 'ball', radius: dims.radius } }))
        } else if (shape.kind === 'capsule' || shape.kind === 'cylinder') {
          const kind = shape.kind
          const push = (): void => write({ [key]: { kind, halfHeight: dims.halfHeight, radius: dims.radius } })
          section.pane().addBinding(dims, 'halfHeight', { label: 'half height', step: 0.05, min: 0.01 }).on('change', push)
          section.pane().addBinding(dims, 'radius', { label: 'radius', step: 0.05, min: 0.01 }).on('change', push)
        } else {
          // A hull is authored by whatever generated it (ADR 0017); there is no useful grid control for a
          // point cloud, so this states what is there and leaves it alone.
          section.row('hull', `${shape.points.length} points`)
        }
        return
      }
      case 'keys': {
        const count = Array.isArray(state[key]) ? (state[key] as unknown[]).length : 0
        // The timeline owns keys (ADR 0037). What this owes the reader is how many there are and a way there.
        const row = section.row(label, count === 0 ? 'none yet' : `${count} keys`)
        const go = el('button', 'ctl tiny', count === 0 ? 'Add' : 'Edit')
        go.title = 'open the timeline on these keys'
        go.addEventListener('click', () => host.editKeys(view.id, key))
        row.append(go)
        if (view.overridden.includes(key)) row.classList.add('over')
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

  /** One section per component: header controls, then its visible parameters. */
  const addComponentSection = (doc: Doc, at: number, view: ComponentView): void => {
    const def = doc.registry.get(view.type)
    const inherited = doc.kindOf(at) === 'inherited'
    const overridden = view.overridden.length > 0
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
        label: 'Reset to defaults',
        run: () => {
          edited(() => doc.setParams(at, view.id, { ...doc.registry.defaults(view.type) }))
          rebuildKeepingScroll()
        },
      })
    }
    if (!inherited) {
      items.push({ label: 'Move up', run: () => moveAndRebuild(doc, at, view.id, -1) })
      items.push({ label: 'Move down', run: () => moveAndRebuild(doc, at, view.id, 1) })
    }
    items.push({
      label: inherited ? (view.added ? 'Remove (undo add)' : 'Remove here') : 'Remove',
      run: () => {
        doc.removeComponent(at, view.id)
        host.onPropsChanged()
        rebuildKeepingScroll()
      },
    })

    const section = addSection(view.id, {
      title: def?.label ?? view.type,
      // What used to be spelled into the folder's title string, as a badge that cannot push the name out.
      badge: view.added ? 'added' : overridden ? String(view.overridden.length) : '',
      off: !view.enabled,
      enable: (on) => {
        edited(() => doc.setComponentEnabled(at, view.id, on))
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

    const state: Record<string, unknown> = { ...doc.registry.defaults(view.type), ...view.params }
    const shown = visibleParams(def.params, state)
    syncDepth++
    try {
      for (const key of shown) {
        const spec = def.params[key]
        if (spec !== undefined) addParam(section, doc, at, view, state, key, spec)
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

    const pos = { step: 0.1 }
    const rot = { step: 1 }
    const scl = { step: 0.05 }
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
    const addable = doc.registry
      .all()
      .map((d) => d.type)
      .filter((type) => doc.canAdd(at, type))
    const row = el('div', 'iadd')
    const button = el('button', 'ctl wide', 'Add Component')
    button.disabled = addable.length === 0
    button.title = addable.length === 0 ? 'this object already has one of everything' : 'add a component to this object'
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      openMenu(
        button,
        addable.map((type) => ({
          label: type,
          run: () => {
            const id = doc.addComponent(at, type)
            host.onPropsChanged()
            if (id !== null) shut.delete(id) // what you just added should be open
            rebuildKeepingScroll()
          },
        })),
      )
    })
    row.append(button)
    container.append(row)
  }

  /** The placement-wide override strip, right under the header where it describes what follows. */
  const addOverrideStrip = (doc: Doc, at: number): void => {
    if (doc.kindOf(at) !== 'inherited') return
    const overridden = doc.overridesOf(at)
    const strip = el('div', 'iover')
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
    const write = (): void => {
      doc.setEnvironment({ sun: { ...sun }, ambient: { ...ambient }, sky: { ...sky } })
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
  }

  const rebuild = (): void => {
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
    for (const view of doc.components(at)) addComponentSection(doc, at, view)
    addAddButton(doc, at)
    addFooter(doc, at)
    sync()
  }

  return { rebuild, sync, renderHead }
}
