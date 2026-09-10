import { Container, Graphics, uiLabel } from '@mp/render-pixi'
import type { TpsClient } from '@mp/tps'

import { abbreviate, type ProgressCurve } from './progression'

/**
 * The Experience counter, the Level bar (ADR 0071) and the Wins counter (ADR 0073).
 *
 * Laid out from Kodjo's own screenshot of the game being cloned: **the counter big and centred, with the Level
 * bar directly under it**, both across the bottom. Wins is a plain line on the left edge, vertically centred,
 * placed but not yet styled.
 * The speed picker is deliberately not here yet.
 *
 * The game being cloned calls this currency "Speed". Here it is **Experience**, so that the word "speed" means
 * the one thing that is a velocity (ADR 0071) — and **"XP" on screen**, because a counter is read at a glance
 * and the long word crowds out the number that is the whole point.
 *
 * On the client's existing Pixi overlay (ADR 0015) rather than a second one — the pause screen and the touch
 * controls are already there, and a second Pixi application would mean a second canvas, a second stacking
 * order and a second resize to keep in step.
 *
 * **Redrawn only when the numbers change.** Pixi text is a texture upload per change, and Experience only
 * moves when a key is struck; a HUD that rebuilt its labels every frame would cost more than the keycaps do.
 */

export interface Hud {
  /**
   * Show these numbers, and re-place if the window changed. Cheap to call every frame; it does nothing unless
   * something actually moved.
   *
   * Re-placing is folded in here rather than hooked to a resize, because `UiOverlay` has no resize event —
   * only a `resize()` the shell calls. Comparing two numbers a frame is cheaper than adding one.
   */
  set: (experience: number, level: number, into: number, next: number) => void
  /** The Wins counter, left edge, vertically centred. Same redraw-on-change rule. */
  setWins: (wins: number) => void
  dispose: () => void
}

/** Bar geometry, in overlay pixels. */
const BAR_WIDTH = 520
const BAR_HEIGHT = 46
const BAR_RADIUS = 10
const BOTTOM_MARGIN = 22
/** The Wins counter hugs the left edge, centred vertically — Kodjo's placement. Plain for now: a place, not a look. */
const WINS_MARGIN = 18

export const createHud = (client: TpsClient, _curve: ProgressCurve): Hud => {
  const root = new Container()
  client.ui.root.addChild(root)

  const xpText = uiLabel('0 XP', { size: 40, weight: '700', align: 'center' })
  xpText.anchor.set(0.5, 1)

  const barBack = new Graphics()
  const barFill = new Graphics()
  const levelText = uiLabel('Level 0', { size: 22, weight: '700' })
  levelText.anchor.set(0, 0.5)
  const progressText = uiLabel('0 / 0', { size: 20, weight: '600', align: 'right' })
  progressText.anchor.set(1, 0.5)

  const winsText = uiLabel('0 Wins', { size: 26, weight: '700' })
  winsText.anchor.set(0, 0.5)

  // Fill before the labels, so the text stays legible over it.
  root.addChild(barBack, barFill, levelText, progressText, xpText, winsText)

  /** Last drawn, so an unchanged frame does no work at all. */
  let shown = { experience: -1, level: -1, into: -1, next: -1 }
  let shownWins = -1
  /** Last laid out at, so a window resize is noticed without a resize event to listen to. */
  let placedAt = { width: -1, height: -1 }

  const drawBar = (fraction: number): void => {
    barBack.clear().roundRect(0, 0, BAR_WIDTH, BAR_HEIGHT, BAR_RADIUS).fill({ color: 0x2a2f3d, alpha: 0.92 })
    const w = Math.max(0, Math.min(1, fraction)) * BAR_WIDTH
    barFill.clear()
    // A zero-width rounded rect draws a dot; skip it rather than show a pip at level-up.
    if (w > BAR_RADIUS) barFill.roundRect(0, 0, w, BAR_HEIGHT, BAR_RADIUS).fill({ color: 0xc9a267, alpha: 0.95 })
  }

  const place = (): void => {
    const x = (client.ui.width - BAR_WIDTH) / 2
    const y = client.ui.height - BOTTOM_MARGIN - BAR_HEIGHT
    barBack.position.set(x, y)
    barFill.position.set(x, y)
    levelText.position.set(x + 18, y + BAR_HEIGHT / 2)
    progressText.position.set(x + BAR_WIDTH - 18, y + BAR_HEIGHT / 2)
    xpText.position.set(client.ui.width / 2, y - 10)
    winsText.position.set(WINS_MARGIN, client.ui.height / 2)
  }

  drawBar(0)
  place()

  return {
    set: (experience, level, into, next) => {
      if (client.ui.width !== placedAt.width || client.ui.height !== placedAt.height) {
        place()
        placedAt = { width: client.ui.width, height: client.ui.height }
      }
      if (experience === shown.experience && level === shown.level && into === shown.into && next === shown.next) return
      if (experience !== shown.experience) xpText.text = `${abbreviate(experience)} XP`
      if (level !== shown.level) levelText.text = `Level ${level}`
      if (into !== shown.into || next !== shown.next) {
        progressText.text = `${abbreviate(into)} / ${abbreviate(next)}`
        drawBar(next > 0 ? into / next : 0)
      }
      shown = { experience, level, into, next }
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
