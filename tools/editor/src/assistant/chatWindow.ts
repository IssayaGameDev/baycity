import type { ActionOutcome } from '../actions'
import { icon } from '../icons'
import {
  answerCall,
  assistantStatus,
  chatSoFar,
  fileDraft,
  newChat,
  say,
  stopChat,
  type AssistantEvent,
  type AssistantMode,
  type Draft,
  type EditorContext,
  type Shown,
  type Status,
} from './assistantApi'
import type { EditorLink, EditorTool } from './editorLink'
import { renderMarkdown } from './markdown'
import './assistant.css'

/**
 * The assistant's chat (ADR 0192): the conversation, what it is doing while it works, the drafts it proposes with the
 * button that files each, the person's day, and a box to type in. One window for both places it lives — the panel
 * over the editor's viewport and a tab of its own — so a conversation looks the same when it moves.
 *
 * The conversation is the server's, by id: made on the first message, carried to another tab by that id.
 *
 * **Modes** (ADR 0195), for the people the server opens them to: Assistant reads and reports; Confirm hands the model
 * the editor's actions and asks before each change — Apply, or Don't, which ends the prompt (Kodjo's calls); Auto
 * applies them at once. Either way a prompt is one undo, and Stop ends it at its next step.
 */

export interface ChatWindowOptions {
  /** Where it draws; emptied first. */
  readonly root: HTMLElement
  /** A conversation to carry on; a new one starts with the first message when absent. */
  readonly chatId?: string
  /** What the editor is looking at, asked before each message. */
  readonly context: () => Promise<EditorContext>
  /** Move it to a tab of its own; the button shows only with this. */
  readonly onPopOut?: (chatId: string) => void
  /** Put the window away; the button shows only with this. */
  readonly onClose?: () => void
  /** The editor the editing modes change; without one, the chat only reads and reports. */
  readonly link?: EditorLink
}

