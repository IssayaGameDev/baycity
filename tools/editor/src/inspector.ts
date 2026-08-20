import { vec3, type Vec3 } from '@mp/core'
import type { ColliderDesc } from '@mp/content'
import type { ParamSpec } from '@mp/components'
import { Pane } from 'tweakpane'

import type { ComponentView, Doc } from './editorDoc'

/**
 * The Inspector panel — transform, then **one section per component**, with the fields generated from each
 * component's declared parameters (PLAN-component-system, stage C1).
 *
 * Nothing in here knows what a bumper is. It reads `registry.get(type).params`, maps each declaration to a
 * control, and writes values back by key. That is the whole point of declaring parameters instead of
 * reflecting them: adding a component type puts its fields in this panel without touching this file, where
 * the `trigger` field it replaces needed five separate edits here (a state field, a write-back, a read-back,
 * a picker entry, and a conditional block for the one kind that carried a number).
 *
 * Still Tweakpane, deliberately: a property grid of labelled numbers with point-and-drag editing is exactly
 * what it is good at, and `PaneConfig.container` mounts it inside a real panel. Its one weakness — a
 * conditional field can only be expressed by disposing the controls and re-adding them — is now confined to
 * this panel, where the rebuild costs nothing anyone can see.
 *
 * Holds no Three.js: the host reads and writes the selection's transform, so this file knows only about
 * documents and numbers. Holds no *animation* either (ADR 0029): a track is edited on the timeline, and a
 * property grid can only show one instant of it.
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
  /** Material assets to offer, as Tweakpane options (label → asset id; `''` for none). */
  materials: () => Record<string, string>
  /** Model assets to offer, same shape. */
  models: () => Record<string, string>
  /** Revert one override on the selection, or all of them. */
  revertOverride: (field?: string) => void
  /** Push the selection's overrides into the shared prefab, so every placement of it follows. */
  applyOverrides: () => void
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

/** What Tweakpane calls a disposable. Folders dispose their own contents, so only the folder is tracked. */
interface Disposable {
  dispose: () => void
}

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

