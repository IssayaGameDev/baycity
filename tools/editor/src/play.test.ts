// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import type { Doc } from './editorDoc'
import { createPlay, type PlayHost } from './play'

/**
 * Play-testing pauses the editor's own drawing: hidden under the game, the viewport drew the whole level
 * every frame, and a collaborator's game ran at 60–80 a second in the editor against 144 on its own page.
 */
describe('play-testing', () => {
  const rig = () => {
    document.body.replaceChildren()
    // The frame's page is the server's to serve; here it is only an element.
    ;(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true
    const centre = document.createElement('div')
    centre.id = 'centre'
    document.body.append(centre)
    const calls: string[] = []
    const host: PlayHost = {
      controls: { enabled: true } as PlayHost['controls'],
      view: { pause: () => void calls.push('pause'), resume: () => void calls.push('resume') },
      doc: () => ({}) as Doc,
      gamePageUrl: () => '/play/keyboard/',
      noPageReason: () => null,
      fileName: () => 'keyboard/a',
      levelName: () => 'a',
      live: () => false,
      flush: async () => {},
      hint: () => {},
      refuse: () => {},
      uiChanged: () => {},
    }
    return { play: createPlay(host), calls, host }
  }

  it('pauses the editor’s frame loop while the game is up, and resumes it on stop', async () => {
    const { play, calls, host } = rig()
    play.start()
    await new Promise((r) => setTimeout(r, 0))
    expect(play.active()).toBe(true)
    expect(calls).toEqual(['pause'])
    expect(host.controls.enabled).toBe(false)
    play.stop()
    expect(calls).toEqual(['pause', 'resume'])
    expect(host.controls.enabled).toBe(true)
    play.stop()
    expect(calls, 'a second stop does nothing').toEqual(['pause', 'resume'])
  })
})
