import { Container, Graphics, uiLabel } from '@mp/render-pixi'
import type { TpsClient } from '@mp/tps'

import { abbreviate, type ProgressCurve } from './progression'

/**
 * The Experience counter, the Level bar (ADR 0071), the Wins counter (ADR 0073) and the speed readout.
 *
 * Laid out from Kodjo's own screenshot of the game being cloned: **the counter big and centred, with the Level
 * bar directly under it**, both across the bottom. Wins is a plain line on the left edge, vertically centred,
 * placed but not yet styled. The speed picker is deliberately not here yet.
 *
 * The game being cloned calls this currency "Speed". Here it is **Experience**, so that the word "speed" means
 * the one thing that is a velocity (ADR 0071) — and **"XP" on screen**, because a counter is read at a glance
 * and the long word crowds out the number that is the whole point.
 *
 * On the client's existing Pixi overlay (ADR 0015) rather than a second one — the pause screen and the touch
 * controls are already there, and a second Pixi application would mean a second canvas, a second stacking
 * order and a second resize to keep in step.
 *
 * **Sized to the screen.** The geometry below is for a desktop window and is scaled down together — bar, type
 * and margins by one factor — as the overlay gets smaller, so a phone in portrait gets a bar that fits its
 * width rather than a 520 px bar on a 390 px screen. One factor rather than per-element rules, so the
 * proportions Kodjo laid out survive at every size.
 *
 * **Redrawn only when the numbers change.** Pixi text is a texture upload per change, and Experience only
 * moves when a key is struck; a HUD that rebuilt its labels every frame would cost more than the keycaps do.
 */

export interface Hud {
  /**
   * Show these numbers, and re-lay-out if the window changed. Cheap to call every frame; it does nothing unless
   * something actually moved.
   *
   * Re-laying-out is folded in here rather than hooked to a resize, because `UiOverlay` has no resize event —
   * only a `resize()` the shell calls. Comparing two numbers a frame is cheaper than adding one.
   */
  set: (experience: number, level: number, into: number, next: number, speedStuds: number) => void
  /** The Wins counter, left edge, vertically centred. Same redraw-on-change rule. */
  setWins: (wins: number) => void
  dispose: () => void
}

/** Desktop geometry, in overlay pixels. Everything scales from these together. */
const BASE = {
  barWidth: 520,
  barHeight: 46,
  barRadius: 10,
  bottomMargin: 22,
  sideMargin: 18,
  xpSize: 40,
  speedSize: 22,
  levelSize: 22,
  progressSize: 20,
  winsSize: 26,
  /** The overlay size the geometry above was laid out for. Smaller overlays scale down from here. */
  width: 960,
  height: 540,
}

/**
 * How much to shrink the desktop layout for this overlay: the tighter of width and height against the size it
 * was laid out for, never above 1 (a large screen gets the desktop layout, not a giant one) and never below
 * 0.55 (below that the type is unreadable and the bar is better clipped to the width than shrunk further).
 */
export const hudScale = (width: number, height: number): number =>
  Math.max(0.55, Math.min(1, width / BASE.width, height / BASE.height))

/** The bar's width at this scale, never wider than the overlay less its margins. */
export const barWidthFor = (width: number, k: number): number => Math.min(BASE.barWidth * k, width - 2 * BASE.sideMargin * k)