export interface ChatWindow {
  /** The server's conversation, once there is one. */
  readonly chatId: () => string | null
  readonly focus: () => void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const button = (className: string, iconName: Parameters<typeof icon>[0], title: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', className)
  b.type = 'button'
  b.title = title
  b.append(icon(iconName))
  b.addEventListener('click', onClick)
  return b
}

const money = (usd: number): string => `$${usd.toFixed(2)}`

export const INTRO =
  "Ask how to do something in the editor, or describe something that looks broken. I can read the code, the docs and the levels, and draft a bug report for you to file. I can't change anything."

const MODE_LABELS: Readonly<Record<AssistantMode, string>> = { assistant: 'Assistant', confirm: 'Confirm', auto: 'Auto' }

/** What each mode does, said when it is chosen. */
export const MODE_NOTES: Readonly<Record<AssistantMode, string>> = {
  assistant: 'Assistant: I read and explain. I change nothing.',
  confirm: 'Confirm: I can change the open level or prefab, and I ask before each change. Don’t ends what I was doing.',
  auto: 'Auto: I make the changes myself. One Ctrl+Z takes back everything one message did. Stop ends it.',
}

/** A prompt's label in the undo history: what was asked, short. */
const turnLabel = (text: string): string => `assistant: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`

export const createChatWindow = (opts: ChatWindowOptions): ChatWindow => {
  let chatId: string | null = opts.chatId ?? null
  let status: Status | null = null
  let busy = false
  const filed = new Map<string, string>()
  let mode: AssistantMode = 'assistant'
  /** The editor's actions this prompt was sent with. */
  let tools: readonly EditorTool[] = []
  /** The change waiting for the person's Apply or Don't: settles it, `null` for a Stop. */
  let settleCard: ((yes: boolean | null) => void) | null = null

  const root = opts.root
  root.replaceChildren()
  root.classList.add('asst')

  const head = el('div', 'asst-head')
  head.append(icon('assistant', 'ic asst-head-i'), el('span', 'asst-title', 'Assistant'))
  // Shown once the server says which modes are this person's, and only with an editor to change.
  const modes = el('div', 'asst-modes')
  modes.hidden = true
  const modeButtons = new Map<AssistantMode, HTMLButtonElement>()
  for (const m of ['assistant', 'confirm', 'auto'] as const) {
    const b = el('button', 'asst-mode', MODE_LABELS[m])
    b.type = 'button'
    b.addEventListener('click', () => setMode(m))
    modeButtons.set(m, b)
    modes.append(b)
  }
  const spent = el('span', 'asst-spent')
  head.append(modes, spent)
  if (opts.onPopOut !== undefined) {
    const pop = opts.onPopOut
    head.append(
      button('asst-hb', 'popOut', 'Open in a tab of its own — the conversation goes with it', () => {
        if (busy || status?.ready !== true) return
        // A conversation not started yet is started now, so the tab has one to carry on.
        void (chatId === null ? newChat() : Promise.resolve(chatId)).then(
          (id) => {
            chatId = id
            pop(id)
          },
          (e: unknown) => note(String(e instanceof Error ? e.message : e), 'asst-err'),
        )
      }),
    )
  }
  if (opts.onClose !== undefined) head.append(button('asst-hb', 'close', 'Put away', opts.onClose))

  const log = el('div', 'asst-log')
  const form = el('div', 'asst-form')
  const input = el('textarea', 'asst-in')
  input.rows = 2
  input.placeholder = 'Ask the assistant… (Enter sends, Shift+Enter for a new line)'
  const send = button('asst-send', 'send', 'Send', () => void submit())
  const stopper = button('asst-stop', 'stop', 'Stop — what it changed so far stays one Ctrl+Z', () => void stop())
  stopper.hidden = true
  form.append(input, send, stopper)
  root.append(head, log, form)

  const showSpent = (usd: number, limit: number): void => {
    spent.textContent = `${money(usd)} of ${money(limit)} today`
  }
  const atBottom = (): boolean => log.scrollHeight - log.scrollTop - log.clientHeight < 40
  const keepDown = (was: boolean): void => {
    if (was) log.scrollTop = log.scrollHeight
  }

  const you = (text: string): void => {
    log.append(el('div', 'asst-msg asst-you', text))
    log.scrollTop = log.scrollHeight
  }
  const note = (text: string, className = 'asst-note'): void => {
    const was = atBottom()
    log.append(el('div', className, text))
    keepDown(was)
  }

  /** The answer being written: its text so far, drawn again as it grows, at most once a frame. */
  let writing: { el: HTMLElement; text: string; queued: boolean } | null = null
  const write = (delta: string): void => {
    if (writing === null) {
      writing = { el: el('div', 'asst-msg asst-ai'), text: '', queued: false }
      log.append(writing.el)
    }
    const w = writing
    w.text += delta
    if (w.queued) return
    w.queued = true
    requestAnimationFrame(() => {
      w.queued = false
      const was = atBottom()
      w.el.innerHTML = renderMarkdown(w.text)
      keepDown(was)
    })
  }
  const answer = (text: string): void => {
    const was = atBottom()
    const m = el('div', 'asst-msg asst-ai')
    m.innerHTML = renderMarkdown(text)
    log.append(m)
    keepDown(was)
  }

  const draftCard = (draft: Draft): void => {
    const card = el('div', 'asst-draft')
    const kind = draft.kind === 'issue' ? 'Draft issue' : `Draft comment on #${draft.number}`
    card.append(el('div', 'asst-draft-k', kind))
    if (draft.kind === 'issue') card.append(el('div', 'asst-draft-t', draft.title))
    const body = el('div', 'asst-draft-b')
    body.innerHTML = renderMarkdown(draft.body)
    card.append(body)
    const foot = el('div', 'asst-draft-f')
    const done = (url: string): void => {
      const a = el('a', 'asst-filed', draft.kind === 'issue' ? 'Filed ↗' : 'Posted ↗')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      foot.replaceChildren(a)
    }
    const already = filed.get(draft.id)
    if (already !== undefined) done(already)
    else if (status?.github !== true) foot.append(el('span', 'asst-note', 'GitHub is not set up, so it cannot be filed from here.'))
    else {
      const fileIt = el('button', 'asst-file', draft.kind === 'issue' ? 'File it' : 'Post it')
      fileIt.type = 'button'
      fileIt.title = draft.kind === 'issue' ? 'Open this issue on GitHub, signed with your name' : 'Post this comment on GitHub, signed with your name'
      fileIt.addEventListener('click', () => {
        if (chatId === null) return
        fileIt.disabled = true
        fileIt.textContent = 'Filing…'
        fileDraft(chatId, draft.id).then(
          (url) => {
            filed.set(draft.id, url)
            done(url)
          },
          (e: unknown) => {
            fileIt.disabled = false
            fileIt.textContent = draft.kind === 'issue' ? 'File it' : 'Post it'
            foot.append(el('span', 'asst-err', String(e instanceof Error ? e.message : e)))
          },
        )
      })
      foot.append(fileIt)
    }
    card.append(foot)
    const was = atBottom()
    log.append(card)
    keepDown(was)
  }

  const draw = (shown: readonly Shown[]): void => {
    log.replaceChildren()
    note(INTRO, 'asst-intro')
    for (const s of shown) {
      if (s.kind === 'you') you(s.text)
      else if (s.kind === 'assistant') answer(s.text)
      else if (s.kind === 'activity') note(s.text, 'asst-act')
      else draftCard(s.draft)
    }
    log.scrollTop = log.scrollHeight
  }

  const setBusy = (on: boolean): void => {
    busy = on
    send.disabled = on || status?.ready !== true
    root.classList.toggle('asst-busy', on)
    stopper.hidden = !on || mode === 'assistant'
    for (const b of modeButtons.values()) b.disabled = on
  }

  const setMode = (m: AssistantMode): void => {
    if (busy || m === mode) return
    mode = m
    for (const [k, b] of modeButtons) b.setAttribute('aria-pressed', String(k === m))
    note(MODE_NOTES[m])
  }

  /**
   * A change the assistant wants to make, for the person to Apply or not (Confirm). Resolves their answer, or
   * `null` when Stop ended the prompt first.
   */
  const askCard = (words: string): Promise<{ readonly yes: boolean | null; readonly foot: HTMLElement }> =>
    new Promise((resolve) => {
      const card = el('div', 'asst-change')
      card.append(el('div', 'asst-draft-k', 'Change'), el('div', 'asst-change-t', words))
      const foot = el('div', 'asst-draft-f')
      const apply = el('button', 'asst-file', 'Apply')
      apply.type = 'button'
      const dont = el('button', 'asst-dont', 'Don’t')
      dont.type = 'button'
      const settle = (yes: boolean | null): void => {
        settleCard = null
        // Applied or not is said once the change has run: it can still be refused.
        foot.replaceChildren(el('span', 'asst-note', yes === true ? 'Applying…' : yes === false ? 'Not done — say what you want instead' : 'Stopped'))
        resolve({ yes, foot })
      }
      settleCard = settle
      apply.addEventListener('click', () => settle(true))
      dont.addEventListener('click', () => settle(false))
      foot.append(apply, dont)
      card.append(foot)
      const was = atBottom()
      log.append(card)
      keepDown(was)
    })

  /** An editor action the turn asks this tab to run: said in words, asked about in Confirm when it changes something, run, answered. */
  const handleCall = async (call: { readonly id: string; readonly name: string; readonly input: unknown }): Promise<void> => {
    const link = opts.link
    const id = chatId
    if (id === null) return
    if (link === undefined) {
      await answerCall(id, call.id, { outcome: { ok: false, error: 'this chat has no editor to change' } })
      return
    }
    const words = await link.describe(call.name, call.input).catch(() => call.name)
    const edits = tools.find((t) => t.name === call.name)?.edits === true
    let foot: HTMLElement | null = null
    if (edits && mode === 'confirm') {
      const asked = await askCard(words)
      if (asked.yes === null) return
      if (!asked.yes) {
        await answerCall(id, call.id, { declined: true })
        return
      }
      foot = asked.foot
    } else note(words, 'asst-act')
    const outcome: ActionOutcome = await link.run(call.name, call.input).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    // What came of it, on the card that asked; a refused change in Auto is the person's to see too.
    if (foot !== null) foot.replaceChildren(el('span', outcome.ok ? 'asst-note' : 'asst-err', outcome.ok ? 'Applied' : `Not applied — ${outcome.error}`))
    else if (!outcome.ok && edits) note(outcome.error, 'asst-err')
    await answerCall(id, call.id, { outcome })
  }

  const stop = async (): Promise<void> => {
    settleCard?.(null)
    if (chatId !== null) await stopChat(chatId).catch(() => undefined)
  }

  const onEvent = (e: AssistantEvent): void => {
    switch (e.kind) {
      case 'text':
        write(e.text)
        return
      case 'activity':
        writing = null
        note(e.text, 'asst-act')
        return
      case 'draft':
        writing = null
        draftCard(e.draft)
        return
      case 'spent':
        showSpent(e.spent, e.limit)
        return
      case 'call':
        writing = null
        void handleCall(e.call)
        return
      case 'error':
        writing = null
        note(e.message, 'asst-err')
        return
      case 'done':
        writing = null
    }
  }

  const submit = async (): Promise<void> => {
    const text = input.value.trim()
    if (text === '' || busy || status?.ready !== true) return
    input.value = ''
    you(text)
    setBusy(true)
    const link = opts.link
    const editing = mode !== 'assistant' && link !== undefined
    try {
      if (chatId === null) chatId = await newChat()
      if (editing) {
        tools = await link.tools()
        await link.begin(turnLabel(text))
      }
      await say(chatId, text, await opts.context(), onEvent, editing ? { mode, tools } : { mode: 'assistant', tools: [] })
    } catch (e) {
      note(String(e instanceof Error ? e.message : e), 'asst-err')
    } finally {
      // Whatever it changed is one entry now, whether it finished, was told no, or stopped.
      if (editing) await link.end().catch(() => undefined)
      settleCard?.(null)
      writing = null
      setBusy(false)
      input.focus()
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void submit()
    }
  })

  // What the server says first: set up or not, the person's day, and a conversation to carry on.
  note(INTRO, 'asst-intro')
  setBusy(true)
  void (async () => {
    try {
      status = await assistantStatus()
      if (!status.ready) {
        note(status.why ?? 'The assistant is not available.', 'asst-err')
        input.disabled = true
        return
      }
      showSpent(status.spent, status.limit)
      if (opts.link !== undefined && (status.modes ?? []).some((m) => m !== 'assistant')) {
        modes.hidden = false
        for (const [k, b] of modeButtons) b.setAttribute('aria-pressed', String(k === mode))
      }
      if (chatId !== null) {
        // Carried from another tab. Still answering there: wait for it to finish, then draw it all.
        let so = await chatSoFar(chatId)
        while (so.busy) {
          await new Promise((r) => setTimeout(r, 1500))
          so = await chatSoFar(chatId)
        }
        for (const [d, url] of Object.entries(so.filed)) filed.set(d, url)
        draw(so.shown)
      }
    } catch (e) {
      note(String(e instanceof Error ? e.message : e), 'asst-err')
      chatId = null
    } finally {
      setBusy(false)
    }
  })()

  return {
    chatId: () => chatId,
    focus: () => input.focus(),
  }
}
