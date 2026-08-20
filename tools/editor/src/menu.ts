/**
 * The editor's one context menu, with submenus.
 *
 * Hand-rolled, not a library. A menu library would be a new runtime dependency for about two hundred lines,
 * and the shape is already settled: an item is `{ label, run, enabled }`, which is the same shape
 * `shortcuts.ts` uses for a key binding — so the same command can be reached from either without being
 * described twice.
 *
 * One module rather than one per surface. There were three ad-hoc menus: the timeline's right-click on a key,
 * the Inspector's `⋯`, and the Project panel's `window.prompt()` where clearing the name deleted the file.
 * They looked different, behaved differently, and only one of them closed on Escape.
 *
 * What it deliberately does not have: icons and checkable items. Both are real additions rather than tweaks,
 * and nothing needs one.
 */

/** Where a menu's top-left corner goes, given the pointer and the space available. */
export interface MenuPlacement {
  readonly left: number
  readonly top: number
}

/**
 * Keep the menu on screen: flip it back over the pointer when it would overhang, and never push it past the
 * top-left. Pure, because getting it wrong is invisible until somebody right-clicks near an edge — which, in
 * a panel pinned to the right of the window, is most of the time.
 *
 * Flipped rather than clamped: a clamped menu sits *under* the pointer and the first item is whatever the
 * cursor happens to be over, which is how a right-click turns into an accidental delete.
 */
export const menuPlacement = (
  at: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  margin = 4,
): MenuPlacement => {
  const left = at.x + size.width + margin > viewport.width ? at.x - size.width : at.x
  const top = at.y + size.height + margin > viewport.height ? at.y - size.height : at.y
  return { left: Math.max(margin, left), top: Math.max(margin, top) }
}

/**
 * Where a **submenu** goes: alongside its parent item, not under the pointer.
 *
 * Overlaps the parent panel by a few pixels on purpose, so the diagonal travel from the item to the child has
 * no gap in it to fall through. Flips to the parent's left edge when there is no room on the right, which for
 * a panel docked to the right of the window is the normal case rather than the exception.
 */