export const createHud = (client: TpsClient, _curve: ProgressCurve): Hud => {
  const root = new Container()
  client.ui.root.addChild(root)

  const xpText = uiLabel('0 XP', { size: BASE.xpSize, weight: '700', align: 'center' })
  xpText.anchor.set(0.5, 1)
  /** The speed you are running at, in the game's unit (studs/s), to the right of the counter. */
  const speedText = uiLabel('', { size: BASE.speedSize, weight: '600' })
  speedText.anchor.set(0, 1)

  const barBack = new Graphics()
  const barFill = new Graphics()
  const levelText = uiLabel('Level 0', { size: BASE.levelSize, weight: '700' })
  levelText.anchor.set(0, 0.5)
  const progressText = uiLabel('0 / 0', { size: BASE.progressSize, weight: '600', align: 'right' })
  progressText.anchor.set(1, 0.5)

  const winsText = uiLabel('0 Wins', { size: BASE.winsSize, weight: '700' })
  winsText.anchor.set(0, 0.5)

  // Fill before the labels, so the text stays legible over it.
  root.addChild(barBack, barFill, levelText, progressText, xpText, speedText, winsText)

  /** Last drawn, so an unchanged frame does no work at all. */
  let shown = { experience: -1, level: -1, into: -1, next: -1, speed: -1 }
  let shownWins = -1
  let shownFraction = 0
  /** Last laid out at, so a window resize is noticed without a resize event to listen to. */
  let placedAt = { width: -1, height: -1 }
  /** The current geometry, from the last layout. */
  let k = 1
  let barW = BASE.barWidth
  let barH = BASE.barHeight
  let barX = 0
  let barY = 0

  const drawBar = (fraction: number): void => {
    shownFraction = fraction
    const r = BASE.barRadius * k
    barBack.clear().roundRect(0, 0, barW, barH, r).fill({ color: 0x2a2f3d, alpha: 0.92 })
    const w = Math.max(0, Math.min(1, fraction)) * barW
    barFill.clear()
    // A zero-width rounded rect draws a dot; skip it rather than show a pip at level-up.
    if (w > r) barFill.roundRect(0, 0, w, barH, r).fill({ color: 0xc9a267, alpha: 0.95 })
  }

  /** Right of the counter, which changes width as the number grows. */
  const placeSpeed = (): void => {
    speedText.position.set(xpText.position.x + xpText.width / 2 + 14 * k, xpText.position.y - 6 * k)
  }

  const layout = (): void => {
    const { width, height } = client.ui
    k = hudScale(width, height)
    barW = barWidthFor(width, k)
    barH = BASE.barHeight * k
    xpText.style.fontSize = BASE.xpSize * k
    speedText.style.fontSize = BASE.speedSize * k
    levelText.style.fontSize = BASE.levelSize * k
    progressText.style.fontSize = BASE.progressSize * k
    winsText.style.fontSize = BASE.winsSize * k

    barX = (width - barW) / 2
    barY = height - BASE.bottomMargin * k - barH
    barBack.position.set(barX, barY)
    barFill.position.set(barX, barY)
    levelText.position.set(barX + 18 * k, barY + barH / 2)
    progressText.position.set(barX + barW - 18 * k, barY + barH / 2)
    xpText.position.set(width / 2, barY - 10 * k)
    winsText.position.set(BASE.sideMargin * k, height / 2)
    placeSpeed()
    drawBar(shownFraction)
  }

  layout()

  return {
    set: (experience, level, into, next, speedStuds) => {
      if (client.ui.width !== placedAt.width || client.ui.height !== placedAt.height) {
        layout()
        placedAt = { width: client.ui.width, height: client.ui.height }
      }
      if (experience === shown.experience && level === shown.level && into === shown.into && next === shown.next && speedStuds === shown.speed) return
      if (experience !== shown.experience) {
        xpText.text = `${abbreviate(experience)} XP`
        placeSpeed() // the counter grew or shrank
      }
      if (speedStuds !== shown.speed) speedText.text = `Speed ${Math.round(speedStuds)}`
      if (level !== shown.level) levelText.text = `Level ${level}`
      if (into !== shown.into || next !== shown.next) {
        progressText.text = `${abbreviate(into)} / ${abbreviate(next)}`
        drawBar(next > 0 ? into / next : 0)
      }
      shown = { experience, level, into, next, speed: speedStuds }
    },
    setWins: (wins) => {
      if (wins === shownWins) return
      shownWins = wins
      winsText.text = `${abbreviate(wins)} Wins`
    },
    dispose: () => {
      client.ui.root.removeChild(root)
      // Pixi's own recursive teardown: the labels each own a text texture and the bars own geometry.
      root.destroy({ children: true })
    },
  }
}
