import { ASSET_KINDS, assetsOfKind, type AssetDatabase, type AssetEntry, type AssetKind } from '@mp/content'

/**
 * The Project panel: prefabs and every asset, in one browser.
 *
 * Tabs rather than a folder tree, deliberately — a folder tree answers "where is this file", and the
 * question an author actually has is "what textures do I have". Folders still exist on disk and a tile
 * shows its path, so nothing is hidden; there is just no navigation to do.
 *
 * What clicking a tile means depends on what it is, and each is the only sensible verb for that kind:
 * a prefab or a model arms placement, a material opens for editing, a texture previews, a sound plays, a
 * font renders a sample.
 */
export type ProjectTab = 'prefabs' | AssetKind

export const PROJECT_TABS: readonly ProjectTab[] = ['prefabs', ...ASSET_KINDS]

const TAB_LABEL: Record<ProjectTab, string> = {
  prefabs: 'Prefabs',
  texture: 'Textures',
  model: 'Models',
  material: 'Materials',
  shader: 'Shaders',
  sound: 'Sounds',
  font: 'Fonts',
}

export interface ProjectHost {
  /** Placeable prefab names — the kit, prefab files, and the level's own entries. */
  prefabs: () => readonly string[]
  db: () => AssetDatabase | null
  urlOf: (path: string) => string
  /** The armed prefab or model, shown as pressed while it waits for a viewport click. */
  armed: () => string | null
  /** The asset currently open in the Inspector. */
  selectedAsset: () => string | null
  onPickPrefab: (name: string) => void
  /** A model tile: arm it for placement. */
  onPickModel: (assetId: string) => void
  /** Anything else: open it in the Inspector (and preview it). */
  onSelectAsset: (assetId: string) => void
  onCreateMaterial: () => void
  /**
   * A picture for this tile, or `null` if the kind has none. Called once per tile per draw and expected to
   * be cached by the host: a panel redraw must not cost a render.
   */
  previewOf: (kind: 'prefab' | 'model' | 'material' | 'shader' | 'texture', key: string) => string | null
}

export interface Project {
  render: () => void
}

export const createProjectPanel = (container: HTMLElement, host: ProjectHost): Project => {
  let tab: ProjectTab = 'prefabs'

  const tabBar = document.createElement('div')
  tabBar.className = 'tabs'
  const grid = document.createElement('div')
  grid.className = 'tiles'
  const preview = document.createElement('div')
  preview.className = 'asset-preview'
  container.append(tabBar, grid, preview)

  const countFor = (t: ProjectTab): number => {
    if (t === 'prefabs') return host.prefabs().length
    const db = host.db()
    return db === null ? 0 : assetsOfKind(db, t).length
  }

  const renderTabs = (): void => {
    tabBar.replaceChildren()
    for (const t of PROJECT_TABS) {
      const b = document.createElement('button')
      b.className = `ctl tab${t === tab ? ' on' : ''}`
      b.textContent = `${TAB_LABEL[t]} ${countFor(t)}`
      b.addEventListener('click', () => {
        tab = t
        preview.replaceChildren()
        render()
      })
      tabBar.append(b)
    }
  }

  const tile = (label: string, title: string, on: boolean, onClick: () => void, preview: string | null): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = `ctl tile${on ? ' armed' : ''}${preview !== null ? ' has-thumb' : ''}`
    b.title = title
    if (preview !== null) {
      const img = document.createElement('img')
      img.className = 'thumb'
      img.src = preview
      img.alt = ''
      img.loading = 'lazy'
      b.append(img)
    }
    const text = document.createElement('span')
    text.className = 'tile-name'
    text.textContent = label
    b.append(text)
    b.addEventListener('click', onClick)
    return b
  }

  /** Shows what a click on a non-placeable asset does — audition, sample text, a bigger image. */
  const showPreview = (entry: AssetEntry): void => {
    preview.replaceChildren()
    const url = host.urlOf(entry.path)

    if (entry.kind === 'texture') {
      const img = document.createElement('img')
      img.src = url
      img.alt = entry.name
      preview.append(img)
    } else if (entry.kind === 'sound') {
      // The one asset kind whose preview *is* its content, and the only audio anywhere in the project.
      const audio = document.createElement('audio')
      audio.src = url
      audio.controls = true
      audio.autoplay = true
      preview.append(audio)
    } else if (entry.kind === 'font') {
      const family = `preview-${entry.id}`
      const sample = document.createElement('div')
      sample.className = 'font-sample'
      sample.textContent = 'The quick brown fox 0123456789'
      sample.style.fontFamily = `"${family}", system-ui, sans-serif`
      preview.append(sample)
      // Loaded rather than declared, so a font that fails to parse says so instead of silently
      // falling back to the UI font and looking like it worked.
      void new FontFace(family, `url(${url})`)
        .load()
        .then((face) => void document.fonts.add(face))
        .catch(() => (sample.textContent = `${entry.name}: could not be loaded`))
    }

    const caption = document.createElement('div')
    caption.className = 'caption'
    caption.textContent = entry.path
    preview.append(caption)
  }

  const render = (): void => {
    renderTabs()
    grid.replaceChildren()

    if (tab === 'prefabs') {
      const names = host.prefabs()
      if (names.length === 0) grid.append(empty('nothing to place'))
      for (const name of names) {
        grid.append(tile(name, `place ${name}`, name === host.armed(), () => host.onPickPrefab(name), host.previewOf('prefab', name)))
      }
      return
    }

    const db = host.db()
    if (db === null) {
      grid.append(empty('assets not loaded'))
      return
    }

    if (tab === 'material') {
      const b = document.createElement('button')
      b.className = 'ctl tile new'
      b.textContent = '+ new material'
      b.addEventListener('click', host.onCreateMaterial)
      grid.append(b)
    }

    const entries = assetsOfKind(db, tab)
    if (entries.length === 0 && tab !== 'material') {
      grid.append(empty(`no ${TAB_LABEL[tab].toLowerCase()} in content/assets/`))
      return
    }

    for (const entry of entries) {
      const placeable = entry.kind === 'model'
      const on = placeable ? host.armed() === entry.id : host.selectedAsset() === entry.id
      // A texture is its own file; a model, material or prefab is rendered once offscreen and cached. A
      // sound or a font has no visual form worth inventing, so it is not asked for and the tile stays text.
      const preview = entry.kind === 'font' || entry.kind === 'sound' ? null : host.previewOf(entry.kind, entry.id)
      grid.append(
        tile(
          entry.name,
          entry.path,
          on,
          () => {
            if (placeable) host.onPickModel(entry.id)
            else {
              host.onSelectAsset(entry.id)
              showPreview(entry)
            }
          },
          preview,
        ),
      )
    }
  }

  const empty = (text: string): HTMLDivElement => {
    const d = document.createElement('div')
    d.className = 'empty'
    d.textContent = text
    return d
  }

  render()
  return { render }
}
