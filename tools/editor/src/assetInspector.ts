import { assetsOfKind, type AssetDatabase, type AssetEntry, type MaterialAsset, type MaterialValue } from '@mp/content'
import { BUILTIN_SHADERS, defaultParams, shaderDef, type ShaderParam } from '@mp/render-three'

import { checkField, colorFieldOf, fieldRow, numberScrub, scrubFieldOf, selectField, type Live } from './controls'
import { initials } from './people'

/**
 * The Inspector, when what is selected is an **asset** rather than something in the scene.
 *
 * For a material this is a generic editor: it reads the parameter list off the **shader** and renders a
 * field per entry. Nothing here knows what "roughness" is, which is the point — adding a normal map to the
 * standard shader, or bringing a custom shader with its own uniforms, changes no code in this file.
 *
 * Its fields are the editor's own controls (`controls.ts`, ADR 0152), on the object Inspector's lines: a number
 * dragged sideways or typed, a colour swatch and its code, a dropdown, a tick box. A texture slot is a dropdown
 * with a thumbnail beside it.
 */
export interface AssetInspectorHost {
  db: () => AssetDatabase | null
  urlOf: (path: string) => string
  materialOf: (assetId: string) => MaterialAsset | undefined
  /**
   * An edit: the material as it now should be. The caller turns it into ops on its live document and an undo entry
   * named `label` (ADR 0159); `ongoing` while a colour or a number is still being dragged, so the drag is one entry.
   */
  onMaterialChanged: (assetId: string, material: MaterialAsset, label: string, ongoing?: boolean) => void
  /**
   * The others who have this asset open (ADR 0159), each in their colour — the colour of their icon in the top bar
   * and their outline in the viewport (ADR 0155). Any kind of asset.
   */
  openers?: (assetId: string) => readonly { name: string; colour: string }[]
}

export interface AssetInspector {
  /** Draw `assetId`, or clear the panel when `null`. */
  show: (assetId: string | null) => void
  /**
   * The asset changed underneath — someone else's edit, or one of this tab's refused (ADR 0159): its values
   * follow, in place, except in the field being worked in. A new shader redraws the panel, whose fields are
   * the shader's.
   */
  refresh: (assetId: string) => void
  /** Who has which asset open changed: the icons on the one shown redraw, and nothing else does. */
  openersChanged: () => void
}

/** A line's controls, and how to show a value in them without redrawing them. */
interface Field {
  controls: HTMLElement[]
  update: (v: MaterialValue) => void
}

/** A parameter's edit: its new value, and whether a drag is still adding to it. */
type Change = (v: MaterialValue, ongoing?: boolean) => void

/** Whether the keyboard is in this control right now: its value is the person's, not ours. */
const busy = (control: HTMLElement): boolean => control.contains(document.activeElement)

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  return node
}

/**
 * A drag's writes, as one undo entry: each step is `ongoing`, and letting go ends the entry — `settle` writes
 * nothing, so a drag that let go where it started cannot put back a value someone else has changed since. The
 * commit after a drag is the value already written; a typed value is the commit alone.
 */
const dragged = <T>(change: (v: T, ongoing: boolean) => void, settle: () => void): { live: Live<T>; commit: (v: T) => void } => ({
  live: {
    start: () => undefined,
    move: (v) => change(v, true),
    end: settle,
  },
  commit: (v) => change(v, false),
})