export const submenuPlacement = (
  item: { readonly right: number; readonly left: number; readonly top: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  margin = 4,
  overlap = 3,
): MenuPlacement => {
  const rightOf = item.right - overlap
  const leftOf = item.left - size.width + overlap
  const left = rightOf + size.width + margin > viewport.width ? leftOf : rightOf
  const top = item.top + size.height + margin > viewport.height ? viewport.height - size.height - margin : item.top
  return { left: Math.max(margin, left), top: Math.max(margin, top) }
}

export interface MenuItem {
  readonly label: string
  /** What choosing it does. Absent on an item that only opens a submenu. */
  readonly run?: () => void
  /** A submenu. An item with children ignores `run`. */
  readonly items?: readonly MenuItem[]
  /**
   * Absent means enabled.
   *
   * A disabled item **stays in the menu**, greyed, rather than being left out. An operation refused on an
   * inherited node (delete, duplicate, reparent) otherwise does nothing at all with no explanation, and a menu
   * that silently omits it teaches nothing either.
   */
  readonly enabled?: boolean
  /** Why it is disabled, shown as the item's tooltip. Pointless unless `enabled` is false. */
  readonly why?: string
  /** Right-aligned shortcut hint (`Ctrl+D`), so the menu teaches the keyboard instead of replacing it. */
  readonly hint?: string
  /** Draw a divider above this item. */
  readonly divider?: boolean
}

export interface ContextMenu {
  /** Open at a point, with a heading that says what the menu is about. */
  open: (at: { x: number; y: number }, items: readonly MenuItem[], title?: string) => void
  close: () => void
  isOpen: () => boolean
}

/** How long a submenu survives the pointer leaving its parent item, so diagonal travel works. */
const HOVER_CLOSE_MS = 220

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** One open panel: its element, and the enabled buttons the arrow keys walk. */
interface Panel {
  readonly root: HTMLElement
  readonly walkable: HTMLButtonElement[]
  cursor: number
}

/**
 * One menu for the whole editor: opening a second closes the first, because two root menus at once is always a
 * bug and never a feature.
 */
export const createContextMenu = (): ContextMenu => {
  /** Root first, deepest last. */
  let stack: Panel[] = []
  let closeTimer: number | null = null

  const cancelTimer = (): void => {
    if (closeTimer !== null) window.clearTimeout(closeTimer)
    closeTimer = null
  }

  /** Close every panel deeper than `depth`, leaving `depth` itself open. */
  const closeBelow = (depth: number): void => {
    while (stack.length > depth + 1) stack.pop()?.root.remove()
  }

  const close = (): void => {
    cancelTimer()
    for (const panel of stack) panel.root.remove()
    stack = []
  }

  const focusIn = (panel: Panel, next: number): void => {
    if (panel.walkable.length === 0) return
    panel.cursor = (next + panel.walkable.length) % panel.walkable.length
    panel.walkable[panel.cursor]?.focus()
  }

  /**
   * Build a panel and place it. `anchor` is a point for the root, or the parent item's box for a submenu —
   * a submenu goes beside what opened it, not under the pointer that happened to be passing.
   */
  const build = (items: readonly MenuItem[], anchor: { x: number; y: number } | HTMLElement, title: string | undefined, depth: number): void => {
    const root = el('div', 'menu')
    // Off-screen for one frame so the real size can be measured before it is placed: reading a width from an
    // element that is not in the document yet returns zero, and zero never overhangs anything.
    root.style.visibility = 'hidden'
    root.style.left = '0px'
    root.style.top = '0px'
    if (title !== undefined) root.append(el('div', 'menu-head', title))

    const panel: Panel = { root, walkable: [], cursor: -1 }

    for (const item of items) {
      if (item.divider === true) root.append(el('div', 'menu-div'))
      const button = el('button')
      button.append(el('span', 'menu-label', item.label))
      const children = item.items
      const hasChildren = children !== undefined && children.length > 0
      if (hasChildren) button.append(el('span', 'menu-more', '›'))
      else if (item.hint !== undefined) button.append(el('span', 'menu-hint', item.hint))

      const enabled = item.enabled !== false
      button.disabled = !enabled
      if (!enabled && item.why !== undefined) button.title = item.why

      if (enabled) {
        panel.walkable.push(button)
        if (hasChildren) {
          const openChild = (): void => {
            cancelTimer()
            // Already showing this one: re-opening would rebuild it under the pointer mid-travel.
            if (stack.length > depth + 1 && stack[depth + 1]?.root.dataset.owner === button.dataset.key) return
            closeBelow(depth)
            build(children, button, undefined, depth + 1)
          }
          button.dataset.key = String(panel.walkable.length)
          button.addEventListener('pointerenter', openChild)
          button.addEventListener('click', openChild)
          button.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            openChild()
            const child = stack[depth + 1]
            if (child !== undefined) focusIn(child, 0)
          })
        } else {
          // Anything without children closes the *whole* stack when chosen, then acts.
          button.addEventListener('pointerenter', () => {
            // Leaving a submenu's parent for a plain sibling means the submenu is no longer wanted, but not
            // instantly: the pointer crosses siblings on its way into a child panel.
            cancelTimer()
            closeTimer = window.setTimeout(() => closeBelow(depth), HOVER_CLOSE_MS)
          })
          // `click` rather than `pointerdown`: the press that opened the menu must not also choose an item.
          button.addEventListener('click', () => {
            close()
            item.run?.()
          })
        }
      }
      root.append(button)
    }

    document.body.append(root)
    const rect = root.getBoundingClientRect()
    const size = { width: rect.width, height: rect.height }
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const where =
      anchor instanceof HTMLElement
        ? submenuPlacement(anchor.getBoundingClientRect(), size, viewport)
        : menuPlacement(anchor, size, viewport)
    root.style.left = `${where.left}px`
    root.style.top = `${where.top}px`
    root.style.visibility = 'visible'
    root.tabIndex = -1
    if (anchor instanceof HTMLElement) root.dataset.owner = anchor.dataset.key ?? ''
    // A panel keeps its own child alive while the pointer is inside it, and drops it on the way out.
    root.addEventListener('pointerenter', cancelTimer)
    stack.push(panel)
    // Focus the panel, not its first item: arrowing in should be a decision, and a menu that opens with an
    // item already highlighted is a menu where Enter deletes something.
    if (depth === 0) root.focus()
  }

  const open = (at: { x: number; y: number }, items: readonly MenuItem[], title?: string): void => {
    close()
    if (items.length === 0) return
    build(items, at, title, 0)
  }

  const deepest = (): Panel | undefined => stack[stack.length - 1]

  // Dismissal, in one place. `pointerdown` rather than `click` so a press anywhere else closes the menu before
  // that press does anything, and `capture` so a panel that stops propagation cannot leave it stranded.
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (stack.length === 0) return
      const inside = stack.some((panel) => panel.root.contains(e.target as Node))
      if (!inside) close()
    },
    true,
  )
  // Scrolling or resizing moves what the menu was pointing at, so the menu is no longer about anything.
  window.addEventListener('wheel', () => close(), { passive: true, capture: true })
  window.addEventListener('resize', () => close())
  window.addEventListener('blur', () => close())
  window.addEventListener('keydown', (e) => {
    const panel = deepest()
    if (panel === undefined) return
    if (e.key === 'Escape') {
      e.stopPropagation() // Escape closes the menu, not the selection behind it
      if (stack.length > 1) closeBelow(stack.length - 2)
      else close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusIn(panel, panel.cursor + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusIn(panel, panel.cursor - 1)
    } else if (e.key === 'ArrowLeft' && stack.length > 1) {
      e.preventDefault()
      const parent = stack[stack.length - 2]!
      closeBelow(stack.length - 2)
      focusIn(parent, parent.cursor)
    }
  })

  return { open, close, isOpen: () => stack.length > 0 }
}
