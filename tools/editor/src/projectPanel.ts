import { ASSET_KINDS, buildDatabase, type AssetDatabase, type AssetEntry, type AssetKind } from '@mp/content'

import { buildTree, filterEntries, flattenTree, folderOf, subfoldersOf, type Filter, type TreeNode } from './assetTree'

/**
 * The Project panel: a file explorer over `content/assets/`, plus the open level's own prefabs.
 *
 * A folder tree on the left, tiles on the right, with a breadcrumb, a kind filter and a search box. The
 * folder and the kind are **independent axes**: "textures in this folder" and "every material anywhere" are
 * both things an author asks for, and the tabs this panel started with could only answer the second.
 *
 * **A preview is generated only for a tile that comes into view.** A folder of a thousand models cannot render
 * a thousand thumbnails and does not have to: an `IntersectionObserver` with a margin asks for one just before
 * its tile scrolls in, once, and the cache keeps it. That bounds the *loading* too — a model is fetched only
 * when something is about to show it.
 *
 * One node is not a folder: the prefabs a level defines **in its own table** rather than in a file. Those have
 * no path and no id, so they cannot sit in the tree, and they are the only placeable thing left that is not a
 * file — the code kit that used to live there is deleted (ADR 0027).
 */
export interface ProjectHost {
  /** Prefabs the open level defines in its own table — placeable, but not files. */
  ownPrefabs: () => readonly string[]
  db: () => AssetDatabase | null
  /** Folders on disk, including the empty ones no asset path can imply. */
  folders: () => readonly string[]
  urlOf: (path: string) => string
  /** The armed prefab or model, shown pressed while it waits for a viewport click. */
  armed: () => string | null
  selectedAsset: () => string | null
  onPickOwn: (name: string) => void
  /** Arm a placeable asset (a prefab file or a model) for the next viewport click. */
  onPickAsset: (assetId: string) => void
  /** Open a non-placeable asset in the Inspector. */
  onSelectAsset: (assetId: string) => void
  onCreateMaterial: (folder: string) => void
  onMkdir: (parent: string, name: string) => void
  onRename: (path: string, name: string) => void
  onDelete: (path: string) => void
  /**
   * Open a context menu for a file or folder.
   *
   * The panel says *what* was right-clicked; the host decides what can be done to it, because that needs the
   * document (is this prefab open?) and the asset database (is this material referenced?), neither of which
   * belongs here.
   *
   * This replaced a `window.prompt()` in which **clearing the name deleted the file** — a folder and all its
   * contents included. A blocking dialog whose empty state is destructive is the worst interaction in the
   * editor, and it was reached by the same right-click that now opens this.
   */
  onContext: (at: { x: number; y: number }, path: string, isFolder: boolean) => void
  /** Move a file or folder into `toFolder`. */
  onMove: (from: string, toFolder: string) => void
  /**
   * Ask for a tile's picture. Called only when the tile is about to be visible, and expected to answer from
   * cache when it can — `done` may be called synchronously.
   */
  requestPreview: (
    kind: 'prefab' | 'model' | 'material' | 'shader' | 'texture',
    key: string,
    done: (url: string | null) => void,
  ) => void
}

export interface Project {
  render: () => void
}

const KIND_LABEL: Record<AssetKind, string> = {
  prefab: 'Prefabs',
  texture: 'Textures',
  model: 'Models',
  material: 'Materials',
  shader: 'Shaders',
  sound: 'Sounds',
  font: 'Fonts',
}

/** Kinds a viewport click can place; everything else opens in the Inspector. */
const PLACEABLE = new Set<AssetKind>(['prefab', 'model'])
/** Kinds with no picture worth inventing. */
const UNPREVIEWABLE = new Set<AssetKind>(['sound', 'font'])
/** The pseudo-folder for a level's own prefabs. Not a path, so it can never collide with one. */
const OWN = ' own'

type PreviewKind = 'prefab' | 'model' | 'material' | 'shader' | 'texture'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  return node
}