export const createAssetInspector = (container: HTMLElement, host: AssetInspectorHost): AssetInspector => {
  /** A dropdown over textures, and a thumbnail of the current choice beside it. */
  const textureField = (current: string | null, onPick: (id: string | null) => void): Field => {
    const db = host.db()
    const choices = [{ value: '', label: '(none)' }, ...(db === null ? [] : assetsOfKind(db, 'texture')).map((t) => ({ value: t.id, label: t.name }))]
    // The thumbnail follows the pick itself: the panel is not redrawn after an edit (ADR 0157).
    const img = el('img', 'a-thumb')
    img.alt = ''
    const showThumb = (id: string | null): void => {
      const entry = id === null ? undefined : db?.byId[id]
      img.hidden = entry === undefined
      if (entry !== undefined) img.src = host.urlOf(entry.path)
    }
    showThumb(current)
    const select = selectField(choices, current ?? '', (v) => {
      const id = v === '' ? null : v
      showThumb(id)
      onPick(id)
    })
    return {
      controls: [img, select],
      update: (v) => {
        if (v.kind !== 'texture' || busy(select)) return
        select.value = v.value ?? ''
        showThumb(v.value)
      },
    }
  }

  /** `settle`: a drag let go — end its undo entry, writing nothing. */
  const valueField = (param: ShaderParam, value: MaterialValue, onChange: Change, settle: () => void): Field => {
    if (param.kind === 'color') {
      const w = dragged<string>((v, ongoing) => onChange({ kind: 'color', value: v }, ongoing), settle)
      const field = colorFieldOf(value.kind === 'color' ? value.value : '#ffffff', w.commit, w.live)
      return { controls: [field.root], update: (v) => void (v.kind === 'color' && field.set(v.value)) }
    }
    if (param.kind === 'number') {
      const w = dragged<number>((v, ongoing) => onChange({ kind: 'number', value: v }, ongoing), settle)
      const field = scrubFieldOf({
        value: value.kind === 'number' ? value.value : 0,
        spec: numberScrub(param),
        title: param.label,
        commit: w.commit,
        live: w.live,
      })
      return { controls: [field.root], update: (v) => void (v.kind === 'number' && field.set(v.value)) }
    }
    if (param.kind === 'vec2') {
      // Its own latest, so an x then a y keeps the x: the panel is not redrawn between them (ADR 0157).
      let v = value.kind === 'vec2' ? value.value : { x: 1, y: 1 }
      const axes = (['x', 'y'] as const).map((axis) => {
        const w = dragged<number>((n, ongoing) => {
          v = { ...v, [axis]: n }
          onChange({ kind: 'vec2', value: v }, ongoing)
        }, settle)
        return scrubFieldOf({ value: v[axis], label: axis.toUpperCase(), spec: numberScrub({ step: 0.1 }), title: `${param.label} ${axis}`, commit: w.commit, live: w.live })
      })
      return {
        controls: axes.map((a) => a.root),
        update: (next) => {
          if (next.kind !== 'vec2') return
          v = next.value
          axes[0]!.set(v.x)
          axes[1]!.set(v.y)
        },
      }
    }
    if (param.kind === 'boolean') {
      const box = checkField(value.kind === 'boolean' ? value.value : false, (on) => onChange({ kind: 'boolean', value: on }), param.label)
      return { controls: [box], update: (v) => void (v.kind === 'boolean' && !busy(box) && (box.checked = v.value)) }
    }
    if (param.kind === 'texture') {
      return textureField(value.kind === 'texture' ? value.value : null, (id) => onChange({ kind: 'texture', value: id }))
    }
    const unsupported = el('span', 'irow-v')
    unsupported.textContent = `(${param.kind} not editable yet)`
    return { controls: [unsupported], update: () => undefined }
  }

  /** The asset in the header, and where its openers' icons go. */
  let head: { assetId: string; slot: HTMLElement } | null = null
  const drawOpeners = (): void => {
    if (head === null) return
    const openers = host.openers?.(head.assetId) ?? []
    head.slot.replaceChildren(
      ...openers.map((o) => {
        const icon = el('span', 'pp')
        icon.textContent = initials(o.name)
        icon.style.setProperty('--pc', o.colour)
        icon.title = `${o.name} has this open`
        return icon
      }),
    )
  }

  /** What the panel shows now, for `refresh`: which material, drawn with which shader, and its fields by key. */
  let drawn: { assetId: string; shader: string; fields: Map<string, { field: Field; fallback: MaterialValue }> } | null = null

  const showMaterial = (entry: AssetEntry, material: MaterialAsset): void => {
    const def = shaderDef(material.shader)
    /**
     * The material as it is now, not as it was drawn: the panel stays up across edits (ADR 0157), so an edit
     * made from the drawn copy would put back every field changed since.
     */
    const now = (): MaterialAsset => host.materialOf(entry.id) ?? material

    // Whatever the material names stays offered even if nothing is registered under it, so opening a
    // material with a missing shader does not silently rewrite it to `standard` on the first edit.
    const names = [...new Set([...BUILTIN_SHADERS, material.shader])]
    const shaderSelect = selectField(
      names.map((n) => ({ value: n, label: shaderDef(n) === undefined ? `${n} (missing)` : n })),
      material.shader,
      (next) => {
        const nextDef = shaderDef(next)
        // Keep any parameter the new shader also declares; fill the rest from its defaults.
        const kept: Record<string, MaterialValue> = nextDef === undefined ? {} : defaultParams(nextDef)
        for (const [key, v] of Object.entries(now().params)) if (key in kept) kept[key] = v
        host.onMaterialChanged(entry.id, { shader: next, params: kept }, `${entry.name} shader`)
      },
    )
    container.append(fieldRow('shader', shaderSelect))

    if (def === undefined) {
      const warn = el('div', 'a-warn')
      warn.textContent = `No shader registered as "${material.shader}" — rendering falls back to standard.`
      container.append(warn)
      return
    }

    const fields = new Map<string, { field: Field; fallback: MaterialValue }>()
    for (const param of def.params) {
      const value = material.params[param.key] ?? param.fallback
      const label = `${entry.name} ${param.label}`
      const field = valueField(
        param,
        value,
        (next, ongoing) => {
          const current = now()
          host.onMaterialChanged(entry.id, { ...current, params: { ...current.params, [param.key]: next } }, label, ongoing)
        },
        () => host.onMaterialChanged(entry.id, now(), label, false),
      )
      fields.set(param.key, { field, fallback: param.fallback })
      container.append(fieldRow(param.label, ...field.controls))
    }
    drawn = { assetId: entry.id, shader: material.shader, fields }
  }

  const show = (assetId: string | null): void => {
    container.replaceChildren()
    drawn = null
    head = null
    if (assetId === null) return
    const entry = host.db()?.byId[assetId]
    if (entry === undefined) return

    const header = el('div', 'a-head')
    const top = el('div', 'a-top')
    const name = el('div', 'a-name')
    name.textContent = entry.name
    const openers = el('div', 'a-openers')
    top.append(name, openers)
    const meta = el('div', 'a-meta')
    // The id is worth showing: it is what content stores, so it is what appears in a level file.
    meta.textContent = `${entry.kind} · ${entry.path} · ${entry.id}`
    header.append(top, meta)
    container.append(header)
    head = { assetId, slot: openers }
    drawOpeners()

    if (entry.kind !== 'material') return
    const material = host.materialOf(assetId)
    if (material === undefined) {
      const warn = el('div', 'a-warn')
      warn.textContent = 'This material did not parse.'
      container.append(warn)
      return
    }
    showMaterial(entry, material)
  }

  const refresh = (assetId: string): void => {
    if (drawn === null || drawn.assetId !== assetId) return
    const material = host.materialOf(assetId)
    if (material === undefined || material.shader !== drawn.shader) {
      show(assetId)
      return
    }
    for (const [key, { field, fallback }] of drawn.fields) field.update(material.params[key] ?? fallback)
  }

  return { show, refresh, openersChanged: drawOpeners }
}
