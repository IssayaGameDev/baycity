import { closeChat, CONTEXT_CHANNEL, type ContextMessage, type EditorContext } from './assistantApi'
import { createChatWindow } from './chatWindow'

/**
 * The assistant in a tab of its own (ADR 0192): the conversation the editor's panel handed over, by id in the
 * address. What the editor is looking at is asked of the editor tab that opened this one, before each message; if it
 * has gone, the message goes without.
 */

const params = new URLSearchParams(location.hash.slice(1))
const chatId = params.get('chat') ?? undefined
const from = params.get('from') ?? ''

const channel = new BroadcastChannel(CONTEXT_CHANNEL)
let latest: EditorContext = {}
channel.addEventListener('message', (e: MessageEvent<ContextMessage & { tab?: string }>) => {
  if (e.data.kind === 'context' && e.data.tab === from) latest = e.data.context
})

/** Ask the editor tab, and wait a moment for it to answer. */
const context = (): Promise<EditorContext> =>
  new Promise((resolve) => {
    if (from === '') {
      resolve({})
      return
    }
    const answer = (e: MessageEvent<ContextMessage & { tab?: string }>): void => {
      if (e.data.kind !== 'context' || e.data.tab !== from) return
      channel.removeEventListener('message', answer)
      clearTimeout(timer)
      resolve(e.data.context)
    }
    const timer = setTimeout(() => {
      channel.removeEventListener('message', answer)
      resolve(latest)
    }, 250)
    channel.addEventListener('message', answer)
    channel.postMessage({ kind: 'ask', tab: from })
  })

const root = document.createElement('div')
root.className = 'asst-page'
document.body.append(root)
document.title = 'Assistant — editor'
const chat = createChatWindow({ root, ...(chatId === undefined ? {} : { chatId }), context })
chat.focus()

window.addEventListener('pagehide', () => {
  const id = chat.chatId()
  if (id !== null) closeChat(id)
})
