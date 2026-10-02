import type { ActionOutcome } from '../actions'
import type { EditorTool } from './editorLink'

/**
 * The editor's side of the assistant's routes (ADR 0192): `/api/assistant` on the editor's own server, the login the
 * page already has. A turn comes back as server-sent events over the POST's own response, read as it arrives.
 */

/** What the assistant may do in a chat (ADR 0195): read and report, change things on the person's click, or by itself. */
export type AssistantMode = 'assistant' | 'confirm' | 'auto'

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
  /** An editor action for this tab to run (ADR 0195), answered with `answerCall`. */
  | { readonly kind: 'call'; readonly call: { readonly id: string; readonly name: string; readonly input: unknown } }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string }

export interface Status {
  readonly ready: boolean
  readonly why?: string
  readonly github: boolean
  readonly spent: number
  readonly limit: number
  /** The modes open to this person: `assistant` alone, or all three. Absent from a server before ADR 0195. */
  readonly modes?: readonly AssistantMode[]
  /** All sessions on disk past the warning size: told to the people who edit (ADR 0197). */
  readonly storage?: { readonly bytes: number; readonly warnAt: number }
  /** The models this person may pick, the default first (ADR 0199); absent for everyone else. */
  readonly models?: readonly ModelChoice[]
}

/** A model to pick, with what it costs: USD a million tokens in and out. */
export interface ModelChoice {
  readonly id: string
  readonly label: string
  readonly prices: { readonly input: number; readonly output: number }
}

/** A saved session as the list shows it (ADR 0197). */
export interface ChatSummary {
  readonly id: string
  readonly title: string
  readonly mode: AssistantMode
  readonly lastUsed: number
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

export const chatSoFar = async (id: string): Promise<{ shown: Shown[]; filed: Record<string, string>; busy: boolean; title?: string; mode?: AssistantMode; model?: string }> =>
  json(await fetch(`/api/assistant/chats/${id}`))

/** This person's saved sessions, the latest used first. */
export const listChats = async (): Promise<readonly ChatSummary[]> => (await json<{ chats: ChatSummary[] }>(await fetch('/api/assistant/chats'))).chats

/** Delete a session for good. */
export const deleteChat = async (id: string): Promise<void> => {
  const r = await fetch(`/api/assistant/chats/${id}`, { method: 'DELETE' })
  if (!r.ok && r.status !== 404) throw new Error(`the server answered ${r.status}`)
}

export const fileDraft = async (id: string, draft: string): Promise<string> => (await json<{ url: string }>(await fetch(`/api/assistant/chats/${id}/file/${draft}`, { method: 'POST' }))).url

/** This tab's answer to an editor action the turn asked it to run: what it came to, or the person's no. */
export const answerCall = async (id: string, callId: string, answer: { readonly outcome: ActionOutcome } | { readonly declined: true }): Promise<void> => {
  await fetch(`/api/assistant/chats/${id}/result/${callId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer) })
}

/** The person's Stop: the turn ends at its next step. */
export const stopChat = async (id: string): Promise<void> => {
  await fetch(`/api/assistant/chats/${id}/stop`, { method: 'POST' })
}

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

/**
 * Say something; each event of the turn reaches `on` as it streams. Resolves when the turn ends. In an editing mode
 * the editor's actions go with it, as the tools the model may call; a model picked goes with it too (ADR 0199).
 */
export const say = async (
  id: string,
  text: string,
  context: EditorContext,
  on: (e: AssistantEvent) => void,
  sent: { readonly mode: AssistantMode; readonly tools: readonly EditorTool[]; readonly model?: string } = { mode: 'assistant', tools: [] },
): Promise<void> => {
  const tools = sent.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  const r = await fetch(`/api/assistant/chats/${id}/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, context, mode: sent.mode, ...(sent.mode === 'assistant' ? {} : { tools }), ...(sent.model === undefined ? {} : { model: sent.model }) }),
  })
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
