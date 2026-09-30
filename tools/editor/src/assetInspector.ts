import { assetsOfKind, libraryOf, mayUse, type AssetDatabase, type AssetEntry, type MaterialAsset, type MaterialValue, type Node } from '@mp/content'
import { BUILTIN_SHADERS, defaultParams, shaderDef, type ShaderParam } from '@mp/render-three'

import { checkField, colorFieldOf, fieldRow, numberScrub, scrubFieldOf, selectField, type Live } from './controls'
import { assetRefusal } from './assetRefusal'
import { ASSET_ICON, icon } from './icons'
import { refField, type RefShown } from './refField'
import { folderTree } from './treePicker'
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
 *
 * Every kind (ADR 0165): **a big picture on top** — a render, the texture itself, a sound's player, a font's sample
 * — then its name, **the facts of its kind** (a texture's pixels, a prefab's parts and components, a model's
 * triangles, a sound's length; every file's size and date), a material's fields, and **who uses it**: the levels
 * and the other assets, each a click away.
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
  /** A file's size and when it last changed, when the server said (ADR 0165). */
  fileOf: (path: string) => { bytes: number; modified: number } | undefined
  /** The big picture of a prefab, model, material or shader, called back once; `null` when there is none. */
  picture: (kind: 'prefab' | 'model' | 'material' | 'shader', assetId: string, done: (url: string | null) => void) => void
  /** A prefab file's nodes, for what is inside it. */
  prefabOf: (assetId: string) => Node | undefined
  /** A component type as a person reads it: `Mesh Renderer`. */
  componentLabel: (type: string) => string
  /** A model's triangles and meshes, once it has loaded; `null` when it cannot be. */
  modelFacts: (assetId: string) => Promise<{ triangles: number; meshes: number } | null>
  /** Who uses an asset: levels qualified, assets by id. `null` when the server cannot say. */
  users: (assetId: string) => Promise<{ levels: readonly string[]; assets: readonly string[] } | null>
  /** How a level reads in *Used by*: `Keyboard › Roblox`. */
  levelLabel: (qualified: string) => string
  /** A path as the Project window names it: `Shared/materials/red.mat.json`. */
  named: (path: string) => string
  /** A level in *Used by* was clicked: open it. */
  onOpenLevel: (qualified: string) => void
  /** An asset in *Used by* was clicked: select it. */
  onSelectAsset: (assetId: string) => void
  /** The assets a Project window drag carries right now, for a texture slot (ADR 0176); empty when none. */
  draggedAssets: () => readonly string[]
  /** Show an asset's tile in the Project window, the selection left alone (ADR 0176). */
  revealAsset: (assetId: string) => void
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
  /** Its picture is out of date — a material edited: the one shown is drawn again. */
  pictureChanged: (assetId: string) => void
}

/** A line's controls, and how to show a value in them without redrawing them. */
interface Field {
  controls: HTMLElement[]
  update: (v: MaterialValue) => void
}

/** A parameter's edit: its new value, and whether a drag is still adding to it. */
type Change = (v: MaterialValue, ongoing?: boolean) => void

