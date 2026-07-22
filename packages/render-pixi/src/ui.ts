import { Application, Container, Graphics, Rectangle, Text, type FederatedPointerEvent, type FederatedWheelEvent } from 'pixi.js'

/**
 * Reusable Pixi UI widgets (ADR 0015 — PixiJS is the game-UI layer). Placeholder-skinned
 * with `Graphics` for now; each widget isolates its drawing so it can later be re-skinned
 * with Layer Lab sprites (`NineSliceSprite` for panels/buttons, `Sprite` for the handle/✕)
 * without touching layout or behavior. Browser-only (DOM lib).
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
}
export interface ListOpts {
  width: number
  height: number
  rowHeight?: number
}
export interface UiList {
  readonly view: Container
  setItems: (items: ListItem[]) => void
}

export const uiList = (o: ListOpts): UiList => {
  const rowH = o.rowHeight ?? 30
  const view = new Container()
  const content = new Container()
  const clip = new Graphics().rect(0, 0, o.width, o.height).fill({ color: 0xffffff })
  view.addChild(content, clip)
  content.mask = clip

  let contentH = 0
  const clampScroll = (): void => {
    const min = Math.min(0, o.height - contentH)
    content.y = content.y < min ? min : content.y > 0 ? 0 : content.y
  }

  view.eventMode = 'static'
  view.hitArea = new Rectangle(0, 0, o.width, o.height)
  view.on('wheel', (e: FederatedWheelEvent) => {
    content.y -= e.deltaY
    clampScroll()
  })

  return {
    view,
    setItems: (items) => {
      content.removeChildren()
      items.forEach((it, i) => {
        const row = new Container()
        row.y = i * rowH
        if (it.highlight === true) {
          row.addChild(new Graphics().roundRect(0, 2, o.width, rowH - 4, 6).fill({ color: 0x3b82f6, alpha: 0.25 }))
        }
        const label = uiLabel(it.text, { size: 15, color: it.highlight === true ? 0xffffff : 0xcbd5e1 })
        label.position.set(10, rowH / 2 - 9)
        row.addChild(label)
        content.addChild(row)
      })
      contentH = items.length * rowH
      content.y = 0
    },
  }
}
