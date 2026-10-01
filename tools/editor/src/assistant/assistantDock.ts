import { icon } from '../icons'
import { closeChat, CONTEXT_CHANNEL, type ContextMessage, type EditorContext } from './assistantApi'
import { createChatWindow, type ChatWindow } from './chatWindow'

/**
 * The assistant in the editor (ADR 0192): a round button at the viewport's bottom right that opens the chat above it,
 * Kodjo's call. The chat can move to a tab of its own, conversation and all; that tab asks this one what the editor
 * is looking at before each message, over a channel, addressed to this tab alone.
 *
 * A conversation lasts as long as its tab (Kodjo's call): this one's ends when the editor's tab goes — unless it moved,
 * and then it is the other tab's to end.
 */

export interface AssistantDockHost {
  /** What the person is looking at now. */
  readonly context: () => EditorContext
  /** Play owns the viewport: the button steps aside. */
  readonly playing: () => boolean
}

export interface AssistantDock {
  /** The button shown or not, as play allows. */
  readonly render: () => void
}

/** This tab, as the chat tabs it opened address it. */
const TAB = Math.random().toString(36).slice(2, 10)

export const createAssistantDock = (stage: HTMLElement, host: AssistantDockHost): AssistantDock => {
  const panel = document.createElement('div')
  panel.className = 'asst-panel'
  panel.hidden = true
  const fab = document.createElement('button')
  fab.type = 'button'
  fab.className = 'asst-fab'
  fab.title = 'Ask the assistant'
  fab.append(icon('assistant'))
  stage.append(panel, fab)

  let chat: ChatWindow | null = null
  const hide = (): void => {
    panel.hidden = true
  }
  const show = (): void => {
    chat ??= createChatWindow({
      root: panel,
      context: async () => host.context(),
      onClose: hide,
      onPopOut: (id) => {
        window.open(`/assistant.html#chat=${id}&from=${TAB}`, '_blank')
        // The conversation is the new tab's now; this panel starts afresh next time.
        chat = null
        panel.replaceChildren()
        hide()
      },
    })
    panel.hidden = false
    chat.focus()
  }
  fab.addEventListener('click', () => (panel.hidden ? show() : hide()))

  // A chat tab this one opened asks what the editor is looking at.
  const channel = new BroadcastChannel(CONTEXT_CHANNEL)
  channel.addEventListener('message', (e: MessageEvent<ContextMessage & { tab?: string }>) => {
    if (e.data.kind === 'ask' && e.data.tab === TAB) channel.postMessage({ kind: 'context', tab: TAB, context: host.context() })
  })

  window.addEventListener('pagehide', () => {
    const id = chat?.chatId() ?? null
    if (id !== null) closeChat(id)
  })

  return {
    render: () => {
      const playing = host.playing()
      fab.hidden = playing
      if (playing) hide()
    },
  }
}
