import type { OrbitControls } from '@mp/render-three'

import type { Doc } from './editorDoc'

/**
 * Play-testing a level from the editor (ADR 0086, ADR 0172): the **real game**, in a frame over the viewport — HUD,
 * progression, other players, the level as it is now.
 *
 * The only way. There used to be a second, **play in place**: the editor's own scene running a hand-built copy of
 * each game (its rules, locomotion, player components and camera), for a game the server hosted no page for. It
 * drifted from the games until it no longer worked, and every game the stack has is hosted, so it is gone. A level
 * whose game has no page here does not play, and says why.
 *
 * `PlayHost` is the whole contract, in the getter-bag style every panel uses, so a session cannot see a stale copy
 * of the document.
 */

/** What play needs from the editor around it. Getters, so nothing here can hold a stale copy. */
export interface PlayHost {
  /** The editor's orbit controls, switched off while the frame is up so a stray drag does not move the camera. */
  controls: OrbitControls
  /**
   * The editor's own frame loop, paused while the frame is up and resumed when it goes. Hidden under the game, the
   * viewport still drew the whole level every frame — shadows, ambient occlusion, bloom, outlines — so two full scenes
   * shared one graphics card: a collaborator's game ran at 60–80 a second in the editor against 144 on its own page.
   * Edits arriving meanwhile are drawn on the first frame back.
   */
  view: { pause: () => void; resume: () => void }
  doc: () => Doc | null
  /** Where the open level's game plays, or `null`: not a level, no game, or the server knows no page for it. */
  gamePageUrl: () => string | null
  /** Why there is no page, for the message: `null` when there is one. */
  noPageReason: () => string | null
  /** The open file's qualified name, for the status line. */
  fileName: () => string
  /** Its bare name, for the game page's `?level=` (ADR 0108). */
  levelName: () => string
  live: () => boolean
  /** Push pending live edits, so the game page reads a current file. */
  flush: () => Promise<void>
  /**
   * The hint over the viewport while a session runs (ADR 0155), or `null` when it ends — stopping takes it away
   * rather than leaving a line about a session that is over.
   */
  hint: (text: string | null) => void
  /** A refusal, said once. */
  refuse: (message: string) => void
  uiChanged: () => void
}

export interface Play {
  /** The frame is up. Editing is suspended while it is. */
  active: () => boolean
  start: () => void
  stop: () => void
}

export const createPlay = (host: PlayHost): Play => {
  /** The frame showing the game while a level is being play-tested, or `null`. */
  let gameFrame: HTMLIFrameElement | null = null
  /** A start is flushing or saving: a second press must not open a second frame. */
  let starting = false

  /**
   * The game reads the level from the server, so live edits are pushed first. Stop is the toolbar button: Esc
   * inside the frame is the game's pause, not ours.
   */
  const start = (): void => {
    if (host.doc() === null || gameFrame !== null || starting) return
    const url = host.gamePageUrl()
    if (url === null) {
      host.refuse(host.noPageReason() ?? 'this level has nowhere to play')
      return
    }
    starting = true
    void (async () => {
      try {
        if (host.live()) await host.flush()
      } finally {
        starting = false
      }
      const frame = document.createElement('iframe')
      frame.id = 'game-frame'
      // Bare: the game page resolves it inside its own folder (ADR 0108), so the game must not be in the param.
      frame.src = `${url}?level=${encodeURIComponent(host.levelName())}`
      frame.allow = 'fullscreen; pointer-lock'
      document.getElementById('centre')?.append(frame)
      gameFrame = frame
      host.controls.enabled = false
      host.view.pause()
      host.hint(`Playing ${host.fileName()} in the game · Stop to come back`)
      host.uiChanged()
    })()
  }

  const stop = (): void => {
    if (gameFrame === null) return
    gameFrame.remove()
    gameFrame = null
    host.controls.enabled = true
    host.view.resume()
    host.hint(null)
    host.uiChanged()
  }

  return { active: () => gameFrame !== null, start, stop }
}
