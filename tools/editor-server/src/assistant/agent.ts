import type Anthropic from '@anthropic-ai/sdk'

import { costOf, type Budget, type Usage } from './budget'
import type { AssistantModel } from './models'
import { activityOf, type Draft, type ToolRun } from './tools'

/**
 * The assistant's conversations and its turn (ADR 0192): a person's message, then the model and its tools in a loop
 * until it answers — streamed to the chat as it goes, counted against the person's day.
 *
 * A conversation lives here, in memory, for as long as its tab does (Kodjo's call): created by the tab, closed when
 * the tab goes, and dropped after a long silence in case it never says so. Moving it to another tab is the new tab
 * asking for it by id — the same person, so only they can.
 */

/** Model calls in one turn at most: a search, a read, another, an answer — and a stop before it runs away. */
export const MAX_ROUNDS = 12
/** The same in the modes that edit (ADR 0195): reading the scene, a change or several, a look at the result. */
export const EDIT_ROUNDS = 30

/**
 * What the assistant may do in this chat (ADR 0195, Kodjo's calls): `assistant` reads and reports; `confirm` changes
 * the open level or prefab through the editor's actions, each change applied only on the person's click; `auto` the
 * same, applied at once.
 */
export type AssistantMode = 'assistant' | 'confirm' | 'auto'
export const ASSISTANT_MODES: readonly AssistantMode[] = ['assistant', 'confirm', 'auto']
/** Most a reply may write: room for a model that sends many calls at once. Only what is written is paid for. */
export const MAX_TOKENS = 8192
/** A call whose reply was cut off at `MAX_TOKENS` before it was whole: not run, and what to do instead. */
export const CUT_OFF = 'Not run: your reply was cut off at its length limit before its calls were complete. Make fewer calls at once.'
/** A call nothing answered — a reply that stopped for another reason, or a conversation saved with one. */
export const UNANSWERED = 'Not run: the turn ended before this call was answered.'
/** A conversation nobody has spoken in for this long is dropped. */
export const IDLE_MS = 6 * 60 * 60 * 1000
/**
 * Tool results of earlier turns further back than this many messages go back to the model trimmed. Never this
 * turn's: a model that has lost an id it read makes one up (ADR 0195).
 */
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
  /** An editor action for the tab to run (ADR 0195), answered by its result. */
  | { readonly kind: 'call'; readonly call: { readonly id: string; readonly name: string; readonly input: unknown } }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string }

/** What a turn needs of a model call: the finished message, its text streamed out as it comes. */
export type Talk = (
  request: { readonly model: string; readonly system: Anthropic.TextBlockParam[]; readonly tools: Anthropic.Tool[]; readonly messages: Anthropic.MessageParam[] },
  onText: (delta: string) => void,
) => Promise<{ readonly content: readonly Anthropic.ContentBlock[]; readonly usage: Usage; readonly stop_reason: string | null }>

export interface Conversation {
  readonly id: string
  readonly email: string
  readonly name: string
  /** What the session list calls it: the first words of its first message (ADR 0197). */
  title: string
  /** The mode its last message was sent in, kept with it. */
  mode: AssistantMode
  /** The model its last message was answered by, an id of `MODELS` (ADR 0199). */
  model: string
  readonly createdAt: number
  readonly messages: Anthropic.MessageParam[]
  readonly shown: Shown[]
  readonly drafts: Map<string, Draft>
  /** Drafts filed, and where. */
  readonly filed: Map<string, string>
  lastUsed: number
  busy: boolean
  /** The person asked it to stop: the turn ends at the next step. */
  stopping: boolean
}