/** `245 KB`, `1.3 MB`. */
export const shownBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** A prefab's parts and what is on them: every node in its tree, and each component type with how many. */
export const prefabFacts = (root: Node): { parts: number; components: { type: string; count: number }[] } => {
  let parts = 0
  const counts = new Map<string, number>()
  const walk = (n: Node): void => {
    parts++
    for (const c of n.components) counts.set(c.type, (counts.get(c.type) ?? 0) + 1)
    for (const kid of n.children ?? []) walk(kid)
  }
  walk(root)
  const components = [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  return { parts, components }
}

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
  // Its lines' card, for who is in which field (ADR 0160): the asset is the field's target, so one name serves.
  container.dataset.card = 'asset'
  /**
   * A texture slot: a reference field (ADR 0176) over the textures `user`'s material may use (ADR 0161) — its game's
   * own and Shared's, or only Shared's for a Shared material — taking a tile dropped from the Project window, and a
   * thumbnail of the current one beside it.
   */
  const textureField = (current: string | null, onPick: (id: string | null) => void, user: string | null): Field => {
    const db = host.db()
    // The thumbnail and the name follow the pick itself: the panel is not redrawn after an edit (ADR 0157).
    const img = el('img', 'a-thumb')
    img.alt = ''
    let now = current
    const shownFor = (id: string | null): RefShown => {
      if (id === null) return null
      const entry = db?.byId[id]
      return entry === undefined ? { label: 'missing texture', icon: 'warn', missing: true } : { label: entry.name, icon: 'image' }
    }
    const show = (id: string | null): void => {
      now = id
      const entry = id === null ? undefined : db?.byId[id]
      img.hidden = entry === undefined
      if (entry !== undefined) img.src = host.urlOf(entry.path)
      field.set(shownFor(id))
    }
    const choose = (id: string | null): void => {
      show(id)
      onPick(id)
    }
    const field = refField({
      shown: shownFor(current),
      none: 'None (Texture)',
      // By folder, as the Project window names them (ADR 0178).
      choices: () =>
        folderTree(
          (db === null ? [] : assetsOfKind(db, 'texture'))
            .filter((t) => mayUse(user, t.path))
            .map((t) => ({ key: t.id, label: t.name, icon: 'image' as const, folders: host.named(t.path).split('/').slice(0, -1) })),
        ),
      current: () => now,
      pick: choose,
      ping: () => {
        if (now !== null) host.revealAsset(now)
      },
      open: () => {
        if (now !== null) host.onSelectAsset(now)
      },
      refuse: (drag) => (drag.kind === 'asset' ? assetRefusal(db, 'texture', drag.id, user) : `this takes a texture, not ${drag.kind === 'node' ? 'an object' : 'a component'}`),
      take: (drag) => {
        if (drag.kind === 'asset') choose(drag.id)
      },
      draggedAssets: host.draggedAssets,
    })
    show(current)
    return {
      controls: [img, field.root],
      update: (v) => {
        if (v.kind === 'texture') show(v.value)
      },
    }
  }

  /** `settle`: a drag let go — end its undo entry, writing nothing. `user`: whose the material is (ADR 0161). */
  const valueField = (param: ShaderParam, value: MaterialValue, onChange: Change, settle: () => void, user: string | null): Field => {
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
      return textureField(value.kind === 'texture' ? value.value : null, (id) => onChange({ kind: 'texture', value: id }), user)
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
        libraryOf(entry.path) ?? null,
      )
      fields.set(param.key, { field, fallback: param.fallback })
      container.append(fieldRow(param.label, ...field.controls))
    }
    drawn = { assetId: entry.id, shader: material.shader, fields }
  }

  /** The picture on show, to draw again when it goes out of date. */
  let picture: { assetId: string; draw: () => void } | null = null

  /** The big picture: a render, the texture, a sound's player, a font's sample — `fact` fills a fact it learns. */
  const pictureOf = (entry: AssetEntry, fact: (label: string, value: string) => void): HTMLElement => {
    const box = el('div', 'a-pic')
    const url = host.urlOf(entry.path)
    if (entry.kind === 'texture') {
      const img = el('img')
      img.alt = entry.name
      img.draggable = false
      img.addEventListener('load', () => fact('Size', `${img.naturalWidth} × ${img.naturalHeight} px`))
      img.src = url
      box.append(img)
      return box
    }
    if (entry.kind === 'sound') {
      const audio = el('audio')
      audio.controls = true
      audio.autoplay = true
      audio.addEventListener('loadedmetadata', () => fact('Length', `${audio.duration.toFixed(1)} s`))
      audio.src = url
      box.append(audio)
      return box
    }
    if (entry.kind === 'font') {
      const family = `preview-${entry.id}`
      const sample = el('div', 'font-sample')
      sample.textContent = 'The quick brown fox 0123456789'
      sample.style.fontFamily = `"${family}", system-ui, sans-serif`
      box.append(sample)
      // Loaded rather than declared, so a font that fails says so instead of silently using the UI font.
      void new FontFace(family, `url(${url})`)
        .load()
        .then((face) => void document.fonts.add(face))
        .catch(() => (sample.textContent = `${entry.name}: could not be loaded`))
      return box
    }
    box.append(icon(ASSET_ICON[entry.kind], 'ic a-pic-ic'))
    const img = el('img')
    img.alt = ''
    img.hidden = true
    img.draggable = false
    box.append(img)
    const kind = entry.kind
    const draw = (): void =>
      host.picture(kind, entry.id, (made) => {
        if (made === null || !img.isConnected) return
        img.src = made
        img.hidden = false
      })
    picture = { assetId: entry.id, draw }
    // Drawn once it is on the page: the callback may come at once, from the cache.
    queueMicrotask(draw)
    return box
  }

  /** Who uses it, each a click away; asked of the server each time the asset is shown. */
  const usedBy = (entry: AssetEntry): HTMLElement => {
    const box = el('div', 'a-users')
    const title = el('div', 'a-sec')
    title.textContent = 'Used by'
    const list = el('div', 'a-use-list')
    const note = (text: string): HTMLElement => {
      const n = el('div', 'a-none')
      n.textContent = text
      return n
    }
    list.append(note('…'))
    box.append(title, list)
    void host.users(entry.id).then((users) => {
      if (!box.isConnected) return
      if (users === null) return void list.replaceChildren(note('The server could not say.'))
      const rows: HTMLElement[] = []
      for (const level of users.levels) {
        const b = el('button', 'a-use')
        b.type = 'button'
        b.title = 'Open this level'
        const label = el('span')
        label.textContent = host.levelLabel(level)
        b.append(icon('level'), label)
        b.addEventListener('click', () => host.onOpenLevel(level))
        rows.push(b)
      }
      const db = host.db()
      for (const id of users.assets) {
        const user = db?.byId[id]
        if (user === undefined) continue
        const b = el('button', 'a-use')
        b.type = 'button'
        b.title = host.named(user.path)
        const label = el('span')
        label.textContent = user.name
        b.append(icon(ASSET_ICON[user.kind]), label)
        b.addEventListener('click', () => host.onSelectAsset(id))
        rows.push(b)
      }
      list.replaceChildren(...(rows.length === 0 ? [note('Nothing uses it.')] : rows))
    })
    return box
  }

  /** The facts of its kind, and every file's size and date. `fact` adds one or fills one learnt later. */
  const factsOf = (entry: AssetEntry): { box: HTMLElement; fact: (label: string, value: string) => void } => {
    const box = el('div', 'a-facts')
    const rows = new Map<string, HTMLElement>()
    const fact = (label: string, value: string): void => {
      let v = rows.get(label)
      if (v === undefined) {
        v = el('span', 'irow-v')
        rows.set(label, v)
        box.append(fieldRow(label, v))
      }
      v.textContent = value
    }
    // Learnt from the picture once it loads; placed first, so the order is the same however fast it comes.
    if (entry.kind === 'texture') fact('Size', '…')
    if (entry.kind === 'sound') fact('Length', '…')
    if (entry.kind === 'prefab') {
      const root = host.prefabOf(entry.id)
      if (root !== undefined) {
        const { parts, components } = prefabFacts(root)
        fact('Parts', `${parts} object${parts === 1 ? '' : 's'}`)
        fact('Components', components.length === 0 ? 'none' : components.map((c) => `${host.componentLabel(c.type)}${c.count > 1 ? ` ×${c.count}` : ''}`).join(', '))
      }
    }
    if (entry.kind === 'model') {
      fact('Triangles', '…')
      fact('Meshes', '…')
      void host.modelFacts(entry.id).then((m) => {
        fact('Triangles', m === null ? 'not loaded' : m.triangles.toLocaleString())
        fact('Meshes', m === null ? 'not loaded' : String(m.meshes))
      })
    }
    const file = host.fileOf(entry.path)
    if (file !== undefined) {
      fact('File', shownBytes(file.bytes))
      fact('Changed', new Date(file.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
    }
    return { box, fact }
  }

  const show = (assetId: string | null): void => {
    container.replaceChildren()
    drawn = null
    head = null
    picture = null
    if (assetId === null) return
    const entry = host.db()?.byId[assetId]
    if (entry === undefined) return

    const facts = factsOf(entry)
    container.append(pictureOf(entry, facts.fact))
    const header = el('div', 'a-head')
    const top = el('div', 'a-top')
    const name = el('div', 'a-name')
    name.textContent = entry.name
    const openers = el('div', 'a-openers')
    top.append(name, openers)
    const meta = el('div', 'a-meta')
    // The id is worth showing: it is what content stores, so it is what appears in a level file.
    meta.textContent = `${entry.kind} · ${host.named(entry.path)} · ${entry.id}`
    header.append(top, meta)
    container.append(header, facts.box)
    head = { assetId, slot: openers }
    drawOpeners()

    if (entry.kind === 'material') {
      const material = host.materialOf(assetId)
      if (material === undefined) {
        const warn = el('div', 'a-warn')
        warn.textContent = 'This material did not parse.'
        container.append(warn)
      } else showMaterial(entry, material)
    }
    container.append(usedBy(entry))
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

  return {
    show,
    refresh,
    openersChanged: drawOpeners,
    pictureChanged: (assetId) => {
      if (picture?.assetId === assetId) picture.draw()
    },
  }
}
