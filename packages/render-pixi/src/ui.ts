import { Application, Container, Graphics, Rectangle, Text, type FederatedPointerEvent, type FederatedWheelEvent } from 'pixi.js'

/**
 * Reusable Pixi UI widgets (ADR 0015 — PixiJS is the game-UI layer). Drawn with `Graphics`;
 * each widget isolates its drawing so the visual style can be changed in one place without
 * touching layout or behavior. Browser-only (DOM lib).
 */

// ---- overlay -----------------------------------------------------------------

export interface UiOverlay {
  /** Transparent canvas to stack over the Three.js canvas. */
  readonly canvas: HTMLCanvasElement
  /** Add screens/widgets here (in front of the background catch). */
  readonly root: Container
  width: number
  height: number
  resize: (width: number, height: number) => void
  /** Toggle whether the overlay captures pointer events at the DOM level. */
  setInteractive: (on: boolean) => void
  /** Called when the pointer taps empty overlay space (not a widget) — used to
   * re-capture the mouse for look control. */
  setBackgroundTap: (fn: (() => void) | null) => void
  /**
   * Whether a widget — anything that takes the pointer, not the empty space behind them all — is under this point,
   * in overlay pixels. For the touch controls, so a tap on a HUD button is not also a thumb on the stick (ADR 0203).
   */
  widgetAt: (x: number, y: number) => boolean
  dispose: () => void
}

export const createUiOverlay = async (opts: { width: number; height: number }): Promise<UiOverlay> => {
  const app = new Application()
  await app.init({
    width: opts.width,
    height: opts.height,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  })
  app.canvas.style.pointerEvents = 'auto'

  // A full-screen catch behind all widgets: taps on empty space (no widget hit) fall here.
  const backdrop = new Container()
  backdrop.eventMode = 'static'
  backdrop.hitArea = new Rectangle(0, 0, opts.width, opts.height)
  let bgTap: (() => void) | null = null
  backdrop.on('pointertap', () => bgTap?.())
  const root = new Container()
  app.stage.addChild(backdrop, root)

  const overlay: UiOverlay = {
    canvas: app.canvas,
    root,
    width: opts.width,
    height: opts.height,
    resize: (w, h) => {
      overlay.width = w
      overlay.height = h
      app.renderer.resize(w, h)
      backdrop.hitArea = new Rectangle(0, 0, w, h)
    },
    setInteractive: (on) => {
      app.canvas.style.pointerEvents = on ? 'auto' : 'none'
    },
    setBackgroundTap: (fn) => {
      bgTap = fn
    },
    widgetAt: (x, y) => {
      const hit = app.renderer.events.rootBoundary.hitTest(x, y)
      return hit !== null && hit !== backdrop
    },
    dispose: () => app.destroy(true),
  }
  return overlay
}

// ---- colour helpers (placeholder styling) ------------------------------------

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const mix = (a: number, b: number, t: number): number => {
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}
const lighten = (c: number): number => mix(c, 0xffffff, 0.14)
const darken = (c: number): number => mix(c, 0x000000, 0.16)

/** An empty container for grouping/positioning widgets (so a screen can be scaled/centered
 * as one unit). */
export const uiGroup = (): Container => new Container()

// ---- label -------------------------------------------------------------------

export interface LabelStyle {
  size?: number
  color?: number
  weight?: 'normal' | 'bold' | '600' | '700'
  align?: 'left' | 'center' | 'right'
}

export const uiLabel = (text: string, style: LabelStyle = {}): Text =>
  new Text({
    text,
    style: {
      fill: style.color ?? 0xe5e7eb,
      fontSize: style.size ?? 16,
      fontFamily: 'system-ui, sans-serif',
      fontWeight: style.weight ?? 'normal',
      align: style.align ?? 'left',
    },
  })

// ---- panel (window background) ----------------------------------------------

export interface PanelOpts {
  width: number
  height: number
  color?: number
  alpha?: number
  radius?: number
}

/** A window/panel background. Placeholder = rounded rect; skins to a 9-slice sprite. */
export const uiPanel = (o: PanelOpts): Container => {
  const c = new Container()
  const bg = new Graphics()
    .roundRect(0, 0, o.width, o.height, o.radius ?? 16)
    .fill({ color: o.color ?? 0x1b1f2a, alpha: o.alpha ?? 0.98 })
    .stroke({ width: 2, color: 0x2f3646, alpha: 1 })
  c.addChild(bg)
  return c
}

