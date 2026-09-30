import { ASSET_KINDS, buildDatabase, libraryDir, type AssetDatabase, type AssetEntry, type AssetKind } from '@mp/content'

import { ancestorsOf, buildTree, filterEntries, flattenTree, folderOf, libraryRootOf, SHARED, shownFolder, sortEntries, subfoldersOf, type SortBy, type TreeNode } from './assetTree'
import { askName } from './confirm'
import { ASSET_ICON, icon, type IconName } from './icons'
import type { ContextMenu } from './menu'
import { initials } from './people'
import { modeFor, type SelectMode } from './selection'

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
 * dragged into the viewport to place it, and a double-click opens a folder or a prefab. Ctrl and Shift select
 * several, which drag into a folder and delete together; Unity's keys work while the window has the focus; and a
 * sort button orders the tiles by name, kind or date (ADR 0166).
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
  /**
   * The assets any drag of tiles carries, by id — onto an Inspector reference field (ADR 0176), which cannot read a
   * browser drag before its drop — or, empty, the drag ended.
   */
  onDragAssets: (assetIds: readonly string[]) => void
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
  /** Move files and folders into `toFolder`, all or none (ADR 0166). */
  onMove: (froms: readonly string[], toFolder: string) => void
  /** Delete these, asked once for all (ADR 0166): the Delete key. */
  onDelete: (paths: readonly string[]) => void
  /** Rename this one: F2. */
  onRename: (path: string) => void
  /** A file's size and date, when the server said: the date is what *Date changed* orders by. */
  fileOf: (path: string) => { bytes: number; modified: number } | undefined
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
  /** Go to where this file is and light it — one picked in the Inspector's *Used by* (ADR 0165). */
  reveal: (path: string) => void
  /** A path as this window names it: its root's label, then the path inside. */
  named: (path: string) => string
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

/** Kinds a drag into the viewport places. */
const PLACEABLE = new Set<AssetKind>(['prefab', 'model'])
/** Kinds with no picture worth inventing. */
const UNPREVIEWABLE = new Set<AssetKind>(['sound', 'font'])

/** What a tile drag carries: the paths it moves, one a line. Its own type, so nothing else dropped reads as one. */
const TILES = 'application/x-mp-assets'

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

/** How the tiles are ordered (ADR 0166); folders come first whatever it is. The viewer's own, like the size. */
const SORT_LABEL: Record<SortBy, string> = { name: 'Name', kind: 'Kind', date: 'Date changed' }
const SORT_KEY = 'mp.project.sort'
const savedSort = (): SortBy => {
  try {
    const v = localStorage.getItem(SORT_KEY)
    return v === 'kind' || v === 'date' ? v : 'name'
  } catch {
    return 'name'
  }
}
const saveSort = (v: SortBy): void => {
  try {
    localStorage.setItem(SORT_KEY, v)
  } catch {
    // not remembered, as the size
  }
}

