import { assetsOfKind, type AssetDatabase, type AssetEntry, type MaterialAsset, type MaterialValue } from '@mp/content'
import { BUILTIN_SHADERS, defaultParams, shaderDef, type ShaderParam } from '@mp/render-three'

import { initials } from './people'

/**
 * The Inspector, when what is selected is an **asset** rather than something in the scene.
 *
 * For a material this is a generic editor: it reads the parameter list off the **shader** and renders a
 * field per entry. Nothing here knows what "roughness" is, which is the point — adding a normal map to the
 * standard shader, or bringing a custom shader with its own uniforms, changes no code in this file.
 *
 * Plain DOM rather than Tweakpane: a texture slot needs a thumbnail and an asset picker, which is not a
 * shape Tweakpane has, and the fields are driven by data the shader supplies rather than a fixed layout.
 */
export interface AssetInspectorHost {
  db: () => AssetDatabase | null
  urlOf: (path: string) => string
  materialOf: (assetId: string) => MaterialAsset | undefined
  /**
   * An edit: the material as it now should be. The caller turns it into ops on its live document and an undo entry
   * named `label` (ADR 0159); `ongoing` while a colour is still being dragged, so the drag is one entry.
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

/** A field, and how to show a value in it without redrawing it. */
interface Field {
  el: HTMLElement
  update: (v: MaterialValue) => void
}

/** Whether the pointer or the keyboard is in this control right now: its value is the person's, not ours. */
const busy = (control: HTMLElement): boolean => control.contains(document.activeElement)

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  return node
}

const row = (label: string, control: HTMLElement): HTMLDivElement => {
  const r = el('div', 'a-row')
  const l = el('span', 'a-label')
  l.textContent = label
  r.append(l, control)
  return r
}