// ---- button ------------------------------------------------------------------

export interface ButtonOpts {
  label: string
  width: number
  height?: number
  color?: number
  onClick: () => void
}
export interface UiButton {
  readonly view: Container
  setLabel: (text: string) => void
  /** Change the base (idle) fill — e.g. to mark a selected item. */
  setColor: (color: number) => void
}

export const uiButton = (o: ButtonOpts): UiButton => {
  const h = o.height ?? 44
  let base = o.color ?? 0x3b82f6
  const view = new Container()
  const bg = new Graphics()
  const paint = (fill: number): void => {
    bg.clear().roundRect(0, 0, o.width, h, 10).fill({ color: fill })
  }
  paint(base)
  const text = uiLabel(o.label, { size: 16, weight: '600', color: 0xffffff, align: 'center' })
  text.anchor.set(0.5)
  text.position.set(o.width / 2, h / 2)
  view.addChild(bg, text)

  view.eventMode = 'static'
  view.cursor = 'pointer'
  view.hitArea = new Rectangle(0, 0, o.width, h)
  view.on('pointerover', () => paint(lighten(base)))
  view.on('pointerout', () => paint(base))
  view.on('pointerdown', () => paint(darken(base)))
  view.on('pointerup', () => {
    paint(lighten(base))
    o.onClick()
  })
  view.on('pointerupoutside', () => paint(base))
  return {
    view,
    setLabel: (t) => (text.text = t),
    setColor: (c) => {
      base = c
      paint(base)
    },
  }
}

// ---- slider (0..1) -----------------------------------------------------------

export interface SliderOpts {
  width: number
  value: number // 0..1
  onChange: (value: number) => void
}
export interface UiSlider {
  readonly view: Container
  setValue: (value: number) => void
}

export const uiSlider = (o: SliderOpts): UiSlider => {
  const h = 24
  const trackH = 8
  const handleR = 11
  const view = new Container()
  const track = new Graphics().roundRect(0, h / 2 - trackH / 2, o.width, trackH, trackH / 2).fill({ color: 0x2f3646 })
  const fill = new Graphics()
  const handle = new Graphics().circle(0, h / 2, handleR).fill({ color: 0xffffff })
  let v = clamp01(o.value)
  const redraw = (): void => {
    const x = v * o.width
    fill.clear().roundRect(0, h / 2 - trackH / 2, x, trackH, trackH / 2).fill({ color: 0x3b82f6 })
    handle.position.x = x
  }
  redraw()
  view.addChild(track, fill, handle)

  view.eventMode = 'static'
  view.cursor = 'pointer'
  view.hitArea = new Rectangle(-handleR, 0, o.width + handleR * 2, h)
  let dragging = false
  const apply = (e: FederatedPointerEvent): void => {
    v = clamp01(view.toLocal(e.global).x / o.width)
    redraw()
    o.onChange(v)
  }
  view.on('pointerdown', (e) => {
    dragging = true
    apply(e)
  })
  view.on('globalpointermove', (e) => {
    if (dragging) apply(e)
  })
  view.on('pointerup', () => (dragging = false))
  view.on('pointerupoutside', () => (dragging = false))
  return {
    view,
    setValue: (nv) => {
      v = clamp01(nv)
      redraw()
    },
  }
}

// ---- vertical list (scrolls) -------------------------------------------------

export interface ListItem {
  text: string
  highlight?: boolean
  /** Greyed: a row there but not available — a checkpoint not yet reached (ADR 0211). Give it no `onPick`. */
  muted?: boolean
  /** Makes the row a button: a tap on it calls this — a press that travels is a drag of the list instead (ADR 0203). */
  onPick?: () => void
}
export interface ListOpts {
  width: number
  height: number
  rowHeight?: number
  /** The rows' type size; 15 by default. */
  textSize?: number
}
export interface UiList {
  readonly view: Container
  setItems: (items: ListItem[]) => void
}

/** How far a press may travel and still be a tap on a row rather than a drag of the list, in overlay pixels. */
export const LIST_DRAG_SLOP = 6

