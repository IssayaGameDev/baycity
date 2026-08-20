import { vec3, type Vec3 } from '@mp/core'
import { Pane } from 'tweakpane'

import { DEFAULT_BUMPER_POWER, type Doc, type ItemProps, type TriggerChoice } from './editorDoc'

/**
 * The Inspector panel — transform, material, trigger, and the prefab actions.
 *
 * Still Tweakpane, deliberately: a property grid of labelled numbers with point-and-drag editing is
 * exactly what it is good at, and `PaneConfig.container` mounts it inside a real panel. What changed is
 * scope. It used to *be* the editor, so its one weakness — conditional fields can only be expressed by
 * disposing every control and re-adding them — took the whole UI with it: the file picker, the palette
 * and the play toggle all flickered whenever a behavior dropdown changed. Confined to this panel, the
 * rebuild costs nothing anyone can see.
 *
 * Holds no Three.js: the host reads and writes the selection's transform, so this file knows only about
 * documents and numbers.
 *
 * A piece selected in a level is the shared prefab's, so what this panel writes there is an **override** on
 * that one placement, and the fields that differ from the prefab are listed with a Revert and an Apply
 * (ADR 0033).
 *
 * Holds no *animation* either, since ADR 0029. Motion is a keyframe track, and a track is edited on a
 * timeline — a property grid can only show one instant of it, which is what made the old
 * behavior/direction/travel/cycle form the worst part of this panel. The Animation tab owns it now.
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
  /** Revert one overridden field on the selection, or all of them (ADR 0033). */
  revertOverride: (field?: string) => void
  /** Push the selection's overrides into the shared prefab, so every instance of it follows. */
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

