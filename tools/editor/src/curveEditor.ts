import { lastRatio, sampleCurve, type CurvePoint, type CurveSetting } from '@mp/mode'

/**
 * The curve editor (ADR 0088): a graph of control points for one `CurveSetting`.
 *
 * Drag a point to move it, click empty space to add one, double-click a point (or press Delete with it
 * selected) to remove it. Each is one `onChange`, and so one entry in the editor's one history (ADR 0162): the
 * graph keeps none of its own, and Ctrl+Z pressed in it goes on to the editor's.
 *
 * **View**: the wheel zooms around the cursor — X over the bottom axis, Y over the left axis, both over the
 * plot; right-drag or Shift-drag pans; `fit` (or F) frames the points again. Grid and labels follow the view, so
 * a zoomed-in cost curve reads `1.2K … 1.5K`, not decades. `⤢` opens the same graph four times larger over the
 * viewport, bound to the same points.
 *
 * On a log axis an exponential is a straight line, which is how a level-cost curve is meant to be read: "each
 * level costs ×1.15" is a slope. The readout under the graph names the value at the pointer and, for ratio
 * curves, the growth per unit the last segment implies.
 *
 * Pure DOM and canvas, no library: Tweakpane has no graph control, and this one has to know about
 * `sampleCurve`'s rules to draw what the game will compute.
 */
export interface CurveEditor {
  /** Replace the points shown (after an outside change); does not fire `onChange`. */
  set: (points: readonly CurvePoint[]) => void
  dispose: () => void
}

export interface CurveEditorOptions {
  decl: CurveSetting
  points: readonly CurvePoint[]
  /** A drag ended, a point was added or removed, or a field was edited. */
  onChange: (points: CurvePoint[]) => void
  /** Canvas size in CSS pixels. Default 320 × 170. */
  size?: { w: number; h: number }
  /** Hide the enlarge button (the enlarged copy hides it). */
  noEnlarge?: boolean
  /** Where the enlarged copy goes: the page (default), or a window over it that keeps its own keys. */
  overlayParent?: HTMLElement
}

const PAD = { l: 48, r: 10, t: 8, b: 22 }

