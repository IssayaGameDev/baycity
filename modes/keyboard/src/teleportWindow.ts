import { easeAt } from '@mp/content'
import type { Vec3 } from '@mp/core'
import { Container, Graphics, uiButton, uiLabel, uiList, type ListItem, type UiList } from '@mp/render-pixi'
import type { TpsClient } from '@mp/tps'

import type { CheckpointStop } from './components/obstacle'
import { hudScale } from './hud'
import type { KeyboardTeleport } from './rules'

/**
 * The teleport window (ADR 0203), Kodjo's calls throughout: a square **Teleport** button on the left edge, where the
 * Wins counter was, opens a box that slides in from the left — Start, then every checkpoint in Hierarchy order, a
 * list that scrolls. A pick teleports and closes it. ✕, T, Esc or a tap outside close it too — Esc and the tap
 * through the hold's `onOutside`, since the shell owns Esc (ADR 0205).
 *
 * Open, the mouse is free (`holdCursor`) and you can still walk: only the camera stops turning. T opens it on a
 * keyboard; on touch the button is tapped. A checkpoint not yet reached is listed greyed and cannot be picked
 * (ADR 0211, Kodjo's call), and opens in place when it is reached with the window up (`refresh`). Paying for one
 * comes later.
 */

/** One row: what it says, where it sends you, and whether it is shut. */
export interface TeleportRow {
  readonly label: string
  /** Where it sends you, and the checkpoint that is — the obstacle you are then on (ADR 0212); `null` for Start. */
  readonly to: KeyboardTeleport
  /** Not reached yet: greyed, and a tap does nothing. */
  readonly locked: boolean
}

/** Start — the spawn, facing as you were — then every checkpoint, facing its way, shut until `reached` says so. */
export const teleportRows = (start: Vec3, stops: readonly CheckpointStop[], reached: (key: string) => boolean): TeleportRow[] => [
  { label: 'Start', to: { position: start, obstacle: null }, locked: false },
  ...stops.map((s) => ({ label: `Checkpoint ${s.number}`, to: { position: s.position, yaw: s.yaw, obstacle: s.node }, locked: !reached(s.key) })),
]

/** The slide, in seconds: snappy, Kodjo's call. */
export const SLIDE_SECONDS = 0.25

/** The slide's progress after `dt` more seconds toward open (1) or shut (0): linear, so a reversal is continuous. */
export const stepSlide = (progress: number, open: boolean, dt: number): number =>
  Math.min(1, Math.max(0, progress + ((open ? 1 : -1) * dt) / SLIDE_SECONDS))

/**
 * How far out the box is for a progress: eased out, so it arrives and settles — and, run backwards, leaves slowly
 * and goes, the opening played in reverse.
 */
export const slideOut = (progress: number): number => easeAt('out-cubic', progress)

/** Desktop geometry, in overlay pixels at a HUD scale of 1. */
const BASE = {
  button: 84,
  sideMargin: 18,
  boxWidth: 300,
  header: 58,
  padding: 12,
  row: 44,
  rowText: 17,
  close: 34,
  /** Kept clear above and below the box when the list is long. */
  edge: 40,
}

export interface TeleportWindowOptions {
  /** The rows, asked as the window opens: the level being played's. */
  readonly rows: () => readonly TeleportRow[]
  /** Go there. */
  readonly go: (to: KeyboardTeleport) => void
}

export interface TeleportWindow {
  /** Read the rows again, if it is open — a checkpoint reached while it is up opens there and then, the list's scroll kept. */
  refresh: () => void
  dispose: () => void
}