export const createInspector = (head: HTMLElement, container: HTMLElement, host: InspectorHost): Inspector => {
  // No title: the panel's own header names it, and a second collapsible header inside would be noise.
  const pane = new Pane({ container })

  /**
   * The header is ours, not Tweakpane's: Unity's name field is full-width and prominent, and a
   * Tweakpane binding would put it in the 92px label column like any other property.
   */
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'ctl name'
  nameInput.spellcheck = false
  nameInput.title = 'name — blank falls back to what the item is'
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

    // Value = the typed name; placeholder = the fallback, so a clean file shows a sensible name
    // without one being written into the JSON.
    if (document.activeElement !== nameInput) nameInput.value = doc.nameOf(at)
    nameInput.placeholder = doc.label(at)

    const ref = doc.refOf(at)
    linkRow.classList.toggle('linked', ref !== null)
    if (ref !== null) {
      const n = doc.refCount(ref)
      linkWho.textContent = `prefab: ${ref} · ${n} instance${n === 1 ? '' : 's'}`
      linkButton.textContent = 'Open'
      linkButton.title = 'edit the shared definition — every instance follows'
      linkButton.onclick = host.openPrefab
      linkButton.hidden = false
    } else if (doc.mode === 'level') {
      linkWho.textContent = 'not linked to a prefab'
      linkButton.textContent = 'Extract'
      linkButton.title = 'promote this one-off into a shared prefab'
      linkButton.onclick = host.extract
      linkButton.hidden = false
    } else {
      linkWho.textContent = 'piece of this prefab'
      linkButton.hidden = true
    }
  }

  const sel: TransformValues = { position: vec3(0, 0, 0), rotationDeg: vec3(0, 0, 0), scale: vec3(1, 1, 1) }
  const prop = {
    trigger: 'none' as TriggerChoice,
    bumperPower: DEFAULT_BUMPER_POWER,
    material: '',
  }

  let blades: { dispose: () => void }[] = []

  /**
   * True while `sync` is pushing values *into* the pane, so a refresh is not mistaken for a person typing.
   *
   * Tweakpane's `refresh()` calls `fetch()`, which assigns `rawValue` — and that emits `change` exactly as a
   * keystroke does. So `sync()` fires every handler registered below it. During a gizmo drag that meant each
   * frame's refresh re-entered `writeTransform`, which re-posed the item from the document and threw away the
   * drag's starting snapshot; a multi-selection then stopped following the primary after the first frame, and a
   * small rotation was rounded to zero and snapped back. There is no option to suppress it, so the guard is
   * here, where the code knows it is the one writing.
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

  const applyProps = (): void => {
    if (syncing()) return
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null) return
    const p: ItemProps = {
      pieceLevel: doc.mode === 'prefab',
      trigger: prop.trigger,
      bumperPower: prop.bumperPower,
      material: prop.material,
    }
    doc.setProps(at, p)
    host.onPropsChanged()
  }

  const rebuild = (): void => {
    for (const b of blades) b.dispose()
    blades = []
    renderHead()
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null) return

    // Building a binding reads its target, which can emit `change` before anything is user-driven. A depth
    // counter rather than a flag, because `sync` below runs inside this span and clears its own; and `finally`
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
    const p = doc.props(at)
    prop.trigger = p.trigger
    prop.bumperPower = p.bumperPower
    prop.material = p.material

    const pos = { step: 0.1 }
    const rot = { step: 1 }
    const scl = { step: 0.05 }
    blades.push(
      pane.addBinding(sel, 'position', { label: 'position', x: pos, y: pos, z: pos }).on('change', applyTransform),
      pane.addBinding(sel, 'rotationDeg', { label: 'rotation °', x: rot, y: rot, z: rot }).on('change', applyTransform),
      pane.addBinding(sel, 'scale', { label: 'scale', x: scl, y: scl, z: scl }).on('change', applyTransform),
    )

    // Material is editable either way — the piece's own inside a prefab, an instance-wide override in a
    // level. Both levels, because the override is the only per-placement visual there is, and until now
    // the capable system (materials) was the one you could not override while the weak one (styles) was
    // (ADR 0028). A trigger belongs to a piece's collider, so it is only offered where pieces are edited.
    blades.push(
      pane
        .addBinding(prop, 'material', { label: p.pieceLevel ? 'material' : 'material override', options: host.materials() })
        .on('change', applyProps),
    )
    if (p.pieceLevel) {
      blades.push(
        pane
          .addBinding(prop, 'trigger', {
            label: 'trigger',
            options: { none: 'none', checkpoint: 'checkpoint', goal: 'goal', hazard: 'hazard', bumper: 'bumper' },
          })
          .on('change', () => {
            applyProps()
            rebuild() // show or hide the bumper's own field
          }),
      )
      // A trigger kind that carries a parameter is why the schema stopped being a bare string (ADR 0032). The
      // field only exists while `bumper` is chosen, which is the conditional-field pattern this panel has
      // always had to express by rebuilding.
      if (prop.trigger === 'bumper') {
        blades.push(
          pane
            .addBinding(prop, 'bumperPower', { label: 'launch (m/s)', step: 1, min: 1, max: 60 })
            .on('change', applyProps),
        )
      }
    }

    // ---- prefab overrides (ADR 0033) --------------------------------------------------------------------
    /**
     * A piece belongs to the shared prefab, so an edit here is an **override** on this one placement. The
     * fields that differ are listed, because the alternative is a panel that cannot tell you whether the
     * number you are reading is this object's or every object's — and that is the whole reason Unity bolds
     * an overridden label.
     *
     * Listed rather than marked in place: Tweakpane owns its label markup, so bolding one would mean reaching
     * into its DOM. A list of names with the two actions beside it says the same thing and cannot break when
     * Tweakpane's internals change.
     */
    const overridden = doc.overridesOf(at)
    if (overridden.length > 0) {
      blades.push(
        pane.addBlade({ view: 'text', label: 'overridden', parse: (v: string) => v, value: overridden.join(', '), disabled: true }) as {
          dispose: () => void
        },
      )
      blades.push(
        pane.addButton({ title: 'Revert to prefab' }).on('click', () => host.revertOverride()),
        pane.addButton({ title: 'Apply to prefab (all instances)' }).on('click', host.applyOverrides),
      )
    } else if (p.pieceLevel && doc.mode === 'level') {
      blades.push(
        pane.addBlade({ view: 'text', label: 'overridden', parse: (v: string) => v, value: 'nothing — matches the prefab', disabled: true }) as {
          dispose: () => void
        },
      )
    }

    // Open/Extract live in the header's prefab-link row, where Unity puts them.
    blades.push(
      pane.addButton({ title: 'Duplicate (Ctrl+D)' }).on('click', host.duplicate),
      pane.addButton({ title: 'Delete (Del)' }).on('click', host.remove),
    )
  }

  return { rebuild, sync, renderHead }
}
