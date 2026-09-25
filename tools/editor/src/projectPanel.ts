import { ASSET_KINDS, buildDatabase, libraryDir, type AssetDatabase, type AssetEntry, type AssetKind } from '@mp/content'

import { ancestorsOf, buildTree, filterEntries, flattenTree, folderOf, libraryRootOf, SHARED, shownFolder, subfoldersOf, type TreeNode } from './assetTree'
import { askName } from './confirm'
import { icon, type IconName } from './icons'
import type { ContextMenu } from './menu'
import { initials } from './people'

/**
 * The Project window (Track B, ADR 0163): the asset libraries as folders, Unity's Project window its reference —
 * the open game's own library and **Shared** (ADR 0161) as two roots. Levels are not here: they are the games
 * window's (ADR 0162).
 *
 * A tree of folders on the left; on the right, what is in the folder you are in, subfolders first, every item the
 * same square tile — its picture and its name — at the size the slider sets, down to a one-line list. You go into a
 * folder by double-clicking its tile or clicking it in the tree, and back up by the path above. Searching, by name
 * or by kind, looks in every folder of both roots; not searching, you see the folder you are in.
 *
 * The Unity way with a tile (ADR 0164): a click selects it and shows it in the Inspector, a prefab or a model is
 * dragged into the viewport to place it, and a double-click opens a folder or a prefab.
 *
 * **A preview is generated only for a tile that comes into view.** A folder of a thousand models cannot render
 * a thousand thumbnails and does not have to: an `IntersectionObserver` with a margin asks for one just before
 * its tile scrolls in, once, and the cache keeps it. That bounds the *loading* too — a model is fetched only
 * when something is about to show it.
 */
export interface ProjectHost {
  db: () => AssetDatabase | null
  /** The game being edited, whose own library is the first root (ADR 0161); `null` for none. */
  game: () => { name: string; label: string } | null
  /** Folders on disk, including the empty ones no asset path can imply. */
  folders: () => readonly string[]
  urlOf: (path: string) => string
  /** The editor's menu: the **+** menu and the kind filter open in it. */
  menu: ContextMenu
  selectedAsset: () => string | null
  /** The others who have an asset open (ADR 0159), each in their colour: faces on its tile. */
  openers: (assetId: string) => readonly { name: string; colour: string }[]
  /**
   * Why a placeable asset cannot go into the open document, or `null` (ADR 0076). A prefab using a component
   * the open level's game lacks is shown greyed, with the reason, rather than dragged in and refused.
   */
  unplaceableWhy: (assetId: string) => string | null
  /** A tile was clicked: select that asset, and show it in the Inspector (ADR 0164). */
  onSelectAsset: (assetId: string) => void
  /** A prefab's tile was double-clicked: open it (ADR 0164). */
  onOpenPrefab: (assetId: string) => void
  /** A prefab or model's tile began to be dragged — into the viewport, it places (ADR 0164) — or, `null`, stopped. */
  onDragAsset: (assetId: string | null) => void
  /** Make a new asset of a kind this panel can author, in `folder`: a material, from the **+** menu. */
  onCreateAsset: (kind: AssetKind, folder: string) => void
  onMkdir: (parent: string, name: string) => void
  /**
   * Open a context menu for a file or folder.
   *
   * The panel says *what* was right-clicked; the host decides what can be done to it, because that needs the
   * document (is this prefab open?) and the asset database (is this material referenced?), neither of which
   * belongs here.
   */
  onContext: (at: { x: number; y: number }, path: string, isFolder: boolean) => void
  /** Move a file or folder into `toFolder`. */
  onMove: (from: string, toFolder: string) => void
  /** Files to upload into `folder` (ADR 0083): dragged in from outside the browser, or picked from the **+** menu. */
  onUpload: (files: readonly File[], folder: string) => void
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
  /** The folder on screen, from `content/`. `Save as prefab…` writes here, so navigating is choosing (ADR 0091). */
  folder: () => string
  /** Who has which asset open changed: the faces on the tiles, redrawn in place. */
  openersChanged: () => void
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

/** A tile's picture until its preview arrives, and for good where there is none. */
const KIND_ICON: Record<AssetKind, IconName> = {
  prefab: 'prefab',
  model: 'mesh',
  material: 'material',
  shader: 'material',
  texture: 'image',
  sound: 'sound',
  font: 'font',
}

/** Kinds a drag into the viewport places. */
const PLACEABLE = new Set<AssetKind>(['prefab', 'model'])
/** Kinds with no picture worth inventing. */
const UNPREVIEWABLE = new Set<AssetKind>(['sound', 'font'])

/** What the upload picker offers: the server's `UPLOAD_EXTENSIONS`, what the runtime loads. */
const UPLOADABLE = '.png,.jpg,.jpeg,.webp,.ktx2,.glb'

/** The slider's range, in pixels of a tile's picture. All the way left is the one-line list. */
export const SIZE = { list: 40, min: 40, max: 144, step: 4, start: 64 } as const
const SIZE_KEY = 'mp.project.tileSize'

/** One indent for every depth of the tree. */
const INDENT = 14

type PreviewKind = 'prefab' | 'model' | 'material' | 'shader' | 'texture'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The size this viewer left the slider at: a convenience, so a storage that refuses is the default. */
const savedSize = (): number => {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY))
    return Number.isFinite(v) && v >= SIZE.min && v <= SIZE.max ? v : SIZE.start
  } catch {
    return SIZE.start
  }
}
const saveSize = (v: number): void => {
  try {
    localStorage.setItem(SIZE_KEY, String(v))
  } catch {
    // a private window: the slider still works, it is only not remembered
  }
}

