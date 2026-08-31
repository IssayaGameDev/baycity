import { t } from '@mp/i18n'
import { createTouchHud, createUiOverlay, uiButton, type ListItem, type TouchHud, type UiOverlay } from '@mp/render-pixi'

import { createPauseMenu } from './pauseMenu'

/**
 * The page around the game: the 2D overlay, the pause screen, the touch HUD, and the pointer-lock handoff
 * (ADR 0015, ADR 0065).
 *
 * Plumbing rather than platform. Nothing in here is required for two clients to agree on anything — it is
 * simply what any game rendered into a canvas wants, and having it inline was what made
 * `startGameClient` the only way to get it.
 *
 * **Pointer lock is the pause state**, on a mouse. Releasing it (Esc, focus loss) opens the menu and
 * re-locking closes it, which is why the menu has no Esc handler of its own. Touch has no lock at all, so
 * there the pause button is the only way in *and* out — hence the `touch.active()` guard on every path,
 * without which the first tap would open the menu and never let it close (ADR 0022).
 */
export interface Shell {
  /** The overlay's container, for anything else that draws in 2D. */
  readonly ui: UiOverlay
  /** The on-screen touch controls. Drawn by the render loop, which drains the stick and button each frame. */
  readonly touchHud: TouchHud
  /** Whether the menu is up. The render loop stops routing touches and the camera stops swinging while it is. */
  isOpen: () => boolean
  dispose: () => void
}

export interface ShellOptions {
  /** The Three canvas this stacks over, and the element pointer lock is taken on. */
  canvas: HTMLCanvasElement
  /** Whether the player is on touch, which changes every pointer-lock decision. */
  isTouch: () => boolean
  /** Mouse look sensitivity as a 0..1 slider position, mapped by the shell to the camera's own range. */
  sensitivity: { get: () => number; set: (t: number) => void }
  /** Our own display name, and every peer's — the pause screen's player list. */
  roster: () => { me: string; peers: readonly string[] }
  /** Restart: put the player back at their last checkpoint. */
  onRestart: () => void
}

/** The slider's ends, in the camera's own units. */
const SENS_MIN = 0.0005
const SENS_MAX = 0.006

export const createShell = async ({
  canvas,
  isTouch,
  sensitivity,
  roster,
  onRestart,
}: ShellOptions): Promise<Shell> => {
  /**
   * Sized from the **canvas**, not from `window.innerWidth/innerHeight`. The canvas is `dvh`-sized, so on
   * mobile it is shorter than the layout viewport; taking the overlay's size from the window instead would put
   * the drawn controls a browser-bar's height away from the touch zones, which come from the canvas rect. One
   * source for both means they cannot drift.
   */
  const viewSize = (): { width: number; height: number } => ({
    width: canvas.clientWidth || window.innerWidth,
    height: canvas.clientHeight || window.innerHeight,
  })

  const ui = await createUiOverlay(viewSize())
  ui.canvas.style.position = 'fixed'
  ui.canvas.style.inset = '0'
  ui.canvas.style.zIndex = '10'
  document.body.appendChild(ui.canvas)

  const resumePlay = (): void => {
    pause.close()
    // Touch has no lock to take, and requesting one on mobile either throws or does nothing.
    if (!isTouch()) void canvas.requestPointerLock()
  }

  const pause = createPauseMenu(ui, {
    onResume: () => resumePlay(),
    onRestart: () => {
      onRestart()
      resumePlay()
    },
    sensitivity: {
      get: () => (sensitivity.get() - SENS_MIN) / (SENS_MAX - SENS_MIN),
      set: (position) => {
        sensitivity.set(SENS_MIN + position * (SENS_MAX - SENS_MIN))
      },
    },
    players: () => {
      const { me, peers } = roster()
      const items: ListItem[] = [{ text: t('pause.self', { name: me }), highlight: true }]
      for (const name of peers) items.push({ text: name })
      return items
    },
  })

  const onPointerLockChange = (): void => {
    if (isTouch()) return
    if (document.pointerLockElement === canvas) pause.close()
    else pause.open()
  }
  document.addEventListener('pointerlockchange', onPointerLockChange)

  ui.setBackgroundTap(() => {
    if (!isTouch() && !pause.isOpen()) void canvas.requestPointerLock()
  })

  // Before the pause button, because Pixi draws later children on top and the button has to stay reachable
  // over the HUD's graphics.
  const touchHud = createTouchHud(ui.root)

  // Top-left pause button (placeholder glyph until skinned). During locked play the cursor is hidden, so this
  // is clickable when free; Esc is the primary open while playing.
  const pauseBtn = uiButton({
    label: 'II',
    width: 44,
    height: 40,
    color: 0x475569,
    onClick: () => {
      if (isTouch()) pause.open()
      else if (document.pointerLockElement === canvas) document.exitPointerLock()
      else pause.open()
    },
  })
  pauseBtn.view.position.set(16, 16)
  ui.root.addChild(pauseBtn.view)

  const onResize = (): void => {
    const v = viewSize()
    ui.resize(v.width, v.height)
    pauseBtn.view.position.set(16, 16)
    pause.layout()
  }
  window.addEventListener('resize', onResize)

  return {
    ui,
    touchHud,
    isOpen: () => pause.isOpen(),
    dispose: () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      window.removeEventListener('resize', onResize)
      touchHud.dispose()
      ui.dispose()
    },
  }
}
