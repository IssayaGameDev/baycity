import { vec3, type Vec3 } from '@mp/core'
import { Pane } from 'tweakpane'

import type { BehaviorKind, Doc, ItemProps, TriggerChoice } from './editorDoc'

/**
 * The Inspector panel — transform, style, trigger, behavior, and the prefab actions.
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
  /** Style palette keys, in the order they should be offered. */
  styles: readonly string[]
}

export interface Inspector {
  /** Selection changed, or the set of relevant fields did — rebuild the controls. */
  rebuild: () => void
  /** The gizmo moved the selection — refresh the numbers without rebuilding. */
  sync: () => void
  /** Redraw just the name + prefab link (e.g. after an Extract changed the link). */
  renderHead: () => void
}

/** Cardinal axes offered for a behavior, so the common cases need no vector typing. */
const DIRS: Record<string, Vec3> = {
  '+X': vec3(1, 0, 0),
  '-X': vec3(-1, 0, 0),
  '+Y': vec3(0, 1, 0),
  '-Y': vec3(0, -1, 0),
  '+Z': vec3(0, 0, 1),
  '-Z': vec3(0, 0, -1),
}
const DIR_OPTIONS: Record<string, string> = { '+X': '+X', '-X': '-X', '+Y': '+Y', '-Y': '-Y', '+Z': '+Z', '-Z': '-Z', custom: 'custom' }

/** Which cardinal name an axis matches, or `custom` when it is at an angle. */
export const dirNameOf = (a: Vec3): string => {
  const len = Math.hypot(a.x, a.y, a.z) || 1
  const n = vec3(a.x / len, a.y / len, a.z / len)
  for (const [k, v] of Object.entries(DIRS)) if (Math.abs(n.x - v.x) < 1e-3 && Math.abs(n.y - v.y) < 1e-3 && Math.abs(n.z - v.z) < 1e-3) return k
  return 'custom'
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
    behavior: 'static' as BehaviorKind,
    direction: '+Y',
    distance: 3,
    cycleS: 4,
    axis: { x: 0, y: 1, z: 0 },
    style: '',
    trigger: 'none' as TriggerChoice,
  }

  const styleOptions: Record<string, string> = { '(default)': '' }
  for (const k of host.styles) styleOptions[k] = k

  let blades: { dispose: () => void }[] = []

  const sync = (): void => {
    const t = host.readTransform()
    if (t === null) return
    sel.position = vec3(r4(t.position.x), r4(t.position.y), r4(t.position.z))
    sel.rotationDeg = vec3(r4(t.rotationDeg.x), r4(t.rotationDeg.y), r4(t.rotationDeg.z))
    sel.scale = vec3(r4(t.scale.x), r4(t.scale.y), r4(t.scale.z))
    pane.refresh()
  }

  const applyTransform = (): void => {
    host.writeTransform({
      position: sel.position,
      rotationDeg: sel.rotationDeg,
      // A zero scale collapses the collider and makes the shape unrecoverable by dragging.
      scale: vec3(sel.scale.x || 1e-3, sel.scale.y || 1e-3, sel.scale.z || 1e-3),
    })
  }

  const applyProps = (): void => {
    const doc = host.doc()
    const at = host.selected()
    if (doc === null || at === null) return
    const axis = prop.direction === 'custom' ? vec3(prop.axis.x, prop.axis.y, prop.axis.z) : { ...DIRS[prop.direction]! }
    const p: ItemProps = {
      behavior: prop.behavior,
      distance: prop.distance,
      periodMs: Math.max(50, prop.cycleS * 1000),
      axis,
      pieceLevel: doc.mode === 'prefab',
      style: prop.style,
      trigger: prop.trigger,
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

    sync()
    const p = doc.props(at)
    prop.behavior = p.behavior
    prop.distance = p.distance
    prop.cycleS = r4(p.periodMs / 1000)
    prop.axis = { x: p.axis.x, y: p.axis.y, z: p.axis.z }
    prop.direction = dirNameOf(p.axis)
    prop.style = p.style
    prop.trigger = p.trigger

    const pos = { step: 0.1 }
    const rot = { step: 1 }
    const scl = { step: 0.05 }
    blades.push(
      pane.addBinding(sel, 'position', { label: 'position', x: pos, y: pos, z: pos }).on('change', applyTransform),
      pane.addBinding(sel, 'rotationDeg', { label: 'rotation °', x: rot, y: rot, z: rot }).on('change', applyTransform),
      pane.addBinding(sel, 'scale', { label: 'scale', x: scl, y: scl, z: scl }).on('change', applyTransform),
    )

    // Style is editable either way — the piece's own inside a prefab, an override on an instance. A
    // trigger belongs to a piece's collider, so it is only offered where pieces are what's being edited.
    blades.push(pane.addBinding(prop, 'style', { label: p.pieceLevel ? 'style' : 'style override', options: styleOptions }).on('change', applyProps))
    if (p.pieceLevel) {
      blades.push(
        pane
          .addBinding(prop, 'trigger', { label: 'trigger', options: { none: 'none', checkpoint: 'checkpoint', goal: 'goal', hazard: 'hazard' } })
          .on('change', applyProps),
      )
    }

    blades.push(
      pane.addBinding(prop, 'behavior', { label: 'behavior', options: { static: 'static', move: 'move', rotate: 'rotate' } }).on('change', () => {
        applyProps()
        rebuild() // show/hide the behavior params
      }),
    )
    if (prop.behavior === 'move' || prop.behavior === 'rotate') {
      blades.push(
        pane.addBinding(prop, 'direction', { label: 'direction', options: DIR_OPTIONS }).on('change', () => {
          if (prop.direction !== 'custom') {
            const v = DIRS[prop.direction]!
            prop.axis = { x: v.x, y: v.y, z: v.z }
          }
          applyProps()
          rebuild() // reveal/hide the custom-axis field
        }),
      )
      if (prop.direction === 'custom') {
        const a = { step: 0.1 }
        blades.push(pane.addBinding(prop, 'axis', { label: 'axis', x: a, y: a, z: a }).on('change', applyProps))
      }
      if (prop.behavior === 'move') blades.push(pane.addBinding(prop, 'distance', { step: 0.1, label: 'travel (m)' }).on('change', applyProps))
      blades.push(pane.addBinding(prop, 'cycleS', { step: 0.1, label: 'cycle (s)' }).on('change', applyProps))
    }

    // Open/Extract live in the header's prefab-link row, where Unity puts them.
    blades.push(
      pane.addButton({ title: 'Duplicate (Ctrl+D)' }).on('click', host.duplicate),
      pane.addButton({ title: 'Delete (Del)' }).on('click', host.remove),
    )
  }

  return { rebuild, sync, renderHead }
}
