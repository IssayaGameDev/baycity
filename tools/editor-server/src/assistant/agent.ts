import type Anthropic from '@anthropic-ai/sdk'

import { costOf, type Budget, type Usage } from './budget'
import { activityOf, TOOLS, type Draft, type ToolRun } from './tools'

/**
 * The assistant's conversations and its turn (ADR 0192): a person's message, then the model and its tools in a loop
 * until it answers — streamed to the chat as it goes, counted against the person's day.
 *
 * A conversation lives here, in memory, for as long as its tab does (Kodjo's call): created by the tab, closed when
 * the tab goes, and dropped after a long silence in case it never says so. Moving it to another tab is the new tab
 * asking for it by id — the same person, so only they can.
 */

/** The cheaper model, Kodjo's call. */
export const MODEL = 'claude-haiku-4-5-20251001'
/** Model calls in one turn at most: a search, a read, another, an answer — and a stop before it runs away. */
export const MAX_ROUNDS = 12
export const MAX_TOKENS = 2048
/** A conversation nobody has spoken in for this long is dropped. */
export const IDLE_MS = 6 * 60 * 60 * 1000
/** Tool results further back than this many messages go back to the model trimmed: what it read stays read. */
const KEEP_RESULTS = 8

/** What the person is looking at in the editor, sent with each message. */
export interface EditorContext {
  readonly game?: string
  readonly level?: string
  /** A prefab open on top of the level. */
  readonly prefab?: string
  /** The selected objects, `name (Component, …)` each. */
  readonly selection?: readonly string[]
  /** The editor's latest warnings and errors. */
  readonly problems?: readonly string[]
}

/** What the chat shows, kept so a tab the conversation moves to can draw it again. */
export type Shown =
  | { readonly kind: 'you'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'activity'; readonly text: string }
  | { readonly kind: 'draft'; readonly draft: Draft }

/** What a turn streams to the chat. */
export type AssistantEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'activity'; readonly text: string }
  | { readonly kind: 'draft'; readonly draft: Draft }
  | { readonly kind: 'spent'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string }

/** What a turn needs of a model call: the finished message, its text streamed out as it comes. */
export type Talk = (
  request: { readonly system: Anthropic.TextBlockParam[]; readonly tools: Anthropic.Tool[]; readonly messages: Anthropic.MessageParam[] },
  onText: (delta: string) => void,
) => Promise<{ readonly content: readonly Anthropic.ContentBlock[]; readonly usage: Usage; readonly stop_reason: string | null }>

export interface Conversation {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly messages: Anthropic.MessageParam[]
  readonly shown: Shown[]
  readonly drafts: Map<string, Draft>
  /** Drafts filed, and where. */
  readonly filed: Map<string, string>
  lastUsed: number
  busy: boolean
}

const contextBlock = (c: EditorContext): string => {
  const lines = [
    c.game === undefined ? null : `game: ${c.game}`,
    c.level === undefined ? null : `level: ${c.level}`,
    c.prefab === undefined ? null : `prefab open: ${c.prefab}`,
    c.selection === undefined || c.selection.length === 0 ? 'selected: nothing' : `selected: ${c.selection.slice(0, 12).join('; ')}`,
    c.problems === undefined || c.problems.length === 0 ? null : `recent problems: ${c.problems.slice(-8).join(' | ')}`,
  ].filter((l): l is string => l !== null)
  return `<editor>\n${lines.join('\n')}\n</editor>`
}

/** A response block as the next request takes it back: text and tool calls, nothing else. */
const asParam = (b: Anthropic.ContentBlock): Anthropic.ContentBlockParam | null =>
  b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : null

/**
 * The messages as they go to the model: older tool results trimmed, and a cache point on the newest block so the
 * conversation so far is read from cache, not paid for again, on the next call.
 */