const contextBlock = (c: EditorContext, mode: AssistantMode): string => {
  const lines = [
    `mode: ${mode}`,
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
 * The messages as they go to the model: earlier turns' older tool results trimmed — this turn's, from `turnStart`, kept
 * whole — and a cache point on the newest block so the conversation so far is read from cache, not paid for again.
 */
export const forModel = (messages: readonly Anthropic.MessageParam[], turnStart: number): Anthropic.MessageParam[] =>
  messages.map((m, n) => {
    const old = n < turnStart && n < messages.length - KEEP_RESULTS
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

/**
 * The messages with every tool call answered, as the API wants them: a call the next message has no result for gets
 * one, `UNANSWERED`, at that message's front — or in a message of its own when none follows. A conversation saved
 * with one unanswered (a reply cut off, before that was handled) is otherwise one the API refuses for good.
 */
export const answered = (messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
  const out = [...messages]
  for (let n = 0; n < out.length; n++) {
    const m = out[n]!
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    const next = out[n + 1]
    const blocks: Anthropic.ContentBlockParam[] = next?.role !== 'user' ? [] : typeof next.content === 'string' ? [{ type: 'text', text: next.content }] : next.content
    const have = new Set(blocks.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])))
    const missing = m.content.flatMap((b): Anthropic.ToolResultBlockParam[] =>
      b.type === 'tool_use' && !have.has(b.id) ? [{ type: 'tool_result', tool_use_id: b.id, content: UNANSWERED, is_error: true }] : [],
    )
    if (missing.length === 0) continue
    if (next?.role === 'user') out[n + 1] = { role: 'user', content: [...missing, ...blocks] }
    else out.splice(n + 1, 0, { role: 'user', content: missing })
  }
  return out
}

export interface TurnDeps {
  /** How it behaves and where it looks: `ASSISTANT.md`, the system prompt (ADR 0193). */
  readonly instructions: string
  /** Every tool this turn: the server's, and in an editing mode the editor's actions (ADR 0195). */
  readonly tools: readonly Anthropic.Tool[]
  readonly mode: AssistantMode
  /** Who answers, and at what prices its calls are counted (ADR 0199). */
  readonly model: AssistantModel
  /** Model calls this turn at most; `MAX_ROUNDS` when absent. */
  readonly maxRounds?: number
  /** Tools whose activity the tab draws itself — the editor's, which it describes in its own words. */
  readonly silent?: (name: string) => boolean
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
  const over = (): boolean => deps.budget.spent(conv.email) >= deps.budget.limitOf(conv.email)
  if (over()) {
    emit({ kind: 'error', message: `Today's $${deps.budget.limitOf(conv.email).toFixed(2)} is used up. The assistant is back tomorrow (UTC).` })
    return
  }
  conv.busy = true
  conv.stopping = false
  conv.lastUsed = now()
  // A call an earlier turn left unanswered is answered now, so the API takes the conversation.
  conv.messages.splice(0, conv.messages.length, ...answered(conv.messages))
  // Where the turn began: a failed one is taken back out, so the next starts from a conversation the API accepts.
  const before = conv.messages.length
  const said0 = `${contextBlock(context, deps.mode)}\n\n${text}`
  const last = conv.messages[conv.messages.length - 1]
  // A turn that ended on the person's no, or their Stop, ends on tool results: this message joins them, as the API
  // takes one user turn at a time.
  if (last?.role === 'user' && Array.isArray(last.content)) conv.messages[conv.messages.length - 1] = { role: 'user', content: [...last.content, { type: 'text', text: said0 }] }
  else conv.messages.push({ role: 'user', content: said0 })
  const merged = last?.role === 'user' && Array.isArray(last.content) ? last : null
  conv.shown.push({ kind: 'you', text })
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: deps.instructions, cache_control: { type: 'ephemeral' } }]
  const tools: Anthropic.Tool[] = deps.tools.map((t, i) => (i === deps.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
  const rounds = deps.maxRounds ?? MAX_ROUNDS
  try {
    for (let round = 0; round < rounds; round++) {
      if (conv.stopping) break
      let said = ''
      const reply = await deps.talk({ model: deps.model.id, system, tools, messages: forModel(conv.messages, merged === null ? before : before - 1) }, (delta) => {
        said += delta
        emit({ kind: 'text', text: delta })
      })
      deps.budget.add(conv.email, costOf(reply.usage, deps.model.prices))
      emit({ kind: 'spent', spent: deps.budget.spent(conv.email), limit: deps.budget.limitOf(conv.email) })
      const content = reply.content.map(asParam).filter((b): b is Anthropic.ContentBlockParam => b !== null)
      conv.messages.push({ role: 'assistant', content })
      if (said !== '') conv.shown.push({ kind: 'assistant', text: said })
      const uses = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      if (uses.length === 0) break
      const results: Anthropic.ToolResultBlockParam[] = []
      // The person said no, or stop: what is left of this round is not run, and the turn ends with it answered.
      let ended = false
      if (reply.stop_reason !== 'tool_use') {
        // Its calls may be half-written: none is run, every one is answered. Cut off at its length, the model goes
        // again, told to make fewer; stopped for anything else, the turn ends there.
        const cut = reply.stop_reason === 'max_tokens'
        for (const use of uses) results.push({ type: 'tool_result', tool_use_id: use.id, content: cut ? CUT_OFF : UNANSWERED, is_error: true })
        ended = !cut
      } else {
        for (const use of uses) {
          if (ended || conv.stopping) {
            ended = true
            results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Not run: the person ended this turn.', is_error: true })
            continue
          }
          const input = typeof use.input === 'object' && use.input !== null ? (use.input as Record<string, unknown>) : {}
          const activity = activityOf(use.name, input)
          if (deps.silent?.(use.name) !== true) emit({ kind: 'activity', text: activity })
          conv.shown.push({ kind: 'activity', text: activity })
          const ran = await deps.run(use.name, input)
          if (ran.draft !== undefined) {
            conv.drafts.set(ran.draft.id, ran.draft)
            conv.shown.push({ kind: 'draft', draft: ran.draft })
            emit({ kind: 'draft', draft: ran.draft })
          }
          results.push({ type: 'tool_result', tool_use_id: use.id, content: ran.result, ...(ran.isError === true ? { is_error: true } : {}) })
          if (ran.ends === true) ended = true
        }
      }
      conv.messages.push({ role: 'user', content: results })
      if (ended || conv.stopping) break
      if (over()) {
        emit({ kind: 'error', message: `Today's $${deps.budget.limitOf(conv.email).toFixed(2)} ran out mid-answer. The assistant is back tomorrow (UTC).` })
        // The model's tool calls were answered, so the conversation stays well-formed for tomorrow.
        return
      }
      if (round === rounds - 1) emit({ kind: 'error', message: 'Stopped: that took too many steps. Ask a narrower question.' })
    }
    emit({ kind: 'done' })
  } catch (e) {
    conv.messages.length = before
    // The message that joined the last turn's results is taken back off them too.
    if (merged !== null) conv.messages[before - 1] = merged
    emit({ kind: 'error', message: `The assistant failed: ${e instanceof Error ? e.message : String(e)}` })
  } finally {
    conv.busy = false
    conv.lastUsed = now()
  }
}