const short = (n: number): string => {
  if (!Number.isFinite(n)) return '∞'
  const abs = Math.abs(n)
  for (const [size, suffix] of [
    [1e33, 'Dc'],
    [1e30, 'No'],
    [1e27, 'Oc'],
    [1e24, 'Sp'],
    [1e21, 'Sx'],
    [1e18, 'Qi'],
    [1e15, 'Qa'],
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const)
    if (abs >= size) return `${(n / size).toFixed(abs / size < 100 ? 2 : 1)}${suffix}`
  return abs >= 100 ? Math.round(n).toString() : Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** A "nice" tick step for a linear axis spanning `range` with about `n` ticks. */
const niceStep = (range: number, n: number): number => {
  const raw = range / Math.max(1, n)
  if (!(raw > 0)) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const r = raw / mag
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag
}

const btn = (text: string, title: string): HTMLButtonElement => {
  const b = document.createElement('button')
  b.className = 'ctl'
  b.textContent = text
  b.title = title
  return b
}

export const createCurveEditor = (container: HTMLElement, opts: CurveEditorOptions): CurveEditor => {
  const { decl } = opts
  const W = opts.size?.w ?? 320
  const H = opts.size?.h ?? 170
  const shape = { interpolation: decl.interpolation, beyond: decl.beyond }
  const log = decl.logY === true
  const yMin = decl.yMin ?? (log ? 1e-3 : 0)
  let points: CurvePoint[] = opts.points.map((p) => ({ ...p }))
  let selected = -1
  let hover: { x: number; y: number } | null = null

  // --- DOM ---
  const root = document.createElement('div')
  root.className = 'curve-ed'
  const canvas = document.createElement('canvas')
  canvas.className = 'curve-ed-canvas'
  canvas.tabIndex = 0
  const readout = document.createElement('div')
  readout.className = 'curve-ed-read'
  const fields = document.createElement('div')
  fields.className = 'curve-ed-fields'
  const xIn = document.createElement('input')
  const yIn = document.createElement('input')
  for (const [input, name] of [
    [xIn, decl.xLabel],
    [yIn, decl.yLabel],
  ] as const) {
    input.type = 'number'
    input.className = 'ctl curve-ed-num'
    input.title = name
    input.step = 'any'
  }
  const xLab = document.createElement('span')
  xLab.textContent = decl.xLabel
  const yLab = document.createElement('span')
  yLab.textContent = decl.yLabel
  const fitBtn = btn('fit', 'frame the points (F)')
  const reset = btn('default', 'put the declared default curve back')
  const bigBtn = btn('⤢', 'open large')
  fields.append(xLab, xIn, yLab, yIn, fitBtn, reset)
  if (opts.noEnlarge !== true) fields.append(bigBtn)
  root.append(canvas, readout, fields)
  container.append(root)

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b

  // --- view: what the plot shows. y is stored in "axis space": log10(y) on a log axis. ---
  const toAxis = (y: number): number => (log ? Math.log10(Math.max(y, yMin, 1e-300)) : y)
  const fromAxis = (a: number): number => (log ? 10 ** a : a)
  const view = { x0: 0, x1: 10, y0: 0, y1: 1 }

  const fit = (): void => {
    const last = points[points.length - 1]?.x ?? 10
    view.x0 = 0
    view.x1 = Math.max(10, Math.ceil((last * 1.25) / 10) * 10)
    const ys = points.map((p) => toAxis(p.y))
    ys.push(toAxis(sampleCurve(points, view.x1, shape))) // the extension is part of the picture
    const lo = Math.min(...ys)
    const hi = Math.max(...ys)
    if (log) {
      view.y0 = Math.floor(lo)
      view.y1 = Math.max(view.y0 + 1, Math.ceil(hi + 1e-9))
    } else {
      view.y0 = Math.min(0, lo)
      view.y1 = hi <= view.y0 ? view.y0 + 1 : view.y0 + (hi - view.y0) * 1.15
    }
  }
  fit()

  const toPx = (p: CurvePoint): { px: number; py: number } => ({
    px: PAD.l + ((p.x - view.x0) / (view.x1 - view.x0)) * plotW,
    py: PAD.t + plotH - ((toAxis(p.y) - view.y0) / (view.y1 - view.y0)) * plotH,
  })
  const fromPx = (px: number, py: number): CurvePoint => {
    const x = view.x0 + ((px - PAD.l) / plotW) * (view.x1 - view.x0)
    const a = view.y0 + ((PAD.t + plotH - py) / plotH) * (view.y1 - view.y0)
    return { x: Math.max(0, Math.round(x)), y: Math.max(yMin, fromAxis(a)) }
  }
  const zone = (px: number, py: number): 'plot' | 'xaxis' | 'yaxis' | 'out' => {
    const inX = px >= PAD.l && px <= W - PAD.r
    const inY = py >= PAD.t && py <= PAD.t + plotH
    if (inX && inY) return 'plot'
    if (inX && py > PAD.t + plotH) return 'xaxis'
    if (inY && px < PAD.l) return 'yaxis'
    return 'out'
  }

  // --- drawing ---
  const draw = (): void => {
    ctx.clearRect(0, 0, W, H)
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = 1
    // x grid
    const xs = niceStep(view.x1 - view.x0, Math.max(3, plotW / 60))
    ctx.textAlign = 'center'
    for (let x = Math.ceil(view.x0 / xs) * xs; x <= view.x1 + 1e-9; x += xs) {
      const { px } = toPx({ x, y: fromAxis(view.y0) })
      ctx.beginPath()
      ctx.moveTo(px, PAD.t)
      ctx.lineTo(px, PAD.t + plotH)
      ctx.stroke()
      ctx.fillText(short(x), px, H - PAD.b / 2)
    }
    // y grid: decades when a log view spans more than two; otherwise nice steps in axis space (log: fractions of
    // a decade, labelled with the real value).
    ctx.textAlign = 'right'
    const span = view.y1 - view.y0
    const ys = log && span > 2 ? 1 : niceStep(span, Math.max(2, plotH / 34))
    for (let a = Math.ceil(view.y0 / ys) * ys; a <= view.y1 + 1e-9; a += ys) {
      const { py } = toPx({ x: view.x0, y: fromAxis(a) })
      ctx.beginPath()
      ctx.moveTo(PAD.l, py)
      ctx.lineTo(W - PAD.r, py)
      ctx.stroke()
      ctx.fillText(short(fromAxis(a)), PAD.l - 4, py)
    }
    // the curve, clipped to the plot, sampled across the view so the extension shows
    ctx.save()
    ctx.beginPath()
    ctx.rect(PAD.l, PAD.t, plotW, plotH)
    ctx.clip()
    ctx.strokeStyle = '#7fb3ff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const N = Math.max(120, Math.floor(plotW / 2))
    for (let i = 0; i <= N; i++) {
      const x = view.x0 + (i / N) * (view.x1 - view.x0)
      const { px, py } = toPx({ x, y: sampleCurve(points, Math.max(0, x), shape) })
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    points.forEach((p, i) => {
      const { px, py } = toPx(p)
      ctx.beginPath()
      ctx.arc(px, py, i === selected ? 5 : 3.5, 0, Math.PI * 2)
      ctx.fillStyle = i === selected ? '#ffd166' : '#ffffff'
      ctx.fill()
    })
    ctx.restore()
    // readout
    const ratio = decl.interpolation === 'ratio' ? ` · ×${lastRatio(points).toFixed(4)} per ${decl.xLabel.toLowerCase()} on the last segment` : ''
    if (hover !== null && zone(hover.x, hover.y) === 'plot') {
      const at = fromPx(hover.x, hover.y)
      readout.textContent = `${decl.xLabel} ${at.x} → ${short(sampleCurve(points, at.x, shape))} ${decl.yLabel}${ratio}`
    } else {
      readout.textContent = `click adds · drag moves · double-click removes · wheel zooms · right-drag pans${ratio}`
    }
    const sel = points[selected]
    xIn.disabled = yIn.disabled = sel === undefined
    if (sel !== undefined && document.activeElement !== xIn) xIn.value = String(sel.x)
    if (sel !== undefined && document.activeElement !== yIn) yIn.value = String(Number(sel.y.toPrecision(6)))
  }

  const hit = (px: number, py: number): number => {
    let best = -1
    let bestD = 8
    points.forEach((p, i) => {
      const q = toPx(p)
      const d = Math.hypot(q.px - px, q.py - py)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  /** Keep x strictly between the neighbours, so points never cross. */
  const clampX = (i: number, x: number): number => {
    const lo = i > 0 ? points[i - 1]!.x + 1 : 0
    const hi = i < points.length - 1 ? points[i + 1]!.x - 1 : Number.POSITIVE_INFINITY
    return Math.min(hi, Math.max(lo, x))
  }

  // --- an edit ---
  const snapshot = (): CurvePoint[] => points.map((p) => ({ ...p }))
  const commit = (): void => {
    opts.onChange(snapshot())
    draw()
  }
  fitBtn.addEventListener('click', () => {
    fit()
    draw()
  })

  // --- pointer ---
  const local = (e: PointerEvent | MouseEvent | WheelEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }
  let dragging = false
  let moved = false
  let panning: { x: number; y: number; view: typeof view } | null = null

  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('pointerdown', (e) => {
    const at = local(e)
    canvas.focus()
    if (e.button === 2 || e.shiftKey) {
      panning = { x: at.x, y: at.y, view: { ...view } }
      canvas.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0 || zone(at.x, at.y) !== 'plot') return
    const i = hit(at.x, at.y)
    if (i >= 0) {
      selected = i
      dragging = true
      moved = false
      canvas.setPointerCapture(e.pointerId)
    } else {
      const p = fromPx(at.x, at.y)
      if (points.some((q) => q.x === p.x)) return
      points.push(p)
      points.sort((a, b) => a.x - b.x)
      selected = points.findIndex((q) => q.x === p.x)
      commit()
      return
    }
    draw()
  })
  canvas.addEventListener('pointermove', (e) => {
    const at = local(e)
    hover = at
    if (panning !== null) {
      const dx = ((at.x - panning.x) / plotW) * (panning.view.x1 - panning.view.x0)
      const dy = ((at.y - panning.y) / plotH) * (panning.view.y1 - panning.view.y0)
      view.x0 = Math.max(0, panning.view.x0 - dx)
      view.x1 = view.x0 + (panning.view.x1 - panning.view.x0)
      view.y0 = panning.view.y0 + dy
      view.y1 = panning.view.y1 + dy
    } else if (dragging && selected >= 0) {
      const p = fromPx(at.x, at.y)
      points[selected] = { x: clampX(selected, p.x), y: Math.max(yMin, p.y) }
      moved = true
    }
    draw()
  })
  const endPointer = (): void => {
    panning = null
    if (!dragging) return
    dragging = false
    if (moved) commit() // a click that moved nothing is not an edit
  }
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)
  canvas.addEventListener('pointerleave', () => {
    hover = null
    draw()
  })
  canvas.addEventListener('dblclick', (e) => {
    const at = local(e)
    const i = hit(at.x, at.y)
    if (i < 0 || points.length <= 1) return
    points.splice(i, 1)
    selected = -1
    commit()
  })
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const at = local(e)
      const z = zone(at.x, at.y)
      if (z === 'out') return
      const f = Math.exp(Math.sign(e.deltaY) * 0.18)
      const anchor = fromPx(at.x, at.y)
      if (z !== 'yaxis') {
        const ax = view.x0 + ((at.x - PAD.l) / plotW) * (view.x1 - view.x0)
        view.x0 = Math.max(0, ax - (ax - view.x0) * f)
        view.x1 = Math.max(view.x0 + 2, ax + (view.x1 - ax) * f)
      }
      if (z !== 'xaxis') {
        const ay = toAxis(anchor.y)
        const y0 = ay - (ay - view.y0) * f
        const y1 = ay + (view.y1 - ay) * f
        const minSpan = log ? 0.05 : 1e-6
        if (y1 - y0 >= minSpan) {
          view.y0 = y0
          view.y1 = y1
        }
      }
      draw()
    },
    { passive: false },
  )
  canvas.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (k === 'f' && !mod) {
      fit()
      draw()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0 && points.length > 1) {
      points.splice(selected, 1)
      selected = -1
      commit()
    } else return
    e.preventDefault()
    e.stopPropagation()
  })

  // --- fields ---
  const fieldChange = (): void => {
    const sel = points[selected]
    if (sel === undefined) return
    const x = Number(xIn.value)
    const y = Number(yIn.value)
    if (Number.isFinite(x)) sel.x = clampX(selected, Math.max(0, Math.round(x)))
    if (Number.isFinite(y)) sel.y = Math.max(yMin, y)
    commit()
  }
  xIn.addEventListener('change', fieldChange)
  yIn.addEventListener('change', fieldChange)
  reset.addEventListener('click', () => {
    points = decl.default.map((p) => ({ ...p }))
    selected = -1
    fit()
    commit()
  })

  // --- enlarge: the same graph, four times the area, over the viewport, bound to the same points ---
  let big: { overlay: HTMLElement; editor: CurveEditor } | null = null
  const closeBig = (): void => {
    if (big === null) return
    big.editor.dispose()
    big.overlay.remove()
    big = null
  }
  bigBtn.addEventListener('click', () => {
    if (big !== null) {
      closeBig()
      return
    }
    const overlay = document.createElement('div')
    overlay.className = 'curve-ed-big'
    const head = document.createElement('div')
    head.className = 'curve-ed-big-h'
    const title = document.createElement('span')
    title.textContent = `${decl.label} — ${decl.yLabel} over ${decl.xLabel}`
    const close = btn('✕', 'close (Esc)')
    close.addEventListener('click', closeBig)
    head.append(title, close)
    const body = document.createElement('div')
    overlay.append(head, body)
    ;(opts.overlayParent ?? document.body).append(overlay)
    const size = { w: Math.min(1100, window.innerWidth - 80), h: Math.min(560, window.innerHeight - 160) }
    const editor = createCurveEditor(body, {
      decl,
      points,
      size,
      noEnlarge: true,
      onChange: (next) => {
        points = next.map((p) => ({ ...p }))
        selected = -1
        opts.onChange(next)
        draw()
      },
    })
    overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      // Its own: a window it opened over shuts only on the next.
      e.stopPropagation()
      closeBig()
    })
    big = { overlay, editor }
  })

  draw()
  return {
    set: (next) => {
      points = next.map((p) => ({ ...p }))
      selected = Math.min(selected, points.length - 1)
      big?.editor.set(points)
      draw()
    },
    dispose: () => {
      closeBig()
      root.remove()
    },
  }
}