export const createInspector = (head: HTMLElement, container: HTMLElement, host: InspectorHost): Inspector => {
  // No title: the panel's own header names it, and a second collapsible header inside would be noise.
  const pane = new Pane({ container })

  /**
   * The header is ours, not Tweakpane's: Unity's name field is full-width and prominent, and a Tweakpane
   * binding would put it in the 92px label column like any other property.
   */
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'ctl name'
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

  const linkRow = document.createElement('div')
  linkRow.className = 'link'
  const linkWho = document.createElement('span')
  linkWho.className = 'who'
  const linkButton = document.createElement('button')
  linkButton.className = 'ctl'
  linkRow.append(linkWho, linkButton)
  head.append(nameInput, linkRow)

  /** Name + prefab link. Separate from `rebuild` so renaming does not tear down the property grid. */
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

  let blades: Disposable[] = []

  /**
   * True while `sync` (or a build) is pushing values *into* the pane, so a refresh is not mistaken for a
   * person typing.
   *
   * Tweakpane's `refresh()` calls `fetch()`, which assigns `rawValue` — and that emits `change` exactly as a
   * keystroke does. So `sync()` fires every handler registered below it. During a gizmo drag that meant each
   * frame's refresh re-entered `writeTransform`, which re-posed the item from the document and threw away the
   * drag's starting snapshot; a multi-selection then stopped following the primary after the first frame. There
   * is no option to suppress it, so the guard is here, where the code knows it is the one writing.
   */
  let syncDepth = 0
  const syncing = (): boolean => syncDepth > 0

  const sync = (): void => {
    const t = host.readTransform()
    if (t === null) return
    sel.position = vec3(r4(t.position.x), r4(t.position.y), r4(t.position.z))
    sel.rotationDeg = vec3(r4(t.rotationDeg.x), r4(t.rotationDeg.y), r4(t.rotationDeg.z))
    sel.scale = vec3(r4(t.scale.x), r4(t.scale.y), r4(t.scale.z))
    syncDepth++
    try {
      pane.refresh()
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

  /** A change a person made, as opposed to one `sync` pushed in. */
  const edited = (write: () => void): void => {
    if (syncing()) return
    write()
    host.onPropsChanged()
  }

  /**
   * One control per declared parameter.
   *
   * `state` is the component's values, completed with the declaration's defaults so a parameter added to a
   * component still has something to bind to in a level authored before it existed.
   */
  const addParam = (
    folder: { addBinding: Pane['addBinding']; addBlade: Pane['addBlade'] },
    doc: Doc,
    at: number,
    view: ComponentView,
    state: Record<string, unknown>,
    key: string,
    spec: ParamSpec,
  ): void => {
    const label = spec.label ?? key
    const overridden = view.overridden.includes(key)
    // Tweakpane owns its label markup, so an overridden parameter is marked by a leading dot rather than by
    // reaching into its DOM — the same reasoning that kept the override list a list (ADR 0033).
    const shown = overridden ? `• ${label}` : label
    const write = (patch: Record<string, unknown>): void => edited(() => doc.setParams(at, view.id, patch))

    switch (spec.kind) {
      case 'number': {
        const opts: Record<string, unknown> = { label: shown }
        if (spec.step !== undefined) opts.step = spec.step
        if (spec.min !== undefined) opts.min = spec.min
        if (spec.max !== undefined) opts.max = spec.max
        folder.addBinding(state, key, opts).on('change', () => write({ [key]: state[key] }))
        return
      }
      case 'bool':
      case 'string':
        folder.addBinding(state, key, { label: shown }).on('change', () => write({ [key]: state[key] }))
        return
      case 'enum': {
        const options: Record<string, string> = {}
        for (const o of spec.options) options[o] = o
        folder.addBinding(state, key, { label: shown, options }).on('change', () => {
          write({ [key]: state[key] })
          rebuild() // an enum can gate other fields (a Visual's source picks model or material)
        })
        return
      }
      case 'vec3': {
        const step = { step: 0.1 }
        folder.addBinding(state, key, { label: shown, x: step, y: step, z: step }).on('change', () => write({ [key]: state[key] }))
        return
      }
      case 'asset': {
        const options = spec.of === 'material' ? host.materials() : host.models()
        folder.addBinding(state, key, { label: shown, options }).on('change', () => write({ [key]: state[key] }))
        return
      }
      case 'collider': {
        const shape = (state[key] ?? spec.default) as ColliderDesc
        const picker = { kind: shape.kind as string }
        folder.addBinding(picker, 'kind', { label: shown, options: SHAPE_OPTIONS }).on('change', () => {
          write({ [key]: defaultShape(picker.kind, shape) })
          rebuild()
        })
        const dims: Record<string, unknown> = { ...shape }
        const step = { step: 0.05 }
        if (shape.kind === 'box') {
          folder.addBinding(dims, 'halfExtents', { label: 'half extents', x: step, y: step, z: step }).on('change', () =>
            write({ [key]: { kind: 'box', halfExtents: dims.halfExtents } }),
          )
        } else if (shape.kind === 'ball') {
          folder.addBinding(dims, 'radius', { label: 'radius', step: 0.05, min: 0.01 }).on('change', () => write({ [key]: { kind: 'ball', radius: dims.radius } }))
        } else if (shape.kind === 'capsule' || shape.kind === 'cylinder') {
          const kind = shape.kind
          const push = (): void => write({ [key]: { kind, halfHeight: dims.halfHeight, radius: dims.radius } })
          folder.addBinding(dims, 'halfHeight', { label: 'half height', step: 0.05, min: 0.01 }).on('change', push)
          folder.addBinding(dims, 'radius', { label: 'radius', step: 0.05, min: 0.01 }).on('change', push)
        } else {
          // A hull is authored by whatever generated it (ADR 0017); there is no useful grid control for a
          // point cloud, so this says what is there and leaves it alone.
          folder.addBlade({ view: 'text', label: 'hull', parse: (v: string) => v, value: `${shape.points.length} points`, disabled: true })
        }
        return
      }
      case 'keys': {
        const keys = Array.isArray(state[key]) ? (state[key] as unknown[]).length : 0
        // The timeline owns keys. A property grid can show one instant of a track, which is exactly the
        // mistake ADR 0029 removed.
        folder.addBlade({ view: 'text', label: shown, parse: (v: string) => v, value: `${keys} keys — edit on the timeline`, disabled: true })
        return
      }
      case 'nodeRef': {
        /**
         * A dropdown of the nodes this one may name, rather than Unity's drag-an-object-into-the-field: the
         * scope is already narrow (`nodeChoices` refuses anything that would author a dangling reference), and
         * a picker cannot express a target the document does not have.
         *
         * `''` is the stored value for "none" so the binding has something to select; the schema's value for
         * it is `null`, and that is what gets written.
         */
        const options: Record<string, string> = { '(none)': '' }
        for (const choice of doc.nodeChoices(at)) options[`${choice.label} · ${choice.id.slice(0, 6)}`] = choice.id
        const current = typeof state[key] === 'string' ? (state[key] as string) : ''
        const pick = { ref: options['(none)'] === current || current === '' ? '' : current }
        folder.addBinding(pick, 'ref', { label: shown, options }).on('change', () => write({ [key]: pick.ref === '' ? null : pick.ref }))
        return
      }
    }
  }

  /** One collapsible section per component: what it is, whether it is on, its fields, and Remove. */
  const addComponent = (doc: Doc, at: number, view: ComponentView): void => {
    const def = doc.registry.get(view.type)
    const title = `${def?.label ?? view.type}${view.added ? ' (added here)' : ''}${view.enabled ? '' : ' — off'}`
    const folder = pane.addFolder({ title, expanded: true })
    blades.push(folder)

    if (def === undefined) {
      // A level authored by a build that had a component this one does not. Saying so beats showing nothing
      // and silently dropping it on the next save.
      folder.addBlade({ view: 'text', label: 'unknown', parse: (v: string) => v, value: `no '${view.type}' in this build`, disabled: true })
      return
    }

    const toggle = { enabled: view.enabled }
    folder.addBinding(toggle, 'enabled', { label: view.overridden.includes('enabled') ? '• enabled' : 'enabled' }).on('change', () =>
      edited(() => doc.setComponentEnabled(at, view.id, toggle.enabled)),
    )

    const state: Record<string, unknown> = { ...doc.registry.defaults(view.type), ...view.params }
    for (const [key, spec] of Object.entries(def.params)) addParam(folder, doc, at, view, state, key, spec)

    folder.addButton({ title: view.inherited ? 'Remove here' : 'Remove' }).on('click', () => {
      doc.removeComponent(at, view.id)
      host.onPropsChanged()
      rebuild()
    })
  }

  const rebuild = (): void => {
    for (const b of blades) b.dispose()
    blades = []
    renderHead()
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null) return

    // Building a binding reads its target, which can emit `change` before anything is user-driven. A depth
    // counter rather than a flag, because `sync` runs inside this span and clears its own; and `finally`
    // rather than a bare decrement, because a leaked count would leave the panel ignoring input for good.
    syncDepth++
    try {
      buildBlades(doc, at)
    } finally {
      syncDepth--
    }
  }

  /** The property grid itself. Split out so the sync guard around it is a single `try`. */
  const buildBlades = (doc: Doc, at: number): void => {
    sync()

    const pos = { step: 0.1 }
    const rot = { step: 1 }
    const scl = { step: 0.05 }
    const marked = (field: string, label: string): string => (doc.overridesOf(at).includes(field) ? `• ${label}` : label)
    blades.push(
      pane.addBinding(sel, 'position', { label: marked('transform', 'position'), x: pos, y: pos, z: pos }).on('change', applyTransform),
      pane.addBinding(sel, 'rotationDeg', { label: 'rotation °', x: rot, y: rot, z: rot }).on('change', applyTransform),
      pane.addBinding(sel, 'scale', { label: 'scale', x: scl, y: scl, z: scl }).on('change', applyTransform),
    )

    for (const view of doc.components(at)) addComponent(doc, at, view)

    /**
     * Add component. A dropdown plus a button rather than a search popup: there are nine types, and a
     * singleton the node already has is simply not offered — which is the honest reading of `canAdd`.
     */
    const addable = doc.registry
      .all()
      .map((d) => d.type)
      .filter((type) => doc.canAdd(at, type))
    if (addable.length > 0) {
      const options: Record<string, string> = {}
      for (const type of addable) options[type] = type
      const pick = { type: addable[0]! }
      blades.push(pane.addBinding(pick, 'type', { label: 'add', options }))
      blades.push(
        pane.addButton({ title: 'Add component' }).on('click', () => {
          doc.addComponent(at, pick.type)
          host.onPropsChanged()
          rebuild()
        }),
      )
    }

    /**
     * What this placement changes about the prefab's node, with the two actions beside it.
     *
     * Listed as well as marked in place: the dots above say *which* field, and this says *how many* and lets
     * one of them be put back without hunting for it.
     */
    if (doc.kindOf(at) === 'inherited') {
      const overridden = doc.overridesOf(at)
      blades.push(
        pane.addBlade({
          view: 'text',
          label: 'overridden',
          parse: (v: string) => v,
          value: overridden.length > 0 ? overridden.join(', ') : 'nothing — matches the prefab',
          disabled: true,
        }) as Disposable,
      )
      if (overridden.length > 0) {
        blades.push(
          pane.addButton({ title: 'Revert to prefab' }).on('click', () => host.revertOverride()),
          pane.addButton({ title: 'Apply to prefab (all placements)' }).on('click', host.applyOverrides),
        )
      }
    }

    // Open/Extract live in the header's prefab-link row, where Unity puts them. Structural actions are
    // refused on an inherited node, so they are not offered there either.
    if (doc.kindOf(at) === 'own') {
      blades.push(
        pane.addButton({ title: 'Duplicate (Ctrl+D)' }).on('click', host.duplicate),
        pane.addButton({ title: 'Delete (Del)' }).on('click', host.remove),
      )
    }
  }

  return { rebuild, sync, renderHead }
}