export const createAssetInspector = (container: HTMLElement, host: AssetInspectorHost): AssetInspector => {
  /** A picker over textures, plus a thumbnail of the current choice. */
  const textureField = (current: string | null, onPick: (id: string | null) => void): Field => {
    const wrap = el('div', 'a-texture')
    const db = host.db()
    const select = el('select', 'ctl')
    const none = el('option')
    none.value = ''
    none.textContent = '(none)'
    select.append(none)
    for (const t of db === null ? [] : assetsOfKind(db, 'texture')) {
      const o = el('option')
      o.value = t.id
      o.textContent = t.name
      select.append(o)
    }
    select.value = current ?? ''
    // The thumbnail follows the pick itself: the panel is not redrawn after an edit (ADR 0157).
    const img = el('img', 'thumb')
    img.alt = ''
    const showThumb = (id: string | null): void => {
      const entry = id === null ? undefined : db?.byId[id]
      img.hidden = entry === undefined
      if (entry !== undefined) img.src = host.urlOf(entry.path)
    }
    showThumb(current)
    select.addEventListener('change', () => {
      const id = select.value === '' ? null : select.value
      showThumb(id)
      onPick(id)
    })
    wrap.append(img, select)
    return {
      el: wrap,
      update: (v) => {
        if (v.kind !== 'texture' || busy(select)) return
        select.value = v.value ?? ''
        showThumb(v.value)
      },
    }
  }

  const valueField = (param: ShaderParam, value: MaterialValue, onChange: (v: MaterialValue, ongoing?: boolean) => void): Field => {
    if (param.kind === 'color') {
      const input = el('input', 'ctl')
      input.type = 'color'
      input.value = value.kind === 'color' ? value.value : '#ffffff'
      input.addEventListener('input', () => onChange({ kind: 'color', value: input.value }, true))
      // The picker closed: the drag ends as one undo, and the keyboard goes back to the editor, so Ctrl+Z reaches it.
      input.addEventListener('change', () => {
        onChange({ kind: 'color', value: input.value }, false)
        input.blur()
      })
      return { el: input, update: (v) => void (v.kind === 'color' && !busy(input) && (input.value = v.value)) }
    }
    if (param.kind === 'number') {
      const input = el('input', 'ctl')
      input.type = 'number'
      input.step = String(param.step ?? 0.01)
      if (param.min !== undefined) input.min = String(param.min)
      if (param.max !== undefined) input.max = String(param.max)
      input.value = String(value.kind === 'number' ? value.value : 0)
      input.addEventListener('change', () => {
        const n = Number.parseFloat(input.value)
        if (Number.isFinite(n)) onChange({ kind: 'number', value: n })
      })
      return { el: input, update: (v) => void (v.kind === 'number' && !busy(input) && (input.value = String(v.value))) }
    }
    if (param.kind === 'vec2') {
      const wrap = el('div', 'a-vec')
      // Its own latest, so an x then a y keeps the x: the panel is not redrawn between them (ADR 0157).
      let v = value.kind === 'vec2' ? value.value : { x: 1, y: 1 }
      const inputs: HTMLInputElement[] = []
      for (const axis of ['x', 'y'] as const) {
        const input = el('input', 'ctl')
        input.type = 'number'
        input.step = '0.1'
        input.value = String(v[axis])
        input.addEventListener('change', () => {
          const n = Number.parseFloat(input.value)
          if (!Number.isFinite(n)) return
          v = { ...v, [axis]: n }
          onChange({ kind: 'vec2', value: v })
        })
        wrap.append(input)
        inputs.push(input)
      }
      return {
        el: wrap,
        update: (next) => {
          if (next.kind !== 'vec2' || busy(wrap)) return
          v = next.value
          inputs[0]!.value = String(v.x)
          inputs[1]!.value = String(v.y)
        },
      }
    }
    if (param.kind === 'boolean') {
      const input = el('input', 'ctl')
      input.type = 'checkbox'
      input.checked = value.kind === 'boolean' ? value.value : false
      input.addEventListener('change', () => onChange({ kind: 'boolean', value: input.checked }))
      return { el: input, update: (v) => void (v.kind === 'boolean' && !busy(input) && (input.checked = v.value)) }
    }
    if (param.kind === 'texture') {
      return textureField(value.kind === 'texture' ? value.value : null, (id) => onChange({ kind: 'texture', value: id }))
    }
    const unsupported = el('span', 'a-label')
    unsupported.textContent = `(${param.kind} not editable yet)`
    return { el: unsupported, update: () => undefined }
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

    const shaderSelect = el('select', 'ctl')
    // Whatever the material names stays offered even if nothing is registered under it, so opening a
    // material with a missing shader does not silently rewrite it to `standard` on the first edit.
    const names = [...new Set([...BUILTIN_SHADERS, material.shader])]
    for (const n of names) {
      const o = el('option')
      o.value = n
      o.textContent = shaderDef(n) === undefined ? `${n} (missing)` : n
      shaderSelect.append(o)
    }
    shaderSelect.value = material.shader
    shaderSelect.addEventListener('change', () => {
      const next = shaderSelect.value
      const nextDef = shaderDef(next)
      // Keep any parameter the new shader also declares; fill the rest from its defaults.
      const kept: Record<string, MaterialValue> = nextDef === undefined ? {} : defaultParams(nextDef)
      for (const [key, v] of Object.entries(now().params)) if (key in kept) kept[key] = v
      host.onMaterialChanged(entry.id, { shader: next, params: kept }, `${entry.name} shader`)
    })
    container.append(row('shader', shaderSelect))

    if (def === undefined) {
      const warn = el('div', 'a-warn')
      warn.textContent = `No shader registered as "${material.shader}" — rendering falls back to standard.`
      container.append(warn)
      return
    }

    const fields = new Map<string, { field: Field; fallback: MaterialValue }>()
    for (const param of def.params) {
      const value = material.params[param.key] ?? param.fallback
      const field = valueField(param, value, (next, ongoing) => {
        const current = now()
        host.onMaterialChanged(entry.id, { ...current, params: { ...current.params, [param.key]: next } }, `${entry.name} ${param.label}`, ongoing)
      })
      fields.set(param.key, { field, fallback: param.fallback })
      container.append(row(param.label, field.el))
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