export const createProjectPanel = (container: HTMLElement, host: ProjectHost): Project => {
  /** The folder on screen, from `content/`: a library's own folder, or one inside it. */
  let folder: string = SHARED
  let kind: AssetKind | null = null
  let search = ''
  /** The tile last clicked, by path — what the bottom bar names. Going to another folder clears it. */
  let focused: string | null = null
  let size = savedSize()
  const collapsed = new Set<string>()

  /** The two roots: the open game's own library first, then Shared — even before either has a file. */
  const roots = (): { path: string; label: string }[] => {
    const game = host.game()
    const shared = { path: SHARED, label: 'Shared' }
    return game === null ? [shared] : [{ path: libraryDir(game.name), label: game.label }, shared]
  }
  const rootLabel = (root: string): string => roots().find((r) => r.path === root)?.label ?? root
  /** A folder or file as the panel names it: its root's label, then the path inside it. */
  const named = (path: string): string => {
    const root = libraryRootOf(path)
    const inside = shownFolder(path)
    return inside === '' ? rootLabel(root) : `${rootLabel(root)}/${inside}`
  }
  const searching = (): boolean => search.trim() !== '' || kind !== null

  const head = el('div', 'ex-head')
  const body = el('div', 'ex-body')
  const treePane = el('div', 'ex-tree')
  const grid = el('div', 'ex-grid')
  const preview = el('div', 'asset-preview')
  const right = el('div', 'ex-right')
  right.append(grid, preview)
  body.append(treePane, right)
  const foot = el('div', 'ex-foot')
  container.append(head, body, foot)

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
          if (!(img instanceof HTMLImageElement)) return
          img.src = url
          img.hidden = false
        })
      }
    },
    { root: grid, rootMargin: '200px' },
  )

  // --- the top bar: +, the path, the search box with its kind button ---
  const plus = el('button', 'ex-plus')
  plus.type = 'button'
  plus.title = 'New folder, new material, upload files'
  plus.append(icon('plus'))
  const picker = el('input')
  picker.type = 'file'
  picker.multiple = true
  picker.accept = UPLOADABLE
  picker.hidden = true
  picker.addEventListener('change', () => {
    const files = [...(picker.files ?? [])]
    picker.value = ''
    if (files.length > 0) host.onUpload(files, folder)
  })
  plus.addEventListener('click', () => {
    const into = folder
    const at = plus.getBoundingClientRect()
    host.menu.open({ x: at.left, y: at.bottom + 2 }, [
      {
        label: 'New folder…',
        run: () =>
          void askName('New folder', '', `In ${named(into)}.`).then((name) => {
            if (name !== null && name.trim() !== '') host.onMkdir(into, name.trim())
          }),
      },
      { label: 'New material', run: () => host.onCreateAsset('material', into) },
      { label: 'Upload files…', divider: true, run: () => picker.click() },
    ])
  })

  const crumbs = el('div', 'ex-crumbs')

  const searchBox = el('div', 'ex-search')
  const searchInput = el('input', 'ex-search-in')
  searchInput.type = 'text'
  searchInput.placeholder = 'Search'
  searchInput.spellcheck = false
  searchInput.addEventListener('input', () => {
    search = searchInput.value
    render()
  })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    search = ''
    searchInput.value = ''
    searchInput.blur()
    render()
  })
  const clear = el('button', 'ex-search-x')
  clear.type = 'button'
  clear.title = 'Stop searching'
  clear.append(icon('close'))
  clear.addEventListener('click', () => {
    search = ''
    kind = null
    render()
  })
  const kindButton = el('button', 'ex-kind')
  kindButton.type = 'button'
  kindButton.title = 'Only one kind'
  kindButton.addEventListener('click', () => {
    const at = kindButton.getBoundingClientRect()
    const item = (label: string, value: AssetKind | null) => ({
      label,
      ...(kind === value ? { hint: '✓' } : {}),
      run: () => {
        kind = value
        render()
      },
    })
    host.menu.open({ x: at.left, y: at.bottom + 2 }, [item('All kinds', null), ...ASSET_KINDS.map((k) => ({ ...item(KIND_LABEL[k], k), ...(k === ASSET_KINDS[0] ? { divider: true } : {}) }))])
  })
  searchBox.append(icon('search', 'ic ex-search-i'), searchInput, clear, kindButton)
  head.append(plus, picker, crumbs, searchBox)

  // --- the bottom bar: the selected item's path, the size slider ---
  const footPath = el('span', 'ex-foot-path')
  const slider = el('input', 'ex-size')
  slider.type = 'range'
  slider.min = String(SIZE.min)
  slider.max = String(SIZE.max)
  slider.step = String(SIZE.step)
  slider.value = String(size)
  slider.title = 'Tile size: all the way left for a list'
  const applySize = (): void => {
    grid.classList.toggle('list', size <= SIZE.list)
    grid.style.setProperty('--tile', `${size}px`)
  }
  slider.addEventListener('input', () => {
    size = Number(slider.value)
    saveSize(size)
    applySize()
  })
  foot.append(footPath, slider)
  applySize()

  const goTo = (target: string): void => {
    folder = target
    focused = null
    // The tree shows where you went: every folder above it opens.
    for (const a of ancestorsOf(target, libraryRootOf(target))) collapsed.delete(a)
    preview.replaceChildren()
    render()
  }

  /**
   * A drop is one of two things: a tile dragged from this panel (a move), or files dragged in from the desktop
   * (an upload). `into` may be a getter, for the grid, whose folder changes.
   */
  const dropTargetFor = (target: HTMLElement, into: string | (() => string | null)): void => {
    const dest = (): string | null => (typeof into === 'string' ? into : into())
    target.addEventListener('dragover', (e) => {
      if (dest() === null) return
      e.preventDefault()
      // A tile that can also be placed allows copy and move: into a folder, it moves.
      const dt = e.dataTransfer
      if (dt) dt.dropEffect = dt.effectAllowed === 'copyMove' ? 'move' : dt.dropEffect
      target.classList.add('drop-onto')
    })
    target.addEventListener('dragleave', () => target.classList.remove('drop-onto'))
    target.addEventListener('drop', (e) => {
      const to = dest()
      if (to === null) return
      e.preventDefault()
      e.stopPropagation()
      target.classList.remove('drop-onto')
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length > 0) {
        host.onUpload(files, to)
        return
      }
      const from = e.dataTransfer?.getData('text/plain')
      if (from !== undefined && from !== '') host.onMove(from, to)
    })
  }
  // The grid takes a drop into the folder on screen; search results are no one folder.
  dropTargetFor(grid, () => (searching() ? null : folder))

  const renderCrumbs = (): void => {
    crumbs.replaceChildren()
    if (searching()) {
      crumbs.append(el('span', 'ex-crumb-note', 'Every folder'))
      return
    }
    const root = libraryRootOf(folder)
    const parts = [{ label: rootLabel(root), path: root }]
    let at = root
    for (const part of shownFolder(folder) === '' ? [] : shownFolder(folder).split('/')) {
      at = `${at}/${part}`
      parts.push({ label: part, path: at })
    }
    parts.forEach((p, i) => {
      if (i > 0) crumbs.append(el('span', 'ex-sep', '›'))
      const b = el('button', `ex-crumb${i === parts.length - 1 ? ' here' : ''}`, p.label)
      b.type = 'button'
      b.addEventListener('click', () => goTo(p.path))
      crumbs.append(b)
    })
  }

  const renderTree = (trees: readonly TreeNode[]): void => {
    treePane.replaceChildren()
    for (const tree of trees) {
      for (const node of flattenTree(tree, collapsed)) {
        const row = el('div', `row${node.path === folder && !searching() ? ' sel' : ''}`)
        row.style.paddingLeft = `${4 + node.depth * INDENT}px`
        row.title = named(node.path)
        // An arrow only where there is something under it.
        const twist = el('span', `twist${collapsed.has(node.path) ? ' shut' : ''}`)
        if (node.children.length > 0) {
          twist.append(icon('chevron'))
          twist.addEventListener('click', (e) => {
            e.stopPropagation()
            if (collapsed.has(node.path)) collapsed.delete(node.path)
            else collapsed.add(node.path)
            render()
          })
        }
        row.append(twist, icon('folder', 'ic ico'), el('span', 'name', node.depth === 0 ? rootLabel(node.path) : node.name))
        row.addEventListener('click', () => {
          search = ''
          kind = null
          goTo(node.path)
        })
        dropTargetFor(row, node.path)
        treePane.append(row)
      }
    }
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
      const dt = e.dataTransfer
      if (!dt) return
      dt.setData('text/plain', path)
      dt.effectAllowed = 'move'
    })
  }

  /** One square tile, whatever it is: its picture (a preview, or its kind's icon) and its name under it. */
  const tile = (path: string, name: string, lit: boolean, picture: IconName, previewKind: PreviewKind | null, key: string): HTMLButtonElement => {
    const t = el('button', `pt${lit ? ' on' : ''}`)
    t.type = 'button'
    t.dataset['path'] = path
    const pic = el('span', 'pt-pic')
    pic.append(icon(picture, 'ic pt-ic'))
    if (previewKind !== null) {
      // Empty and hidden on purpose: the observer fills its src when the tile nears the viewport, so a thousand
      // tiles cost a thousand icons rather than a thousand renders.
      const img = el('img', 'thumb')
      img.alt = ''
      img.hidden = true
      pic.append(img)
      t.dataset['previewKind'] = previewKind
      t.dataset['previewKey'] = key
    }
    t.append(pic, el('span', 'pt-name', name))
    return t
  }

  /** The faces of the others who have this asset open: over its picture's corner, or at a list line's end. */
  const paintPeople = (t: HTMLElement): void => {
    const id = t.dataset['id']
    if (id === undefined) return
    t.querySelector(':scope > .pt-people')?.remove()
    const people = host.openers(id)
    if (people.length === 0) return
    const row = el('span', 'pt-people')
    for (const p of people) {
      const face = el('span', 'pp', initials(p.name))
      face.style.setProperty('--pc', p.colour)
      face.title = `${p.name} has this open`
      row.append(face)
    }
    t.append(row)
  }

  /** The bottom bar: the item last clicked, else the asset selected elsewhere (an undo shows one). */
  const paintFoot = (): void => {
    const chosen = host.selectedAsset()
    const shown = focused ?? (chosen === null ? null : (host.db()?.byId[chosen]?.path ?? null))
    footPath.textContent = shown === null ? '' : named(shown)
    footPath.title = shown ?? ''
  }

  const folderTile = (node: TreeNode): HTMLButtonElement => {
    const t = tile(node.path, node.name, focused === node.path, 'folder', null, '')
    t.classList.add('pt-folder')
    t.title = `${named(node.path)} — double-click to open`
    // Lit in place, not redrawn: a redraw between the two clicks of a double-click would lose it.
    t.addEventListener('click', () => {
      focused = node.path
      for (const other of grid.querySelectorAll<HTMLElement>('.pt-folder')) other.classList.toggle('on', other === t)
      paintFoot()
    })
    t.addEventListener('dblclick', () => goTo(node.path))
    dropTargetFor(t, node.path)
    draggable(t, node.path)
    contextMenu(t, node.path, true)
    return t
  }

  const fileTile = (entry: AssetEntry): HTMLButtonElement => {
    const placeable = PLACEABLE.has(entry.kind)
    const previewKind = UNPREVIEWABLE.has(entry.kind) ? null : (entry.kind as PreviewKind)
    const why = placeable ? host.unplaceableWhy(entry.id) : null
    const t = tile(entry.path, entry.name, host.selectedAsset() === entry.id, KIND_ICON[entry.kind], previewKind, entry.id)
    t.dataset['id'] = entry.id
    t.title = why === null ? named(entry.path) : `${named(entry.path)} — ${why}`
    // Greyed rather than hidden: the file exists and is worth seeing; it is this game it cannot go into.
    if (why !== null) t.classList.add('foreign')
    t.addEventListener('click', () => {
      focused = entry.path
      host.onSelectAsset(entry.id)
      showPreview(entry)
      paintFoot()
    })
    if (entry.kind === 'prefab') t.addEventListener('dblclick', () => host.onOpenPrefab(entry.id))
    draggable(t, entry.path)
    if (placeable) {
      // Into a folder it moves; into the viewport it places, which the host follows from here.
      t.addEventListener('dragstart', (e) => {
        const dt = e.dataTransfer
        if (dt) dt.effectAllowed = 'copyMove'
        host.onDragAsset(entry.id)
      })
      t.addEventListener('dragend', () => host.onDragAsset(null))
    }
    contextMenu(t, entry.path, false)
    paintPeople(t)
    return t
  }

  /** Audition a sound, sample a font, enlarge a texture; nothing for the other kinds. */
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
      const sample = el('div', 'font-sample', 'The quick brown fox 0123456789')
      sample.style.fontFamily = `"${family}", system-ui, sans-serif`
      preview.append(sample)
      // Loaded rather than declared, so a font that fails says so instead of silently using the UI font.
      void new FontFace(family, `url(${url})`)
        .load()
        .then((face) => void document.fonts.add(face))
        .catch(() => (sample.textContent = `${entry.name}: could not be loaded`))
    }
  }

  const render = (): void => {
    const db = host.db() ?? buildDatabase([])
    const trees = roots().map((r) => buildTree(db, host.folders(), r.path))

    // A folder gone — deleted, moved, or another game's now — is left for the nearest one still there.
    const known = new Set(trees.flatMap((t) => flattenTree(t, new Set()).map((n) => n.path)))
    let here = folder
    while (!known.has(here) && here.includes('/')) here = folderOf(here)
    if (!known.has(here)) here = SHARED
    if (here !== folder) {
      folder = here
      focused = null
    }

    kindButton.replaceChildren(el('span', '', kind === null ? 'All' : KIND_LABEL[kind]), icon('chevron'))
    kindButton.classList.toggle('on', kind !== null)
    if (document.activeElement !== searchInput) searchInput.value = search
    clear.hidden = !searching()
    renderCrumbs()
    renderTree(trees)

    // Every tile is about to be replaced, so the old observations are meaningless.
    observer.disconnect()
    grid.replaceChildren()
    if (searching()) {
      const found = filterEntries(db, { libraries: roots().map((r) => r.path), folder: null, kind, search })
      for (const entry of found) grid.append(fileTile(entry))
      if (found.length === 0) grid.append(el('div', 'empty', 'nothing matches'))
    } else {
      const tree = trees.find((t) => t.path === libraryRootOf(folder))
      for (const node of tree === undefined ? [] : subfoldersOf(tree, folder)) grid.append(folderTile(node))
      for (const entry of filterEntries(db, { libraries: [libraryRootOf(folder)], folder, kind: null, search: '' })) grid.append(fileTile(entry))
      if (grid.children.length === 0) grid.append(el('div', 'empty', `${named(folder)} is empty`))
    }
    for (const t of grid.querySelectorAll<HTMLElement>('.pt[data-preview-kind]')) observer.observe(t)
    paintFoot()
  }

  render()
  return {
    render,
    folder: () => folder,
    openersChanged: () => {
      for (const t of grid.querySelectorAll<HTMLElement>('.pt[data-id]')) paintPeople(t)
    },
  }
}
