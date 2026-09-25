import { assetsOfKind, type AssetDatabase, type AssetEntry, type MaterialAsset, type MaterialValue } from '@mp/content'
import { BUILTIN_SHADERS, defaultParams, shaderDef, type ShaderParam } from '@mp/render-three'

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
  /** Persist an edit. The caller writes the file and refreshes anything showing that material. */
  onMaterialChanged: (assetId: string, material: MaterialAsset) => void
}

export interface AssetInspector {
  /** Draw `assetId`, or clear the panel when `null`. */
  show: (assetId: string | null) => void
}

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
  const textureField = (current: string | null, onPick: (id: string | null) => void): HTMLElement => {
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
    return wrap
  }

  const valueField = (param: ShaderParam, value: MaterialValue, onChange: (v: MaterialValue) => void): HTMLElement => {
    if (param.kind === 'color') {
      const input = el('input', 'ctl')
      input.type = 'color'
      input.value = value.kind === 'color' ? value.value : '#ffffff'
      input.addEventListener('input', () => onChange({ kind: 'color', value: input.value }))
      return input
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
      return input
    }
    if (param.kind === 'vec2') {
      const wrap = el('div', 'a-vec')
      // Its own latest, so an x then a y keeps the x: the panel is not redrawn between them (ADR 0157).
      let v = value.kind === 'vec2' ? value.value : { x: 1, y: 1 }
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
      }
      return wrap
    }
    if (param.kind === 'boolean') {
      const input = el('input', 'ctl')
      input.type = 'checkbox'
      input.checked = value.kind === 'boolean' ? value.value : false
      input.addEventListener('change', () => onChange({ kind: 'boolean', value: input.checked }))
      return input
    }
    if (param.kind === 'texture') {
      return textureField(value.kind === 'texture' ? value.value : null, (id) => onChange({ kind: 'texture', value: id }))
    }
    const unsupported = el('span', 'a-label')
    unsupported.textContent = `(${param.kind} not editable yet)`
    return unsupported
  }

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
      host.onMaterialChanged(entry.id, { shader: next, params: kept })
    })
    container.append(row('shader', shaderSelect))

    if (def === undefined) {
      const warn = el('div', 'a-warn')
      warn.textContent = `No shader registered as "${material.shader}" — rendering falls back to standard.`
      container.append(warn)
      return
    }

    for (const param of def.params) {
      const value = material.params[param.key] ?? param.fallback
      container.append(
        row(
          param.label,
          valueField(param, value, (next) => {
            const current = now()
            host.onMaterialChanged(entry.id, { ...current, params: { ...current.params, [param.key]: next } })
          }),
        ),
      )
    }
  }

  const show = (assetId: string | null): void => {
    container.replaceChildren()
    if (assetId === null) return
    const entry = host.db()?.byId[assetId]
    if (entry === undefined) return

    const head = el('div', 'a-head')
    const name = el('div', 'a-name')
    name.textContent = entry.name
    const meta = el('div', 'a-meta')
    // The id is worth showing: it is what content stores, so it is what appears in a level file.
    meta.textContent = `${entry.kind} · ${entry.path} · ${entry.id}`
    head.append(name, meta)
    container.append(head)

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

  return { show }
}
