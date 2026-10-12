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
 * **On a mouse, Esc steps back one state at a time** (ADR 0205, Kodjo's call): playing (the mouse locked to the
 * camera) → the mouse showing, so a HUD button can be clicked → the pause screen → back to the mouse showing. A game
 * window open closes first. A click on empty space plays again; a click on a button is the button's. Losing the
 * lock any other way (focus loss) is the mouse showing too, never the pause screen. Touch has no lock at all, so
 * there the pause button opens the menu and Esc only toggles it — hence the `touch.active()` guard on every lock
 * path, without which the first tap would ask for a lock mobile cannot give (ADR 0022).
 */
export interface Shell {
  /** The overlay's container, for anything else that draws in 2D. */
  readonly ui: UiOverlay
  /** The on-screen touch controls. Drawn by the render loop, which drains the stick and button each frame. */
  readonly touchHud: TouchHud
  /** Whether the menu is up. The render loop stops routing touches and the camera stops swinging while it is. */
  isOpen: () => boolean
  /**
   * A game's own window wants the mouse (ADR 0203): the lock is let go **without** pausing, and a tap on empty
   * space calls `onOutside` rather than locking again. The release returned locks again — call it from the click
   * or key that closes the window, since a lock is granted only inside one. Opening the pause menu ends the hold
   * with `onOutside`, and its release then does nothing. Touch has no lock: only the outside tap applies.
   * `null` while the pause screen is up: no window opens over it.
   */
  holdCursor: (onOutside: () => void) => (() => void) | null
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

/** What Esc does now (ADR 0205). */
export type EscapeAction = 'ignore' | 'close-window' | 'close-pause' | 'open-pause'

/**
 * How long after the lock is let go an Esc still counts as the one that let it go, in ms. Locked, the browser takes
 * Esc to show the mouse, and whether the page hears that key too, and before or after the lock goes, varies.
 */
export const ESC_UNLOCK_MS = 250

/**
 * Esc, one state back: the Esc that let the lock go only shows the mouse; then a game window closes; then the
 * pause screen goes back to the mouse; the mouse brings up the pause screen.
 */
export const escapeAction = (s: { readonly locked: boolean; readonly msSinceUnlock: number; readonly window: boolean; readonly paused: boolean }): EscapeAction => {
  if (s.locked || s.msSinceUnlock < ESC_UNLOCK_MS) return 'ignore'
  if (s.window) return 'close-window'
  if (s.paused) return 'close-pause'
  return 'open-pause'
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

  /** A game window holding the mouse, and what to call when a tap lands outside it. */
  let held: { readonly onOutside: () => void } | null = null
  /** The pause screen takes over from any game window: it closes, and nothing locks on its way out. */
  const openPause = (): void => {
    const h = held
    held = null
    h?.onOutside()
    pause.open()
  }
  /** Asked from a click or key. A lock can still be refused — Esc grants none — and then the next click takes it. */
  const lockAgain = (): void => {
    if (!isTouch() && !pause.isOpen()) canvas.requestPointerLock().catch(() => undefined)
  }

  /** When the lock last went: the Esc that took it only showed the mouse. */
  let unlockedAt = -Infinity
  const onPointerLockChange = (): void => {
    if (isTouch()) return
    if (document.pointerLockElement === canvas) pause.close()
    // However it went — Esc, focus, a game window — the mouse is showing; Esc again is the pause screen.
    else unlockedAt = performance.now()
  }
  document.addEventListener('pointerlockchange', onPointerLockChange)

  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape' || e.repeat) return
    const action = escapeAction({
      locked: document.pointerLockElement === canvas,
      msSinceUnlock: performance.now() - unlockedAt,
      window: held !== null,
      paused: pause.isOpen(),
    })
    // A window's close releases the hold, whose lock Esc cannot grant: the mouse stays out, as it should.
    if (action === 'close-window') held?.onOutside()
    else if (action === 'close-pause') pause.close()
    else if (action === 'open-pause') openPause()
  }
  window.addEventListener('keydown', onKey)

  // Empty space: play again — or close a game window, which plays again too. Not under the pause screen.
  ui.setBackgroundTap(() => {
    if (held !== null) held.onOutside()
    else lockAgain()
  })

  // Before the pause button, because Pixi draws later children on top and the button has to stay reachable
  // over the HUD's graphics.
  const touchHud = createTouchHud(ui.root)

  // Top-left pause button (placeholder glyph until skinned). Clickable whenever the mouse is showing, and the
  // only way in on touch.
  const pauseBtn = uiButton({ label: 'II', width: 44, height: 40, color: 0x475569, onClick: () => openPause() })
  pauseBtn.view.position.set(16, 16)
  ui.root.addChild(pauseBtn.view)

  const onResize = (): void => {
    const v = viewSize()
    ui.resize(v.width, v.height)
    pauseBtn.view.position.set(16, 16)
    pause.layout()
  }
  // The canvas is watched, not the window: iOS fires `resize` on rotation before layout has settled, and the
  // overlay took the canvas's stale size (see `createThreeStage`). The observer fires after layout.
  const observer = new ResizeObserver(onResize)
  observer.observe(canvas)
  window.addEventListener('resize', onResize)

  return {
    ui,
    touchHud,
    isOpen: () => pause.isOpen(),
    holdCursor: (onOutside) => {
      if (pause.isOpen()) return null
      const h = { onOutside }
      held = h
      if (!isTouch() && document.pointerLockElement === canvas) document.exitPointerLock()
      return () => {
        if (held !== h) return
        held = null
        lockAgain()
      }
    },
    dispose: () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      window.removeEventListener('keydown', onKey)
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      touchHud.dispose()
      ui.dispose()
    },
  }
}