export const createProjectPanel = (container: HTMLElement, host: ProjectHost): Project => {
  /** Selected folder. `''` is the assets root, `null` means every folder, `OWN` is the level's own prefabs. */
  let folder: string | null = OWN
  let kind: AssetKind | null = null
  let search = ''
  let recursive = false
  const collapsed = new Set<string>()

  const head = el('div', 'ex-head')
  const body = el('div', 'ex-body')
  const treePane = el('div', 'ex-tree')
  const grid = el('div', 'tiles')
  const preview = el('div', 'asset-preview')
  const right = el('div', 'ex-right')
  right.append(grid, preview)
  body.append(treePane, right)
  container.append(head, body)

  /**
   * One observer for the whole grid. A tile is asked for its preview once, just before it scrolls in, then
   * unobserved — the cache answers any later redraw.
   */
  const observer = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue
        const tile = record.target
        if (!(tile instanceof HTMLElement)) continue
        observer.unobserve(tile)
        const previewKind = tile.dataset['previewKind']
        const previewKey = tile.dataset['previewKey']
        if (previewKind === undefined || previewKey === undefined) continue
        host.requestPreview(previewKind as PreviewKind, previewKey, (url) => {
          // The tile may have been redrawn away while the preview was being made.
          if (url === null || !tile.isConnected) return
          const img = tile.querySelector('img.thumb')
          if (img instanceof HTMLImageElement) img.src = url
        })
      }
    },
    { root: grid, rootMargin: '200px' },
  )

  // --- header ---
  const crumbs = el('div', 'ex-crumbs')
  const kindSelect = el('select', 'ctl')
  for (const [value, label] of [['', 'All kinds'], ...ASSET_KINDS.map((k) => [k, KIND_LABEL[k]] as const)] as const) {
    const opt = el('option')
    opt.value = value
    opt.textContent = label
    kindSelect.append(opt)
  }
  kindSelect.addEventListener('change', () => {
    kind = kindSelect.value === '' ? null : (kindSelect.value as AssetKind)
    render()
  })

  const searchInput = el('input', 'ctl')
  searchInput.type = 'text'
  searchInput.placeholder = 'search'
  searchInput.addEventListener('input', () => {
    search = searchInput.value
    render()
  })

  const recurseBox = el('input', 'ctl')
  recurseBox.type = 'checkbox'
  recurseBox.id = 'ex-recurse'
  recurseBox.addEventListener('change', () => {
    recursive = recurseBox.checked
    render()
  })
  const recurseLabel = el('label', 'tb-label')
  recurseLabel.htmlFor = 'ex-recurse'
  recurseLabel.textContent = 'subfolders'

  const newFolderButton = el('button', 'ctl')
  newFolderButton.textContent = '+ folder'
  newFolderButton.addEventListener('click', () => {
    const name = prompt('New folder name')
    if (name !== null && name.trim() !== '') host.onMkdir(folder === null || folder === OWN ? '' : folder, name.trim())
  })

  head.append(crumbs, kindSelect, searchInput, recurseBox, recurseLabel, newFolderButton)

  const goTo = (target: string | null): void => {
    folder = target
    render()
  }

  const renderCrumbs = (): void => {
    crumbs.replaceChildren()
    const crumb = (label: string, target: string | null): HTMLButtonElement => {
      const b = el('button', 'ctl crumb')
      b.textContent = label
      b.addEventListener('click', () => goTo(target))
      return b
    }
    if (folder === OWN) {
      crumbs.append(crumb('level prefabs', OWN))
      return
    }
    crumbs.append(crumb('assets', ''))
    if (folder === null) {
      crumbs.append(crumb('(all folders)', null))
      return
    }
    let acc = ''
    for (const part of folder === '' ? [] : folder.split('/')) {
      acc = acc === '' ? part : `${acc}/${part}`
      crumbs.append(crumb(part, acc))
    }
  }

  const dropTargetFor = (target: HTMLElement, into: string): void => {
    target.addEventListener('dragover', (e) => {
      e.preventDefault()
      target.classList.add('drop-onto')
    })
    target.addEventListener('dragleave', () => target.classList.remove('drop-onto'))
    target.addEventListener('drop', (e) => {
      e.preventDefault()
      target.classList.remove('drop-onto')
      const from = e.dataTransfer?.getData('text/plain')
      if (from !== undefined && from !== '') host.onMove(from, into)
    })
  }

  const renderTree = (root: TreeNode): void => {
    treePane.replaceChildren()

    const ownRow = el('div', `row${folder === OWN ? ' sel' : ''}`)
    const ownName = el('span', 'name')
    ownName.textContent = `This level (${host.ownPrefabs().length})`
    ownRow.append(el('span', 'twist'), ownName)
    ownRow.title = 'prefabs this level defines in its own table'
    ownRow.addEventListener('click', () => goTo(OWN))
    treePane.append(ownRow)

    for (const node of flattenTree(root, collapsed)) {
      const row = el('div', `row${folder === node.path ? ' sel' : ''}`)
      row.style.paddingLeft = `${6 + node.depth * 12}px`

      const twist = el('span', 'twist')
      twist.textContent = node.children.length > 0 ? (collapsed.has(node.path) ? '▸' : '▾') : ''
      if (node.children.length > 0) {
        twist.addEventListener('click', (e) => {
          e.stopPropagation()
          if (collapsed.has(node.path)) collapsed.delete(node.path)
          else collapsed.add(node.path)
          render()
        })
      }
      const name = el('span', 'name')
      name.textContent = node.name
      const count = el('span', 'badge')
      count.textContent = String(node.fileCount)
      row.append(twist, name, count)
      row.addEventListener('click', () => goTo(node.path))
      dropTargetFor(row, node.path)
      treePane.append(row)
    }

    const all = el('div', `row${folder === null ? ' sel' : ''}`)
    const allName = el('span', 'name')
    allName.textContent = 'All folders'
    all.append(el('span', 'twist'), allName)
    all.addEventListener('click', () => goTo(null))
    treePane.append(all)
  }

  const tile = (label: string, title: string, on: boolean, previewKind: PreviewKind | null, previewKey: string): HTMLButtonElement => {
    const b = el('button', `ctl tile${on ? ' armed' : ''}${previewKind !== null ? ' has-thumb' : ''}`)
    b.title = title
    if (previewKind !== null) {
      // The <img> is created empty on purpose: the observer fills its src when the tile nears the viewport,
      // so a thousand tiles cost a thousand empty boxes rather than a thousand renders.
      const img = el('img', 'thumb')
      img.alt = ''
      b.append(img)
      b.dataset['previewKind'] = previewKind
      b.dataset['previewKey'] = previewKey
    }
    const text = el('span', 'tile-name')
    text.textContent = label
    b.append(text)
    return b
  }

  /** Right-click hands the point and the target to the host, which owns the menu. */
  const contextMenu = (target: HTMLElement, path: string, isFolder: boolean): void => {
    target.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation() // a tile's menu, not the panel's
      host.onContext({ x: e.clientX, y: e.clientY }, path, isFolder)
    })
  }

  const draggable = (target: HTMLElement, path: string): void => {
    target.draggable = true
    target.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', path)
      if (e.dataTransfer !== null) e.dataTransfer.effectAllowed = 'move'
    })
  }

  /** Audition a sound, sample a font, enlarge a texture. */
  const showPreview = (entry: AssetEntry): void => {
    preview.replaceChildren()
    const url = host.urlOf(entry.path)

    if (entry.kind === 'texture') {
      const img = el('img')
      img.src = url
      img.alt = entry.name
      preview.append(img)
    } else if (entry.kind === 'sound') {
      const audio = el('audio')
      audio.src = url
      audio.controls = true
      audio.autoplay = true
      preview.append(audio)
    } else if (entry.kind === 'font') {
      const family = `preview-${entry.id}`
      const sample = el('div', 'font-sample')
      sample.textContent = 'The quick brown fox 0123456789'
      sample.style.fontFamily = `"${family}", system-ui, sans-serif`
      preview.append(sample)
      // Loaded rather than declared, so a font that fails says so instead of silently using the UI font.
      void new FontFace(family, `url(${url})`)
        .load()
        .then((face) => void document.fonts.add(face))
        .catch(() => (sample.textContent = `${entry.name}: could not be loaded`))
    }

    const caption = el('div', 'caption')
    caption.textContent = entry.path
    preview.append(caption)
  }

  const empty = (text: string): HTMLDivElement => {
    const d = el('div', 'empty')
    d.textContent = text
    return d
  }

  const render = (): void => {
    const db = host.db() ?? buildDatabase([])
    const root = buildTree(db, host.folders())

    kindSelect.value = kind ?? ''
    recurseBox.checked = recursive
    if (document.activeElement !== searchInput) searchInput.value = search
    newFolderButton.disabled = folder === null || folder === OWN
    renderCrumbs()
    renderTree(root)

    // Every tile is about to be replaced, so the old observations are meaningless.
    observer.disconnect()
    grid.replaceChildren()

    if (folder === OWN) {
      const names = host.ownPrefabs()
      if (names.length === 0) grid.append(empty('nothing to place'))
      for (const name of names) {
        const t = tile(name, `place ${name}`, host.armed() === name, 'prefab', name)
        t.addEventListener('click', () => host.onPickOwn(name))
        grid.append(t)
        observer.observe(t)
      }
      return
    }

    // Subfolders as tiles, so going down a level does not mean crossing to the tree.
    if (folder !== null && search === '') {
      for (const node of subfoldersOf(root, folder)) {
        const t = el('button', 'ctl tile folder')
        t.textContent = `▸ ${node.name}`
        t.title = node.path
        t.addEventListener('click', () => goTo(node.path))
        dropTargetFor(t, node.path)
        draggable(t, node.path)
        contextMenu(t, node.path, true)
        grid.append(t)
      }
    }

    if (kind === 'material' && folder !== null) {
      const target = folder
      const b = el('button', 'ctl tile new')
      b.textContent = '+ new material'
      b.addEventListener('click', () => host.onCreateMaterial(target))
      grid.append(b)
    }

    const filter: Filter = { folder: folder === OWN ? null : folder, kind, search, recursive }
    const entries = filterEntries(db, filter)
    if (entries.length === 0 && grid.children.length === 0) {
      grid.append(empty(folder === null ? 'nothing matches' : `nothing in ${folder === '' ? 'assets' : folder}`))
      return
    }

    for (const entry of entries) {
      const placeable = PLACEABLE.has(entry.kind)
      const on = placeable ? host.armed() === entry.id : host.selectedAsset() === entry.id
      const previewKind = UNPREVIEWABLE.has(entry.kind) ? null : (entry.kind as PreviewKind)
      // Showing more than one folder's worth means the name alone is ambiguous.
      const label = folder === null || recursive ? `${folderOf(entry.path)}/${entry.name}`.replace(/^\//, '') : entry.name
      const t = tile(label, entry.path, on, previewKind, entry.id)
      t.addEventListener('click', () => {
        if (placeable) host.onPickAsset(entry.id)
        else {
          host.onSelectAsset(entry.id)
          showPreview(entry)
        }
      })
      draggable(t, entry.path)
      contextMenu(t, entry.path, false)
      grid.append(t)
      if (previewKind !== null) observer.observe(t)
    }
  }

  render()
  return { render }
}
