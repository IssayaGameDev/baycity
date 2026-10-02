import type { ActionOutcome } from '../actions'
import { icon } from '../icons'
import {
  answerCall,
  assistantStatus,
  chatSoFar,
  deleteChat,
  fileDraft,
  listChats,
  newChat,
  say,
  stopChat,
  type AssistantEvent,
  type AssistantMode,
  type Draft,
  type EditorContext,
  type ModelChoice,
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
 * applies them at once. Either way a prompt is one undo, and Stop ends it at its next step. The mode is picked beside
 * Send, as what the next message is sent in (ADR 0197).
 *
 * **Sessions** (ADR 0197): the server keeps each person's chats; the header's Chats menu starts a new one, opens a
 * saved one, or deletes one — asked once more first, as it is for good.
 *
 * **Model** (ADR 0199), for the people the server lists models to: picked beside the mode, what the next message is
 * answered by — any message, the conversation so far going to it as it is; a saved chat opens on its last one.
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

/** What each mode does, under its name in the mode menu. */
export const MODE_NOTES: Readonly<Record<AssistantMode, string>> = {
  assistant: 'Reads and explains. Changes nothing.',
  confirm: 'Changes the open level or prefab, asking before each change.',
  auto: 'Makes the changes itself. One Ctrl+Z takes back a whole message.',
}

/** What a model costs, under its name in the model menu. */
const pricesOf = (m: ModelChoice): string => `$${m.prices.input} in · $${m.prices.output} out, a million tokens`

/** A chat with nothing said yet, in the menu's words. */
const NEW_CHAT = 'New chat'

/** What a session is called before the server has a title for it: the first words of its first message. */
const titleOf = (text: string): string => {
  const words = text.replace(/\s+/g, ' ').trim()
  return words.length <= 48 ? words : `${words.slice(0, 47).trimEnd()}…`
}

/** How long ago, short. */
const ago = (ms: number, now = Date.now()): string => {
  const min = Math.round((now - ms) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`
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
  /** Whether this person has the editing modes and the chat an editor to change. */
  let canEdit = false
  /** The models this person may pick, the default first; none for everyone else. */
  let models: readonly ModelChoice[] = []
  /** The model the next message is answered by; `null` leaves it to the server. */
  let model: string | null = null

  const root = opts.root
  root.replaceChildren()
  root.classList.add('asst')

  const head = el('div', 'asst-head')
  // The session this window shows, and the menu of the others.
  const chats = el('button', 'asst-chats')
  chats.type = 'button'
  chats.title = 'Chats: start a new one, open or delete a saved one'
  const chatTitle = el('span', 'asst-chats-t', NEW_CHAT)
  chats.append(chatTitle, icon('chevron', 'ic asst-chev'))
  chats.addEventListener('click', () => void openChatsMenu())
  const spent = el('span', 'asst-spent')
  head.append(icon('assistant', 'ic asst-head-i'), chats, spent)
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
  // What the next message is sent in: beside Send, shown once the server says the editing modes are this person's.
  const modePick = el('button', 'asst-modepick')
  modePick.type = 'button'
  modePick.title = 'Mode: what the assistant may do with your next message'
  const modeLabel = el('span', '', MODE_LABELS.assistant)
  modePick.append(modeLabel, icon('chevron', 'ic asst-chev'))
  modePick.hidden = true
  modePick.addEventListener('click', () => openModeMenu())
  // Who answers the next message: beside the mode, shown once the server lists models to pick from.
  const modelPick = el('button', 'asst-modelpick')
  modelPick.type = 'button'
  modelPick.title = 'Model: who answers your next message'
  const modelLabel = el('span')
  modelPick.append(modelLabel, icon('chevron', 'ic asst-chev'))
  modelPick.hidden = true
  modelPick.addEventListener('click', () => openModelMenu())
  const send = button('asst-send', 'send', 'Send', () => void submit())
  const stopper = button('asst-stop', 'stop', 'Stop — what it changed so far stays one Ctrl+Z', () => void stop())
  stopper.hidden = true
  form.append(input, modelPick, modePick, send, stopper)
  root.append(head, log, form)

  /** The open menu, and how it closes: a pick, a press elsewhere, Escape. */
  let closeMenu: (() => void) | null = null
  const menu = (anchor: HTMLElement, rows: readonly HTMLElement[], above: boolean): void => {
    closeMenu?.()
    const pop = el('div', `asst-pop${above ? ' asst-pop-up' : ''}`)
    pop.append(...rows)
    const box = root.getBoundingClientRect()
    const at = anchor.getBoundingClientRect()
    if (above) {
      pop.style.bottom = `${box.bottom - at.top + 4}px`
      pop.style.right = `${Math.max(4, box.right - at.right)}px`
    } else {
      pop.style.top = `${at.bottom - box.top + 4}px`
      pop.style.left = `${Math.max(4, at.left - box.left)}px`
    }
    root.append(pop)
    const away = (e: Event): void => {
      if (!pop.contains(e.target as globalThis.Node) && !anchor.contains(e.target as globalThis.Node)) closeMenu?.()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu?.()
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
    closeMenu = () => {
      pop.remove()
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', key, true)
      closeMenu = null
    }
  }
  const menuRow = (className: string, onPick: () => void, ...content: (Node | string)[]): HTMLButtonElement => {
    const row = el('button', `asst-pop-row ${className}`)
    row.type = 'button'
    row.append(...content)
    row.addEventListener('click', onPick)
    return row
  }

  const openModeMenu = (): void => {
    if (busy) return
    menu(
      modePick,
      (['assistant', 'confirm', 'auto'] as const).map((m) =>
        menuRow(`asst-pop-mode${m === mode ? ' on' : ''}`, () => {
          closeMenu?.()
          setMode(m)
        }, el('span', 'asst-pop-t', MODE_LABELS[m]), el('span', 'asst-pop-d', MODE_NOTES[m])),
      ),
      true,
    )
  }

  const openModelMenu = (): void => {
    if (busy) return
    menu(
      modelPick,
      models.map((m) =>
        menuRow(`asst-pop-model${m.id === model ? ' on' : ''}`, () => {
          closeMenu?.()
          setModel(m.id)
        }, el('span', 'asst-pop-t', m.label), el('span', 'asst-pop-d', pricesOf(m))),
      ),
      true,
    )
  }

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
    modePick.disabled = on
    modelPick.disabled = on
    chats.disabled = on
  }

  const setMode = (m: AssistantMode): void => {
    if (busy) return
    mode = canEdit ? m : 'assistant'
    modeLabel.textContent = MODE_LABELS[mode]
    modePick.dataset.mode = mode
  }

  /** Pick one of the listed models; an id the list does not have is left alone. */
  const setModel = (id: string): void => {
    const m = models.find((x) => x.id === id)
    if (m === undefined) return
    model = m.id
    modelLabel.textContent = m.label
  }

  /** Show a session: the new one, empty, or a saved one drawn again — waited for while it is still answering elsewhere. */
  const showChat = async (id: string | null): Promise<void> => {
    chatId = id
    filed.clear()
    if (id === null) {
      chatTitle.textContent = NEW_CHAT
      draw([])
      return
    }
    let so = await chatSoFar(id)
    while (so.busy) {
      await new Promise((r) => setTimeout(r, 1500))
      so = await chatSoFar(id)
    }
    for (const [d, url] of Object.entries(so.filed)) filed.set(d, url)
    chatTitle.textContent = so.title !== undefined && so.title !== '' ? so.title : NEW_CHAT
    if (so.mode !== undefined) setMode(so.mode)
    if (so.model !== undefined) setModel(so.model)
    draw(so.shown)
  }

  /** The Chats menu: a new chat, then the saved ones, the latest first, each with a delete asked once more. */
  const openChatsMenu = async (): Promise<void> => {
    if (busy || status?.ready !== true) return
    let saved: readonly { id: string; title: string; lastUsed: number }[] = []
    try {
      saved = await listChats()
    } catch (e) {
      note(String(e instanceof Error ? e.message : e), 'asst-err')
    }
    const rows: HTMLElement[] = [
      menuRow('asst-pop-new', () => {
        closeMenu?.()
        void showChat(null)
      }, icon('plus', 'ic'), el('span', 'asst-pop-t', NEW_CHAT)),
    ]
    for (const s of saved) {
      const row = el('div', `asst-pop-chat${s.id === chatId ? ' on' : ''}`)
      const open = menuRow('asst-pop-open', () => {
        closeMenu?.()
        void showChat(s.id).catch((e: unknown) => note(String(e instanceof Error ? e.message : e), 'asst-err'))
      }, el('span', 'asst-pop-t', s.title === '' ? NEW_CHAT : s.title), el('span', 'asst-pop-d', ago(s.lastUsed)))
      const del = button('asst-pop-x', 'trash', 'Delete this chat', () => {
        // For good, so asked once more, in the row itself.
        const sure = el('div', 'asst-pop-sure')
        sure.append(
          el('span', 'asst-pop-t', `Delete “${s.title === '' ? NEW_CHAT : s.title}”?`),
          menuRow('asst-pop-yes', () => {
            void deleteChat(s.id).then(
              () => {
                row.remove()
                if (s.id === chatId) void showChat(null)
              },
              (e: unknown) => note(String(e instanceof Error ? e.message : e), 'asst-err'),
            )
          }, 'Delete'),
          menuRow('asst-pop-no', () => sure.replaceWith(open, del), 'Cancel'),
        )
        open.replaceWith(sure)
        del.remove()
      })
      row.append(open, del)
      rows.push(row)
    }
    if (saved.length === 0) rows.push(el('div', 'asst-pop-empty', 'No saved chats yet'))
    menu(chats, rows, false)
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
    if (log.querySelector('.asst-you') === null) chatTitle.textContent = titleOf(text)
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
      const picked = model === null ? {} : { model }
      await say(chatId, text, await opts.context(), onEvent, editing ? { mode, tools, ...picked } : { mode: 'assistant', tools: [], ...picked })
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
      canEdit = opts.link !== undefined && (status.modes ?? []).some((m) => m !== 'assistant')
      modePick.hidden = !canEdit
      models = status.models ?? []
      modelPick.hidden = models.length < 2
      if (models[0] !== undefined) setModel(models[0].id)
      if (status.storage !== undefined) {
        const mb = (b: number): string => `${Math.round(b / 1024 ** 2)} MB`
        note(`Saved chats take ${mb(status.storage.bytes)} on the server, past the ${mb(status.storage.warnAt)} warning. Unused ones go after 30 days; delete old ones to free space now.`, 'asst-err')
      }
      // Carried from another tab: still answering there, waited for, then drawn whole.
      if (chatId !== null) await showChat(chatId)
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