const forModel = (messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] =>
  messages.map((m, n) => {
    const old = n < messages.length - KEEP_RESULTS
    const last = n === messages.length - 1
    if (typeof m.content === 'string') return last ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m
    const content = m.content.map((b, i): Anthropic.ContentBlockParam => {
      let out: Anthropic.ContentBlockParam = b
      if (old && b.type === 'tool_result') out = { ...b, content: '[earlier result trimmed — read it again if needed]' }
      if (last && i === m.content.length - 1 && (out.type === 'text' || out.type === 'tool_result')) out = { ...out, cache_control: { type: 'ephemeral' } }
      return out
    })
    return { role: m.role, content }
  })

const CACHED_TOOLS: Anthropic.Tool[] = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))

export interface TurnDeps {
  /** How it behaves and where it looks: `ASSISTANT.md`, the system prompt (ADR 0193). */
  readonly instructions: string
  readonly talk: Talk
  readonly run: (name: string, input: Record<string, unknown>) => Promise<ToolRun>
  readonly budget: Budget
  readonly now?: () => number
}

/** One person's message, answered: the model and its tools in a loop, each step streamed through `emit`. */
export const runTurn = async (conv: Conversation, text: string, context: EditorContext, deps: TurnDeps, emit: (e: AssistantEvent) => void): Promise<void> => {
  const now = deps.now ?? (() => Date.now())
  if (conv.busy) {
    emit({ kind: 'error', message: 'Still answering the last message.' })
    return
  }
  const over = (): boolean => deps.budget.spent(conv.email) >= deps.budget.limit
  if (over()) {
    emit({ kind: 'error', message: `Today's $${deps.budget.limit.toFixed(2)} is used up. The assistant is back tomorrow (UTC).` })
    return
  }
  conv.busy = true
  conv.lastUsed = now()
  // Where the turn began: a failed one is taken back out, so the next starts from a conversation the API accepts.
  const before = conv.messages.length
  conv.messages.push({ role: 'user', content: `${contextBlock(context)}\n\n${text}` })
  conv.shown.push({ kind: 'you', text })
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: deps.instructions, cache_control: { type: 'ephemeral' } }]
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let said = ''
      const reply = await deps.talk({ system, tools: CACHED_TOOLS, messages: forModel(conv.messages) }, (delta) => {
        said += delta
        emit({ kind: 'text', text: delta })
      })
      deps.budget.add(conv.email, costOf(reply.usage))
      emit({ kind: 'spent', spent: deps.budget.spent(conv.email), limit: deps.budget.limit })
      const content = reply.content.map(asParam).filter((b): b is Anthropic.ContentBlockParam => b !== null)
      conv.messages.push({ role: 'assistant', content })
      if (said !== '') conv.shown.push({ kind: 'assistant', text: said })
      const uses = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      if (uses.length === 0 || reply.stop_reason !== 'tool_use') break
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const use of uses) {
        const input = typeof use.input === 'object' && use.input !== null ? (use.input as Record<string, unknown>) : {}
        const activity = activityOf(use.name, input)
        emit({ kind: 'activity', text: activity })
        conv.shown.push({ kind: 'activity', text: activity })
        const ran = await deps.run(use.name, input)
        if (ran.draft !== undefined) {
          conv.drafts.set(ran.draft.id, ran.draft)
          conv.shown.push({ kind: 'draft', draft: ran.draft })
          emit({ kind: 'draft', draft: ran.draft })
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: ran.result, ...(ran.isError === true ? { is_error: true } : {}) })
      }
      conv.messages.push({ role: 'user', content: results })
      if (over()) {
        emit({ kind: 'error', message: `Today's $${deps.budget.limit.toFixed(2)} ran out mid-answer. The assistant is back tomorrow (UTC).` })
        // The model's tool calls were answered, so the conversation stays well-formed for tomorrow.
        return
      }
      if (round === MAX_ROUNDS - 1) emit({ kind: 'error', message: 'Stopped: that took too many steps. Ask a narrower question.' })
    }
    emit({ kind: 'done' })
  } catch (e) {
    conv.messages.length = before
    emit({ kind: 'error', message: `The assistant failed: ${e instanceof Error ? e.message : String(e)}` })
  } finally {
    conv.busy = false
    conv.lastUsed = now()
  }
}
