import type { ActionOutcome } from '../actions'

/**
 * The editor as the assistant's chat drives it (ADR 0195): the editor's actions an agent is handed as tools, run in a
 * turn — one undo for the whole prompt (ADR 0194) — and each described in words for the person. One shape for the chat
 * in the editor's own tab (`localLink`, `editorLinkLocal.ts`) and for the chat moved to a tab of its own, which reaches
 * the editor tab that opened it over a channel (`remoteLink`, here: that tab has no editor of its own).
 */

/** An editor action as a tool for the model; `edits` when it changes the document — what Confirm asks about. */
export interface EditorTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Readonly<Record<string, unknown>>
  readonly edits: boolean
}

export interface EditorLink {
  /** The actions handed to the model this prompt. */
  readonly tools: () => Promise<readonly EditorTool[]>
  /** A prompt begins: its edits will be one undo. */
  readonly begin: (label: string) => Promise<void>
  readonly run: (name: string, input: unknown) => Promise<ActionOutcome>
  /** In words, for the person: the action and what it changes, objects by name. */
  readonly describe: (name: string, input: unknown) => Promise<string>
  /** The prompt ended: its edits become one undo entry. */
  readonly end: () => Promise<void>
}

/** The editor tab and the chat tabs it opened talk over this channel, each message addressed to one tab. */
export const LINK_CHANNEL = 'mp-assistant-link'

export type LinkOp = 'tools' | 'begin' | 'run' | 'describe' | 'end'
export interface LinkAsk {
  readonly kind: 'ask'
  /** The editor tab asked. */
  readonly tab: string
  /** The chat tab asking, for the answer to find it. */
  readonly from: string
  readonly req: number
  readonly op: LinkOp
  readonly name?: string
  readonly input?: unknown
  readonly label?: string
}
export interface LinkAnswer {
  readonly kind: 'answer'
  readonly to: string
  readonly req: number
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

/** How long each kind of request may take before the editor tab is taken to be gone. An action may fetch a prefab. */
const WAIT_MS: Record<LinkOp, number> = { tools: 3000, begin: 3000, run: 60_000, describe: 3000, end: 3000 }

/** The link in a chat tab of its own: every request to the editor tab that opened it, over the channel. */
export const remoteLink = (editorTab: string): EditorLink => {
  const channel = new BroadcastChannel(LINK_CHANNEL)
  const me = Math.random().toString(36).slice(2, 10)
  let req = 0
  const ask = <T,>(op: LinkOp, extra: Partial<Pick<LinkAsk, 'name' | 'input' | 'label'>> = {}): Promise<T> =>
    new Promise((resolve, reject) => {
      const n = ++req
      const on = (e: MessageEvent<LinkAnswer>): void => {
        const d = e.data
        if (d?.kind !== 'answer' || d.to !== me || d.req !== n) return
        channel.removeEventListener('message', on)
        clearTimeout(timer)
        if (d.ok) resolve(d.value as T)
        else reject(new Error(d.error ?? 'the editor refused'))
      }
      const timer = setTimeout(() => {
        channel.removeEventListener('message', on)
        reject(new Error('the editor tab did not answer: is it still open?'))
      }, WAIT_MS[op])
      channel.addEventListener('message', on)
      const message: LinkAsk = { kind: 'ask', tab: editorTab, from: me, req: n, op, ...extra }
      channel.postMessage(message)
    })
  return {
    tools: () => ask('tools'),
    begin: (label) => ask('begin', { label }),
    run: (name, input) => ask('run', { name, input }),
    describe: (name, input) => ask('describe', { name, input }),
    end: () => ask('end'),
  }
}
