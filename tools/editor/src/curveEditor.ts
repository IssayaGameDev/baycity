import { lastRatio, sampleCurve, type CurvePoint, type CurveSetting } from '@mp/mode'

/**
 * The curve editor (ADR 0088): a graph of control points for one `CurveSetting`.
 *
 * Drag a point to move it, click empty space to add one, double-click a point (or press Delete with it
 * selected) to remove it. On a log axis an exponential is a straight line, which is how a level-cost curve is
 * meant to be read: "each level costs ×1.15" is a slope. The readout under the graph names the value at the
 * pointer and, for ratio curves, the growth per unit the last segment implies.
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
}

const W = 320
const H = 170
const PAD = { l: 44, r: 10, t: 8, b: 22 }

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
  const mag = 10 ** Math.floor(Math.log10(raw))
  const r = raw / mag
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag
}

export const createCurveEditor = (container: HTMLElement, opts: CurveEditorOptions): CurveEditor => {
  const { decl } = opts
  const shape = { interpolation: decl.interpolation, beyond: decl.beyond }
  const yMin = decl.yMin ?? (decl.logY ? 1e-3 : 0)
  let points: CurvePoint[] = opts.points.map((p) => ({ ...p }))
  let selected = -1
  let hover: { x: number; y: number } | null = null

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
  const reset = document.createElement('button')
  reset.className = 'ctl'
  reset.textContent = 'default'
  reset.title = 'put the declared default curve back'
  fields.append(xLab, xIn, yLab, yIn, reset)
  root.append(canvas, readout, fields)
  container.append(root)

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)

  // --- axes ---
  const xMax = (): number => {
    const last = points[points.length - 1]?.x ?? 10
    return Math.max(10, Math.ceil((last * 1.25) / 10) * 10)
  }
  const yRange = (): { lo: number; hi: number } => {
    const ys = points.map((p) => p.y)
    // The extension past the last point is part of the picture: sample the right edge too.
    ys.push(sampleCurve(points, xMax(), shape))
    const max = Math.max(...ys, yMin + 1e-9)
    const min = Math.min(...ys)
    if (decl.logY) {
      const lo = 10 ** Math.floor(Math.log10(Math.max(yMin, min, 1e-9)))
      const hi = 10 ** Math.ceil(Math.log10(max) + 1e-9)
      return { lo, hi: hi <= lo ? lo * 10 : hi }
    }
    return { lo: Math.min(0, min), hi: max * 1.15 || 1 }
  }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const toPx = (p: CurvePoint, yr = yRange()): { px: number; py: number } => {
    const px = PAD.l + (p.x / xMax()) * plotW
    const fy = decl.logY ? (Math.log10(Math.max(p.y, yr.lo)) - Math.log10(yr.lo)) / (Math.log10(yr.hi) - Math.log10(yr.lo)) : (p.y - yr.lo) / (yr.hi - yr.lo)
    return { px, py: PAD.t + plotH - fy * plotH }
  }
  const fromPx = (px: number, py: number, yr = yRange()): CurvePoint => {
    const x = ((px - PAD.l) / plotW) * xMax()
    const fy = (PAD.t + plotH - py) / plotH
    const y = decl.logY ? 10 ** (Math.log10(yr.lo) + fy * (Math.log10(yr.hi) - Math.log10(yr.lo))) : yr.lo + fy * (yr.hi - yr.lo)
    return { x: Math.max(0, Math.round(x)), y: Math.max(yMin, y) }
  }

  const draw = (): void => {
    const yr = yRange()
    ctx.clearRect(0, 0, W, H)
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    // grid + labels
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = 1
    const xs = niceStep(xMax(), 6)
    for (let x = 0; x <= xMax() + 1e-9; x += xs) {
      const { px } = toPx({ x, y: yr.lo }, yr)
      ctx.beginPath()
      ctx.moveTo(px, PAD.t)
      ctx.lineTo(px, PAD.t + plotH)
      ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillText(String(Math.round(x)), px, H - PAD.b / 2)
    }
    ctx.textAlign = 'right'
    if (decl.logY) {
      for (let e = Math.log10(yr.lo); e <= Math.log10(yr.hi) + 1e-9; e += 1) {
        const y = 10 ** e
        const { py } = toPx({ x: 0, y }, yr)
        ctx.beginPath()
        ctx.moveTo(PAD.l, py)
        ctx.lineTo(W - PAD.r, py)
        ctx.stroke()
        ctx.fillText(short(y), PAD.l - 4, py)
      }
    } else {
      const ys = niceStep(yr.hi - yr.lo, 4)
      for (let y = Math.ceil(yr.lo / ys) * ys; y <= yr.hi + 1e-9; y += ys) {
        const { py } = toPx({ x: 0, y }, yr)
        ctx.beginPath()
        ctx.moveTo(PAD.l, py)
        ctx.lineTo(W - PAD.r, py)
        ctx.stroke()
        ctx.fillText(short(y), PAD.l - 4, py)
      }
    }
    // curve, sampled across the whole axis so the extension shows
    ctx.strokeStyle = '#7fb3ff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const N = 160
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * xMax()
      const { px, py } = toPx({ x, y: sampleCurve(points, x, shape) }, yr)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    // points
    points.forEach((p, i) => {
      const { px, py } = toPx(p, yr)
      ctx.beginPath()
      ctx.arc(px, py, i === selected ? 5 : 3.5, 0, Math.PI * 2)
      ctx.fillStyle = i === selected ? '#ffd166' : '#ffffff'
      ctx.fill()
    })
    // hover readout
    if (hover !== null) {
      const at = fromPx(hover.x, hover.y, yr)
      const y = sampleCurve(points, at.x, shape)
      readout.textContent = `${decl.xLabel} ${at.x} → ${short(y)} ${decl.yLabel}${decl.interpolation === 'ratio' ? ` · ×${lastRatio(points).toFixed(4)} per ${decl.xLabel.toLowerCase()} past the last point` : ''}`
    } else {
      readout.textContent =
        decl.interpolation === 'ratio' ? `×${lastRatio(points).toFixed(4)} per ${decl.xLabel.toLowerCase()} on the last segment · click to add a point, drag to move, double-click to remove` : 'click to add a point, drag to move, double-click to remove'
    }
    // fields
    const sel = points[selected]
    xIn.disabled = yIn.disabled = sel === undefined
    if (sel !== undefined && document.activeElement !== xIn) xIn.value = String(sel.x)
    if (sel !== undefined && document.activeElement !== yIn) yIn.value = String(Number(sel.y.toPrecision(6)))
  }

  const hit = (px: number, py: number): number => {
    const yr = yRange()
    let best = -1
    let bestD = 8
    points.forEach((p, i) => {
      const q = toPx(p, yr)
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

  const commit = (): void => {
    opts.onChange(points.map((p) => ({ ...p })))
    draw()
  }

  const local = (e: PointerEvent | MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  let dragging = false
  let moved = false
  canvas.addEventListener('pointerdown', (e) => {
    const at = local(e)
    const i = hit(at.x, at.y)
    canvas.focus()
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
    if (dragging && selected >= 0) {
      const p = fromPx(at.x, at.y)
      points[selected] = { x: clampX(selected, p.x), y: Math.max(yMin, p.y) }
      moved = true
    }
    draw()
  })
  const endDrag = (): void => {
    if (!dragging) return
    dragging = false
    if (moved) commit()
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
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
  canvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0 && points.length > 1) {
      points.splice(selected, 1)
      selected = -1
      commit()
      e.preventDefault()
    }
  })
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
    commit()
  })

  draw()
  return {
    set: (next) => {
      points = next.map((p) => ({ ...p }))
      selected = Math.min(selected, points.length - 1)
      draw()
    },
    dispose: () => root.remove(),
  }
}