export const createTeleportWindow = (client: TpsClient, opts: TeleportWindowOptions): TeleportWindow => {
  const root = new Container()
  client.ui.root.addChild(root)

  let open = false
  /** 0 shut, 1 out: stepped each frame toward `open`. */
  let progress = 0
  /** Locks the mouse again; held while open. */
  let release: (() => void) | null = null
  let rows: readonly TeleportRow[] = []

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
    rows = opts.rows()
    built = null
  }

  const button = uiButton({ label: 'Teleport', width: BASE.button, height: BASE.button, color: 0x3b82f6, onClick: () => toggle() })
  // Its own layer under the box, so the box slides over it.
  root.addChild(button.view)

  /** The box: drawn and filled for a size and a set of rows, rebuilt when either changes. */
  const box = new Container()
  root.addChild(box)
  /** What the box was built for. */
  let built: { height: number; count: number } | null = null
  let boxH = 0
  /** The list the box holds, while it is built. */
  let list: UiList | null = null
  const itemsOf = (): ListItem[] =>
    rows.map((row) =>
      row.locked
        ? { text: row.label, muted: true }
        : {
            text: row.label,
            onPick: () => {
              opts.go(row.to)
              close()
            },
          },
    )

  const build = (overlayH: number, k: number): void => {
    const fits = BASE.header + rows.length * BASE.row + BASE.padding
    boxH = Math.max(BASE.header + BASE.row + BASE.padding, Math.min(fits, overlayH / k - 2 * BASE.edge))
    if (built !== null && built.height === boxH && built.count === rows.length) return
    built = { height: boxH, count: rows.length }
    box.removeChildren().forEach((c) => c.destroy({ children: true }))
    // Interactive, so a tap on the box is the box's — not "outside", and not a thumb on the stick behind it.
    const back = new Graphics().roundRect(0, 0, BASE.boxWidth, boxH, 16).fill({ color: 0x1b1f2a, alpha: 0.98 }).stroke({ width: 2, color: 0x2f3646 })
    back.eventMode = 'static'
    const title = uiLabel('Teleport', { size: 22, weight: '700' })
    title.position.set(BASE.padding + 4, (BASE.header - title.height) / 2)
    const x = uiButton({ label: '✕', width: BASE.close, height: BASE.close, color: 0x475569, onClick: close })
    x.view.position.set(BASE.boxWidth - BASE.padding - BASE.close, (BASE.header - BASE.close) / 2)
    const made = uiList({ width: BASE.boxWidth - 2 * BASE.padding, height: boxH - BASE.header - BASE.padding, rowHeight: BASE.row, textSize: BASE.rowText })
    made.view.position.set(BASE.padding, BASE.header)
    made.setItems(itemsOf())
    list = made
    box.addChild(back, title, x.view, made.view)
  }

  const toggle = (): void => {
    if (open) close()
    else show()
  }
  /** Typing into a field — the debug pane's — is not a key for the game. */
  const typing = (e: KeyboardEvent): boolean =>
    e.target instanceof HTMLElement && (e.target.isContentEditable || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat || typing(e)) return
    if (e.code === 'KeyT') toggle()
  }
  window.addEventListener('keydown', onKey)

  const stopFrame = client.onFrame((dt) => {
    const { width, height } = client.ui
    const k = hudScale(width, height)
    button.view.scale.set(k)
    button.view.position.set(BASE.sideMargin * k, height / 2 - (BASE.button * k) / 2)

    progress = stepSlide(progress, open, dt)
    box.visible = progress > 0
    if (!box.visible) return
    build(height, k)
    box.scale.set(k)
    const outX = BASE.sideMargin * k
    const hiddenX = -BASE.boxWidth * k - 4
    box.position.set(hiddenX + (outX - hiddenX) * slideOut(progress), (height - boxH * k) / 2)
  })

  return {
    refresh: () => {
      if (!open) return
      rows = opts.rows()
      // Same rows, new states: in place, so the list stays where it was scrolled. Another count is a new box.
      if (built !== null && built.count === rows.length && list !== null) list.setItems(itemsOf())
      else built = null
    },
    dispose: () => {
      close()
      stopFrame()
      window.removeEventListener('keydown', onKey)
      client.ui.root.removeChild(root)
      root.destroy({ children: true })
    },
  }
}