export const createProjectPanel = (container: HTMLElement, host: ProjectHost): Project => {
  /** The folder on screen, from `content/`: a library's own folder, or one inside it. */
  let folder: string = SHARED
  let kind: AssetKind | null = null
  let search = ''
  let size = savedSize()
  let sortBy = savedSort()
  const collapsed = new Set<string>()
  /** What is selected, by path, in the order it was picked: the last is the one the Inspector shows (ADR 0166). */
  let picked: string[] = []
  /** Where a Shift+click's range starts. */
  let anchor: string | null = null
  /** The asset the host had selected at the last draw: one selected elsewhere — *Used by*, an undo — is selected here. */
  let hostSeen: string | null = null
  /**
   * What the tiles were drawn from. A redraw that changes none of it keeps them, lighting them in place: a redraw
   * between the two clicks of a double-click would lose it, and the keyboard's focus with it.
   */
  let drawnFrom: readonly unknown[] = []

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
  const entryAt = (path: string): AssetEntry | undefined => host.db()?.entries.find((e) => e.path === path)

  /**
   * Whether the drag going on began in this page. A picture dragged within the page carries itself as a file — a
   * data URL comes as `download.png` — so a drop of files is an upload only when the drag came from outside.
   */
  let dragFromPage = false
  document.addEventListener('dragstart', () => void (dragFromPage = true), true)
  document.addEventListener('dragend', () => void (dragFromPage = false), true)
  // And after any drop, for a drag whose tile was drawn away before it ended, which the document never hears end.
  document.addEventListener('drop', () => void setTimeout(() => (dragFromPage = false)), true)

  const head = el('div', 'ex-head')
  const body = el('div', 'ex-body')
  const treePane = el('div', 'ex-tree')
  const grid = el('div', 'ex-grid')
  // Focusable itself, so the keys stay the Project window's when the tile that had the focus is drawn away.
  grid.tabIndex = -1
  const right = el('div', 'ex-right')
  right.append(grid)
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

  // --- the top bar: +, the path, the sort, the search box with its kind button ---
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

  const sortButton = el('button', 'ex-sort')
  sortButton.type = 'button'
  sortButton.title = 'Sort'
  sortButton.addEventListener('click', () => {
    const at = sortButton.getBoundingClientRect()
    host.menu.open(
      { x: at.left, y: at.bottom + 2 },
      (Object.keys(SORT_LABEL) as SortBy[]).map((by) => ({
        label: SORT_LABEL[by],
        ...(sortBy === by ? { hint: '✓' } : {}),
        run: () => {
          sortBy = by
          saveSort(by)
          render()
        },
      })),
    )
  })

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
  head.append(plus, picker, crumbs, sortButton, searchBox)

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

  const tiles = (): HTMLElement[] => [...grid.querySelectorAll<HTMLElement>('.pt')]
  /** The tiles' paths in the order they are drawn: what a Shift range and the arrow keys walk. */
  const shownOrder = (): string[] => tiles().map((t) => t.dataset['path'] ?? '')
  const tileAt = (path: string): HTMLElement | undefined => tiles().find((t) => t.dataset['path'] === path)

  /** The bottom bar: one selected, its path; several, how many. */
  const paintFoot = (): void => {
    const one = picked.length === 1 ? picked[0]! : null
    footPath.textContent = picked.length > 1 ? `${picked.length} items selected` : one === null ? '' : named(one)
    footPath.title = one ?? ''
  }
  /** Light what is selected, in place. */
  const paintPicked = (): void => {
    const lit = new Set(picked)
    for (const t of tiles()) t.classList.toggle('on', lit.has(t.dataset['path'] ?? ''))
    paintFoot()
  }

  /**
   * Select a tile: only it, it added or taken away (Ctrl), or everything from the anchor to it (Shift) — the
   * Hierarchy's clicks (ADR 0166). The last picked, when it is a file, is shown in the Inspector.
   */
  const pickTile = (path: string, how: SelectMode): void => {
    const order = shownOrder()
    if (how === 'range' && anchor !== null && order.includes(anchor)) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(path)].sort((x, y) => x - y)
      picked = [...order.slice(a!, b! + 1).filter((p) => p !== path), path]
    } else if (how === 'toggle') {
      picked = picked.includes(path) ? picked.filter((p) => p !== path) : [...picked, path]
      anchor = path
    } else {
      picked = [path]
      anchor = path
    }
    paintPicked()
    const last = picked.at(-1)
    const entry = last === undefined ? undefined : entryAt(last)
    if (entry !== undefined && host.selectedAsset() !== entry.id) {
      hostSeen = entry.id
      host.onSelectAsset(entry.id)
    }
  }

  const goTo = (target: string): void => {
    // The keys stay here when what had the focus is drawn away.
    const hadFocus = container.contains(document.activeElement)
    folder = target
    picked = []
    anchor = null
    // The tree shows where you went: every folder above it opens.
    for (const a of ancestorsOf(target, libraryRootOf(target))) collapsed.delete(a)
    render()
    if (hadFocus) grid.focus()
  }

  /** Enter on a tile: into a folder, or open a prefab. */
  const open = (path: string): void => {
    const entry = entryAt(path)
    if (entry === undefined) goTo(path)
    else if (entry.kind === 'prefab') host.onOpenPrefab(entry.id)
  }

  /** Backspace: the folder above, with the one you left selected, as Unity does. */
  const up = (): void => {
    if (searching() || folder === libraryRootOf(folder)) return
    const left = folder
    goTo(folderOf(folder))
    pickTile(left, 'replace')
    tileAt(left)?.focus()
  }

  /** The tile an arrow goes to from index `i`: left and right along the order, up and down to the nearest in the next row. */
  const neighbour = (i: number, key: string): number | null => {
    const els = tiles()
    if (els.length === 0) return null
    if (i < 0) return 0
    if (key === 'ArrowLeft') return Math.max(0, i - 1)
    if (key === 'ArrowRight') return Math.min(els.length - 1, i + 1)
    const here = els[i]!
    const down = key === 'ArrowDown'
    const rows = els.map((t, j) => ({ j, top: t.offsetTop, left: t.offsetLeft })).filter((c) => (down ? c.top > here.offsetTop : c.top < here.offsetTop))
    if (rows.length === 0) return null
    const top = down ? Math.min(...rows.map((c) => c.top)) : Math.max(...rows.map((c) => c.top))
    const row = rows.filter((c) => c.top === top)
    return row.reduce((best, c) => (Math.abs(c.left - here.offsetLeft) < Math.abs(best.left - here.offsetLeft) ? c : best)).j
  }

  /**
   * Unity's keys, while the Project window has the focus (ADR 0166): arrows move the selection, Enter opens,
   * Backspace goes up, Delete deletes, F2 renames, Ctrl+A selects all. Stopped here, so none of them reaches the
   * level behind — a Delete here must not delete a node there. Typing in the search box keeps its own.
   */
  container.addEventListener('keydown', (e) => {
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    const mod = e.ctrlKey || e.metaKey
    const current = picked.at(-1) ?? null
    const order = shownOrder()
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next = neighbour(current === null ? -1 : order.indexOf(current), e.key)
      if (next !== null) {
        pickTile(order[next]!, 'replace')
        const to = tiles()[next]
        to?.focus()
        to?.scrollIntoView({ block: 'nearest' })
      }
    } else if (e.key === 'Enter') {
      if (current !== null) open(current)
    } else if (e.key === 'Backspace') up()
    else if (e.key === 'Delete') {
      if (picked.length > 0) host.onDelete([...picked])
    } else if (e.key === 'F2') {
      if (picked.length === 1) host.onRename(picked[0]!)
    } else if (mod && e.key.toLowerCase() === 'a') {
      picked = order
      anchor = order[0] ?? null
      paintPicked()
    } else return
    e.preventDefault()
    e.stopPropagation()
  })

  /**
   * A drop is one of two things: tiles dragged from this panel (a move, of all of them), or files dragged in from
   * the desktop (an upload). `into` may be a getter, for the grid, whose folder changes.
   */
  const dropTargetFor = (target: HTMLElement, into: string | (() => string | null)): void => {
    const dest = (): string | null => (typeof into === 'string' ? into : into())
    target.addEventListener('dragover', (e) => {
      if (dest() === null) return
      const types = e.dataTransfer?.types ?? []
      if (!(dragFromPage ? types.includes(TILES) : types.includes('Files'))) return
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
      // Only from outside the browser: a picture dragged within the page carries itself as a file too.
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!dragFromPage && files.length > 0) {
        host.onUpload(files, to)
        return
      }
      // Not what is there already, nor a folder onto itself.
      const froms = (e.dataTransfer?.getData(TILES) ?? '').split('\n').filter((p) => p !== '' && p !== to && folderOf(p) !== to)
      if (froms.length > 0) host.onMove(froms, to)
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

  /**
   * Dragging one of several selected carries them all; dragging another carries it alone and leaves the selection
   * be, so the Inspector keeps showing what a reference field is being filled on (ADR 0176).
   */
  const draggable = (target: HTMLElement, path: string): void => {
    target.draggable = true
    target.addEventListener('dragstart', (e) => {
      const carried = picked.includes(path) ? picked : [path]
      host.onDragAssets(carried.map((p) => entryAt(p)?.id).filter((id): id is string => id !== undefined))
      const dt = e.dataTransfer
      if (!dt) return
      dt.setData(TILES, carried.join('\n'))
      dt.effectAllowed = 'move'
    })
    target.addEventListener('dragend', () => host.onDragAssets([]))
  }

  /** One square tile, whatever it is: its picture (a preview, or its kind's icon) and its name under it. */
  const tile = (path: string, name: string, picture: IconName, previewKind: PreviewKind | null, key: string): HTMLButtonElement => {
    const t = el('button', 'pt')
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
      // The tile is what is dragged, never its picture on its own.
      img.draggable = false
      pic.append(img)
      t.dataset['previewKind'] = previewKind
      t.dataset['previewKey'] = key
    }
    t.append(pic, el('span', 'pt-name', name))
    t.addEventListener('click', (e) => pickTile(path, modeFor(e)))
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

  /** Whether a placeable tile can go into the open document, and why not — it changes with the document, not the tiles. */
  const paintPlaceable = (t: HTMLElement): void => {
    const id = t.dataset['id']
    const entry = id === undefined ? undefined : host.db()?.byId[id]
    if (entry === undefined || !PLACEABLE.has(entry.kind)) return
    const why = host.unplaceableWhy(entry.id)
    t.title = why === null ? named(entry.path) : `${named(entry.path)} — ${why}`
    // Greyed rather than hidden: the file exists and is worth seeing; it is this game it cannot go into.
    t.classList.toggle('foreign', why !== null)
  }

  const folderTile = (node: TreeNode): HTMLButtonElement => {
    const t = tile(node.path, node.name, 'folder', null, '')
    t.classList.add('pt-folder')
    t.title = `${named(node.path)} — double-click to open`
    t.addEventListener('dblclick', () => goTo(node.path))
    dropTargetFor(t, node.path)
    draggable(t, node.path)
    contextMenu(t, node.path, true)
    return t
  }

  const fileTile = (entry: AssetEntry): HTMLButtonElement => {
    const previewKind = UNPREVIEWABLE.has(entry.kind) ? null : (entry.kind as PreviewKind)
    const t = tile(entry.path, entry.name, ASSET_ICON[entry.kind], previewKind, entry.id)
    t.dataset['id'] = entry.id
    t.title = named(entry.path)
    if (entry.kind === 'prefab') t.addEventListener('dblclick', () => host.onOpenPrefab(entry.id))
    draggable(t, entry.path)
    if (PLACEABLE.has(entry.kind)) {
      // Into a folder it moves; into the viewport it places, which the host follows from here — one at a time.
      t.addEventListener('dragstart', (e) => {
        const dt = e.dataTransfer
        if (dt) dt.effectAllowed = 'copyMove'
        // Alone: this tile was not among those picked, or was the only one (see `draggable`).
        if (!picked.includes(entry.path) || picked.length === 1) host.onDragAsset(entry.id)
      })
      t.addEventListener('dragend', () => host.onDragAsset(null))
    }
    contextMenu(t, entry.path, false)
    return t
  }

  const render = (): void => {
    const db = host.db() ?? buildDatabase([])
    const trees = roots().map((r) => buildTree(db, host.folders(), r.path))

    // A folder gone — deleted, moved, or another game's now — is left for the nearest one still there.
    const known = new Set(trees.flatMap((t) => flattenTree(t, new Set()).map((n) => n.path)))
    let here = folder
    while (!known.has(here) && here.includes('/')) here = folderOf(here)
    if (!known.has(here)) here = SHARED
    if (here !== folder) folder = here

    // What is selected stays selected while it is still there; an asset selected elsewhere is selected here.
    const seen = host.selectedAsset()
    if (seen !== hostSeen) {
      hostSeen = seen
      const path = seen === null ? undefined : db.byId[seen]?.path
      if (seen === null) picked = picked.filter((p) => known.has(p))
      else if (path !== undefined && !picked.includes(path)) {
        picked = [path]
        anchor = path
      }
    }
    const paths = new Set(db.entries.map((e) => e.path))
    picked = picked.filter((p) => paths.has(p) || known.has(p))

    kindButton.replaceChildren(el('span', '', kind === null ? 'All' : KIND_LABEL[kind]), icon('chevron'))
    kindButton.classList.toggle('on', kind !== null)
    sortButton.replaceChildren(el('span', '', SORT_LABEL[sortBy]), icon('chevron'))
    if (document.activeElement !== searchInput) searchInput.value = search
    clear.hidden = !searching()
    renderCrumbs()
    renderTree(trees)

    const from = [db, host.folders(), host.game()?.name, folder, search, kind, sortBy]
    if (from.length !== drawnFrom.length || from.some((v, i) => v !== drawnFrom[i])) {
      drawnFrom = from
      // Every tile is about to be replaced, so the old observations are meaningless.
      observer.disconnect()
      grid.replaceChildren()
      const modified = (path: string): number | undefined => host.fileOf(path)?.modified
      if (searching()) {
        const found = sortEntries(filterEntries(db, { libraries: roots().map((r) => r.path), folder: null, kind, search }), sortBy, modified)
        for (const entry of found) grid.append(fileTile(entry))
        if (found.length === 0) grid.append(el('div', 'empty', 'nothing matches'))
      } else {
        const tree = trees.find((t) => t.path === libraryRootOf(folder))
        for (const node of tree === undefined ? [] : subfoldersOf(tree, folder)) grid.append(folderTile(node))
        const files = sortEntries(filterEntries(db, { libraries: [libraryRootOf(folder)], folder, kind: null, search: '' }), sortBy, modified)
        for (const entry of files) grid.append(fileTile(entry))
        if (grid.children.length === 0) grid.append(el('div', 'empty', `${named(folder)} is empty`))
      }
      for (const t of grid.querySelectorAll<HTMLElement>('.pt[data-preview-kind]')) observer.observe(t)
    }
    for (const t of grid.querySelectorAll<HTMLElement>('.pt[data-id]')) {
      paintPlaceable(t)
      paintPeople(t)
    }
    paintPicked()
  }

  render()
  return {
    render,
    folder: () => folder,
    openersChanged: () => {
      for (const t of grid.querySelectorAll<HTMLElement>('.pt[data-id]')) paintPeople(t)
    },
    reveal: (path) => {
      search = ''
      kind = null
      goTo(folderOf(path))
      picked = [path]
      anchor = path
      paintPicked()
      tileAt(path)?.scrollIntoView({ block: 'nearest' })
    },
    named,
  }
}
