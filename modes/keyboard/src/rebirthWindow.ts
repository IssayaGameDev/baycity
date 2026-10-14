import { Container, Graphics, uiButton, uiLabel } from '@mp/render-pixi'
import type { TpsClient } from '@mp/tps'

import { hudScale } from './hud'
import { multiplierText, rebirthLevelAt, rebirthMultiplierAt, type ProgressCurve } from './progression'
import { SIDE_BUTTON, sideButtonY } from './sideButtons'
import { slideOut, stepSlide } from './teleportWindow'

/**
 * The rebirth window (ADR 0221), Kodjo's calls: a **Rebirth** button on the left edge under Teleport opens a box that
 * slides in from the left, as Teleport's does — the Level the next rebirth needs, the XP multiplier now and after it,
 * that it resets your Level, your Level against the one needed, and the Rebirth button, greyed with "Need Level X"
 * until you have it. A rebirth closes it. ✕, Esc or a tap outside close it too, through the hold's `onOutside`.
 *
 * The cost is the Level and nothing else: no Wins are paid (Kodjo's call). Our own look, not the Roblox one.
 */

/** What the window shows, for a player at `level` who has reborn `rebirths` times. Pure. */
export interface RebirthView {
  readonly level: number
  /** The Level the next rebirth needs. */
  readonly need: number
  /** The XP multiplier now, and after the next rebirth: the whole of each. */
  readonly now: number
  readonly next: number
  readonly ready: boolean
  /** `level / need`, 0 to 1: the bar. */
  readonly fraction: number
}

export const rebirthView = (level: number, rebirths: number, curve: ProgressCurve): RebirthView => {
  const need = rebirthLevelAt(rebirths + 1, curve)
  return {
    level,
    need,
    now: rebirthMultiplierAt(rebirths, curve),
    next: rebirthMultiplierAt(rebirths + 1, curve),
    ready: level >= need,
    fraction: Math.min(1, Math.max(0, level / need)),
  }
}

/** Desktop geometry, in overlay pixels at a HUD scale of 1. */
const BASE = {
  boxWidth: 320,
  header: 58,
  padding: 16,
  close: 34,
  bar: 34,
  action: 48,
  boxHeight: 300,
}
const READY = 0x16a34a
const GREYED = 0x475569

export interface RebirthWindowOptions {
  /** What to show, asked every frame while it is out: the Level climbs while you walk. */
  readonly view: () => RebirthView
  /** Rebirth now. Only asked while `view().ready`. */
  readonly rebirth: () => void
  /** It just opened: the other side windows close (one box on the left edge at a time). */
  readonly onOpen?: () => void
}

export interface RebirthWindow {
  close: () => void
  dispose: () => void
}

export const createRebirthWindow = (client: TpsClient, opts: RebirthWindowOptions): RebirthWindow => {
  const root = new Container()
  client.ui.root.addChild(root)

  let open = false
  /** 0 shut, 1 out: stepped each frame toward `open`. */
  let progress = 0
  /** Locks the mouse again; held while open. */
  let release: (() => void) | null = null
  let shown: RebirthView = opts.view()

  const close = (): void => {
    if (!open) return
    open = false
    const r = release
    release = null
    r?.()
  }
  const show = (): void => {
    if (open) return
    const r = client.holdCursor(close)
    if (r === null) return
    release = r
    open = true
    opts.onOpen?.()
  }

  const button = uiButton({ label: 'Rebirth', width: SIDE_BUTTON.size, height: SIDE_BUTTON.size, color: 0xa855f7, onClick: () => (open ? close() : show()) })
  root.addChild(button.view)

  // The box, built once: its words and its bar are set from `shown` whenever that changes.
  const box = new Container()
  root.addChild(box)
  const W = BASE.boxWidth
  const inner = W - 2 * BASE.padding
  // Interactive, so a tap on the box is the box's — not "outside", and not a thumb on the stick behind it.
  const back = new Graphics().roundRect(0, 0, W, BASE.boxHeight, 16).fill({ color: 0x1b1f2a, alpha: 0.98 }).stroke({ width: 2, color: 0x2f3646 })
  back.eventMode = 'static'
  const title = uiLabel('Rebirth', { size: 22, weight: '700' })
  title.position.set(BASE.padding, (BASE.header - title.height) / 2)
  const x = uiButton({ label: '✕', width: BASE.close, height: BASE.close, color: 0x475569, onClick: close })
  x.view.position.set(W - BASE.padding - BASE.close, (BASE.header - BASE.close) / 2)
  const centred = (size: number, y: number, weight: '700' | 'normal', color?: number) => {
    const t = uiLabel('', { size, weight, align: 'center', ...(color === undefined ? {} : { color }) })
    t.anchor.set(0.5)
    t.position.set(W / 2, y)
    return t
  }
  const needText = centred(28, BASE.header + 22, '700', 0xfacc15)
  const multText = centred(20, BASE.header + 66, '700')
  const noteText = centred(14, BASE.header + 102, 'normal', 0x94a3b8)
  noteText.text = 'Rebirth resets your Level'
  const barY = BASE.header + 124
  const barBack = new Graphics().roundRect(BASE.padding, barY, inner, BASE.bar, 10).fill({ color: 0x2a2f3d, alpha: 0.92 })
  const barFill = new Graphics()
  const barText = centred(16, barY + BASE.bar / 2, '700')
  const action = uiButton({
    label: 'Rebirth',
    width: inner,
    height: BASE.action,
    color: GREYED,
    onClick: () => {
      if (!opts.view().ready) return
      opts.rebirth()
      close()
    },
  })
  action.view.position.set(BASE.padding, barY + BASE.bar + 18)
  box.addChild(back, title, x.view, needText, multText, noteText, barBack, barFill, barText, action.view)

  const paint = (v: RebirthView): void => {
    shown = v
    needText.text = `Level ${v.need}`
    multText.text = `${multiplierText(v.now)} XP  →  ${multiplierText(v.next)} XP`
    barText.text = `Level ${v.level} / ${v.need}`
    barFill.clear()
    const w = v.fraction * inner
    // A zero-width rounded rect draws a dot; skip it, as the HUD's bar does.
    if (w > 10) barFill.roundRect(BASE.padding, barY, w, BASE.bar, 10).fill({ color: 0xc9a267, alpha: 0.95 })
    action.setColor(v.ready ? READY : GREYED)
    action.setLabel(v.ready ? 'Rebirth' : `Need Level ${v.need}`)
    action.view.cursor = v.ready ? 'pointer' : 'default'
  }
  paint(shown)

  const same = (a: RebirthView, b: RebirthView): boolean => a.level === b.level && a.need === b.need && a.now === b.now && a.next === b.next

  const stopFrame = client.onFrame((dt) => {
    const { width, height } = client.ui
    const k = hudScale(width, height)
    button.view.scale.set(k)
    button.view.position.set(SIDE_BUTTON.margin * k, sideButtonY(1, height, k))

    progress = stepSlide(progress, open, dt)
    box.visible = progress > 0
    if (!box.visible) return
    const v = opts.view()
    if (!same(v, shown)) paint(v)
    box.scale.set(k)
    const outX = SIDE_BUTTON.margin * k
    const hiddenX = -W * k - 4
    box.position.set(hiddenX + (outX - hiddenX) * slideOut(progress), (height - BASE.boxHeight * k) / 2)
  })

  return {
    close,
    dispose: () => {
      close()
      stopFrame()
      client.ui.root.removeChild(root)
      root.destroy({ children: true })
    },
  }
}