/** The scroll a list may take: 0 at the top, never past its last row, and 0 when it all fits. */
export const clampListScroll = (y: number, viewHeight: number, contentHeight: number): number => Math.min(0, Math.max(viewHeight - contentHeight, y))

/** The row `localY` down a list's view is over, at scroll `scrollY`; -1 for none. */
export const listRowAt = (localY: number, scrollY: number, rowHeight: number, count: number): number => {
  const i = Math.floor((localY - scrollY) / rowHeight)
  return i >= 0 && i < count ? i : -1
}

/**
 * A vertical list that scrolls — the wheel, or a drag, which is how a finger scrolls. A row with `onPick` is a
 * button: lit while the pointer is over it, picked by a tap that did not travel past `LIST_DRAG_SLOP`.
 */
export const uiList = (o: ListOpts): UiList => {
  const rowH = o.rowHeight ?? 30
  const view = new Container()
  const content = new Container()
  const clip = new Graphics().rect(0, 0, o.width, o.height).fill({ color: 0xffffff })
  view.addChild(content, clip)
  content.mask = clip

  let items: ListItem[] = []
  let backs: Graphics[] = []
  let hovered = -1
  const contentH = (): number => items.length * rowH
  const paintRow = (i: number): void => {
    const it = items[i]
    const back = backs[i]
    if (it === undefined || back === undefined) return
    back.clear()
    if (it.highlight === true) back.roundRect(0, 2, o.width, rowH - 4, 6).fill({ color: 0x3b82f6, alpha: 0.25 })
    else if (it.onPick !== undefined) back.roundRect(0, 2, o.width, rowH - 4, 6).fill({ color: 0x2f3646, alpha: i === hovered ? 1 : 0.55 })
  }
  const hover = (i: number): void => {
    if (i === hovered) return
    const was = hovered
    hovered = i
    paintRow(was)
    paintRow(i)
    view.cursor = items[i]?.onPick !== undefined ? 'pointer' : 'default'
  }
  const rowUnder = (e: FederatedPointerEvent): number => listRowAt(view.toLocal(e.global).y, content.y, rowH, items.length)

  view.eventMode = 'static'
  view.hitArea = new Rectangle(0, 0, o.width, o.height)
  view.on('wheel', (e: FederatedWheelEvent) => {
    content.y = clampListScroll(content.y - e.deltaY, o.height, contentH())
  })
  /** The press in progress: where it started, the scroll it started at, and whether it has become a drag. */
  let press: { id: number; startY: number; startScroll: number; dragged: boolean } | null = null
  view.on('pointerdown', (e) => {
    press = { id: e.pointerId, startY: e.global.y, startScroll: content.y, dragged: false }
  })
  view.on('globalpointermove', (e) => {
    if (press === null || e.pointerId !== press.id) return
    const dy = e.global.y - press.startY
    if (!press.dragged && Math.abs(dy) > LIST_DRAG_SLOP) {
      press.dragged = true
      hover(-1)
    }
    if (press.dragged) content.y = clampListScroll(press.startScroll + dy, o.height, contentH())
  })
  view.on('pointermove', (e) => {
    if (press === null) hover(rowUnder(e))
  })
  view.on('pointerout', () => hover(-1))
  view.on('pointerup', (e) => {
    const was = press
    press = null
    if (was === null || was.dragged || e.pointerId !== was.id) return
    items[rowUnder(e)]?.onPick?.()
  })
  view.on('pointerupoutside', () => {
    press = null
  })

  return {
    view,
    setItems: (next) => {
      content.removeChildren()
      items = next
      hovered = -1
      backs = next.map((it, i) => {
        const row = new Container()
        row.y = i * rowH
        const back = new Graphics()
        const color = it.muted === true ? 0x64748b : it.highlight === true || it.onPick !== undefined ? 0xffffff : 0xcbd5e1
        const label = uiLabel(it.text, { size: o.textSize ?? 15, color })
        label.anchor.set(0, 0.5)
        label.position.set(10, rowH / 2)
        row.addChild(back, label)
        content.addChild(row)
        return back
      })
      next.forEach((_it, i) => paintRow(i))
      content.y = 0
    },
  }
}
