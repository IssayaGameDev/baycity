/**
 * The editor's side of the assistant's routes (ADR 0192): `/api/assistant` on the editor's own server, the login the
 * page already has. A turn comes back as server-sent events over the POST's own response, read as it arrives.
 */

/** What the person is looking at, sent with each message. */
export interface EditorContext {
  game?: string
  level?: string
  prefab?: string
  selection?: string[]
  problems?: string[]
}

export type Draft =
  | { readonly id: string; readonly kind: 'issue'; readonly title: string; readonly body: string; readonly labels: readonly string[] }
  | { readonly id: string; readonly kind: 'comment'; readonly number: number; readonly body: string }

export type Shown =
  | { readonly kind: 'you'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'activity'; readonly text: string }
  | { readonly kind: 'draft'; readonly draft: Draft }

export type AssistantEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'activity'; readonly text: string }
  | { readonly kind: 'draft'; readonly draft: Draft }
  | { readonly kind: 'spent'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string }

export interface Status {
  readonly ready: boolean
  readonly why?: string
  readonly github: boolean
  readonly spent: number
  readonly limit: number
}

const json = async <T>(r: Response): Promise<T> => {
  const body = (await r.json().catch(() => ({}))) as { error?: unknown }
  if (!r.ok) throw new Error(typeof body.error === 'string' ? body.error : `the server answered ${r.status}`)
  return body as T
}

export const assistantStatus = async (): Promise<Status> => {
  const r = await fetch('/api/assistant')
  // The dev editor has no assistant: anything but an answer is "not here".
  if (!r.ok) return { ready: false, why: 'The assistant is not set up on this server.', github: false, spent: 0, limit: 0 }
  return json<Status>(r)
}

export const newChat = async (): Promise<string> => (await json<{ id: string }>(await fetch('/api/assistant/chats', { method: 'POST' }))).id

export const chatSoFar = async (id: string): Promise<{ shown: Shown[]; filed: Record<string, string>; busy: boolean }> => json(await fetch(`/api/assistant/chats/${id}`))

export const fileDraft = async (id: string, draft: string): Promise<string> => (await json<{ url: string }>(await fetch(`/api/assistant/chats/${id}/file/${draft}`, { method: 'POST' }))).url

/** Tell the server this tab is done with the conversation — as the page goes, so a beacon. */
export const closeChat = (id: string): void => {
  navigator.sendBeacon(`/api/assistant/chats/${id}/close`)
}

/** Parse server-sent events out of a stream of text, each whole event handed to `on` as it completes. */
export const sseParser = (on: (event: string, data: string) => void): ((chunk: string) => void) => {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data.push(line.slice(6))
      }
      if (data.length > 0) on(event, data.join('\n'))
    }
  }
}

/** Say something; each event of the turn reaches `on` as it streams. Resolves when the turn ends. */
export const say = async (id: string, text: string, context: EditorContext, on: (e: AssistantEvent) => void): Promise<void> => {
  const r = await fetch(`/api/assistant/chats/${id}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, context }) })
  if (!r.ok || r.body === null) {
    const why = (await r.json().catch(() => ({}))) as { error?: unknown }
    on({ kind: 'error', message: typeof why.error === 'string' ? why.error : `the server answered ${r.status}` })
    return
  }
  const feed = sseParser((_event, data) => {
    try {
      on(JSON.parse(data) as AssistantEvent)
    } catch {
      // A torn event is dropped rather than ending the turn.
    }
  })
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    feed(decoder.decode(value, { stream: true }))
  }
}

/**
 * The editor tab and a tab the chat moved to talk over this channel (ADR 0192): the chat asks what the editor is
 * looking at before each message, and the editor answers.
 */
export const CONTEXT_CHANNEL = 'mp-assistant-context'
export type ContextMessage = { readonly kind: 'ask' } | { readonly kind: 'context'; readonly context: EditorContext }
