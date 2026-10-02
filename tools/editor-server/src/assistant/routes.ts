import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { User } from '../config'
import { encodeSse, SSE_HEADERS, SSE_KEEPALIVE } from '../sse'
import { ASSISTANT_MODES, EDIT_ROUNDS, IDLE_MS, MAX_ROUNDS, MAX_TOKENS, MODEL, runTurn, type AssistantEvent, type AssistantMode, type Conversation, type EditorContext, type Talk } from './agent'
import { createBudget, type Budget } from './budget'
import { createGitHub, repoOfRemote, type GitHub } from './github'
import { createRepoFiles, type RepoFiles } from './repoFiles'
import { createSessionStore, titleOf } from './sessions'
import { createToolRunner, TOOLS, type ToolRun } from './tools'

/**
 * The assistant's routes (ADR 0192), under `/api/assistant`, for a signed-in editor user only:
 *
 * | | |
 * | --- | --- |
 * | `GET /api/assistant` | `{ ready, why?, spent, limit }` — whether it is set up, and the person's day |
 * | `GET /api/assistant/chats` | the person's sessions, the latest used first (ADR 0197) → `{ chats }` |
 * | `POST /api/assistant/chats` | a new conversation → `{ id }` |
 * | `GET /api/assistant/chats/:id` | what it shows, to draw it again → `{ shown, filed, busy, title, mode }` |
 * | `DELETE /api/assistant/chats/:id` | the session gone, from memory and disk → 204 |
 * | `POST /api/assistant/chats/:id/say` | `{ text, context }` → the turn, as server-sent events |
 * | `POST /api/assistant/chats/:id/file/:draft` | the person files a draft → `{ url }` |
 * | `POST /api/assistant/chats/:id/result/:call` | the tab's answer to an editor action it was asked to run (ADR 0195) → 204 |
 * | `POST /api/assistant/chats/:id/stop` | the person's Stop: the turn ends at its next step → 204 |
 * | `POST /api/assistant/chats/:id/close` | the tab is going (a beacon): its calls answered; the session is kept → 204 |
 *
 * Keys: `anthropic.key` and `github.token` in the state directory, outside the checkout — read here and nowhere
 * else, never sent to the model or the browser. Looked for again while missing, so adding one needs no restart.
 *
 * Instructions: `ASSISTANT.md` at the checkout's root, the system prompt (ADR 0193) — read for every turn, so a deploy
 * that changes it needs nothing more. Missing, the assistant is not ready.
 *
 * Editing (ADR 0195): the modes that change the scene are open to the emails in `assistant-editors` in the state
 * directory, one a line — Kodjo's call: only him, for now. In one, the tab sends the editor's actions as tools with its
 * message; a call to one goes to the tab as a `call` event, and the turn waits for the tab's `result`. The person's no
 * to a change, or their Stop, ends the turn there.
 */

export interface AssistantOptions {
  readonly repoRoot: string
  readonly stateDir: string
  /** Dollars a person may spend a day. Kodjo's call: 1. */
  readonly limitUsd?: number
  /** The model call; the real one by default. Tests hand in their own. */
  readonly talk?: Talk
  /** GitHub; from `github.token` and the checkout's `origin` by default. `null` for none. */
  readonly github?: GitHub | null
  readonly now?: () => number
  /** All sessions on disk past this many bytes, and the people who may edit are warned (ADR 0197). */
  readonly sessionWarnBytes?: number
}

export interface Assistant {
  handle: (req: IncomingMessage, res: ServerResponse, url: string, user: User) => Promise<boolean>
  /** Drop the conversations nobody has spoken in for `IDLE_MS`. */
  sweep: () => void
}

const MAX_BODY = 64 * 1024
/** Sessions on disk past this, all people's together, and a warning says so (ADR 0197): 1 GB of the box's 40, Kodjo's call. */
const SESSION_WARN_BYTES = 1024 ** 3
/** How often the disk is swept for sessions past their thirty days, and measured. */
const DISK_SWEEP_MS = 60 * 60 * 1000
/** A tab's answer to an action can carry a picture of the viewport. */
const MAX_RESULT_BODY = 2 * 1024 * 1024
/** How long a turn waits for the tab to answer a call: in Confirm mode, for the person to decide. */
const CALL_WAIT_MS = 15 * 60 * 1000
/** Most of a result's text that goes back to the model. */
const MAX_RESULT_TEXT = 60_000

/** What the model is told when the person says no to a change; the turn ends with it (Kodjo's call). */
export const DECLINED = 'The person chose not to apply this change, and the turn ended there. Wait for them to say what they want instead.'

/** The editor's actions a tab sent as tools, checked: names a server tool does not have, a JSON Schema each, kept small. */
export const editorToolsOf = (raw: unknown): Anthropic.Tool[] => {
  if (!Array.isArray(raw)) return []
  const ours = new Set(TOOLS.map((t) => t.name))
  const out: Anthropic.Tool[] = []
  for (const t of raw.slice(0, 40)) {
    if (typeof t !== 'object' || t === null) continue
    const { name, description, input_schema: schema } = t as Record<string, unknown>
    if (typeof name !== 'string' || !/^[a-z][a-z_]{1,47}$/.test(name) || ours.has(name)) continue
    if (typeof description !== 'string' || typeof schema !== 'object' || schema === null || (schema as { type?: unknown }).type !== 'object') continue
    if (JSON.stringify(schema).length > 8000) continue
    out.push({ name, description: description.slice(0, 600), input_schema: schema as Anthropic.Tool.InputSchema })
  }
  return out
}

const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * What the tab answered, as the model takes it: the action's result as JSON — a picture of the viewport as an image
 * block — its refusal as an error, or the person's no, which ends the turn.
 */
export const runOfAnswer = (body: unknown): ToolRun => {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  if (b.declined === true) return { result: DECLINED, isError: true, ends: true }
  const o = typeof b.outcome === 'object' && b.outcome !== null ? (b.outcome as Record<string, unknown>) : {}
  if (o.ok === false) return { result: typeof o.error === 'string' ? o.error.slice(0, 2000) : 'the action failed', isError: true }
  if (o.ok !== true) return { result: 'the editor answered nothing usable', isError: true }
  const r = o.result
  const picture = typeof r === 'object' && r !== null ? (r as { image?: { mediaType?: unknown; data?: unknown } }).image : undefined
  if (picture !== undefined && typeof picture.data === 'string' && typeof picture.mediaType === 'string' && PICTURE_TYPES.has(picture.mediaType)) {
    const { image: _image, ...rest } = r as Record<string, unknown>
    return {
      result: [
        { type: 'image', source: { type: 'base64', media_type: picture.mediaType as 'image/jpeg', data: picture.data } },
        { type: 'text', text: JSON.stringify(rest) },
      ],
    }
  }
  return { result: JSON.stringify(r ?? null).slice(0, MAX_RESULT_TEXT) }
}

/** How the assistant behaves and where it looks, at the checkout's root (ADR 0193): Assistant mode's. */
export const INSTRUCTIONS_FILE = 'ASSISTANT.md'
/** The same for the modes that edit, Confirm and Auto (ADR 0195): how the editor's things are built, how to work. */
export const EDIT_INSTRUCTIONS_FILE = 'ASSISTANT-EDIT.md'

const NOT_SET_UP = 'The assistant is not set up on this server yet.'
const noInstructions = (file: string): string => `The assistant has no instructions: ${file} is missing.`
const NO_INSTRUCTIONS = noInstructions(INSTRUCTIONS_FILE)

/** A file's text, trimmed; `null` when it is missing or empty. */
const readText = (file: string): string | null => {
  if (!existsSync(file)) return null
  const v = readFileSync(file, 'utf8').trim()
  return v === '' ? null : v
}

/** The real model on this API key: Claude, streamed. What the server talks to, and what the eval does. */
export const claudeTalk = (apiKey: string): Talk => {
  const client = new Anthropic({ apiKey })
  return async (request, onText) => {
    const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system: request.system, tools: request.tools, messages: request.messages })
    stream.on('text', (delta) => onText(delta))
    const message = await stream.finalMessage()
    return { content: message.content, usage: message.usage, stop_reason: message.stop_reason }
  }
}

const readJson = (req: IncomingMessage, limit = MAX_BODY): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('message too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('not JSON'))
      }
    })
    req.on('error', reject)
  })

const send = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 300)) : undefined)
const string = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v.slice(0, 300) : undefined)

/** The editor's context as a browser sent it: strings only, each kept short. */
export const contextOf = (raw: unknown): EditorContext => {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const out: { -readonly [K in keyof EditorContext]: EditorContext[K] } = {}
  const game = string(r.game)
  const level = string(r.level)
  const prefab = string(r.prefab)
  const selection = strings(r.selection)
  const problems = strings(r.problems)
  if (game !== undefined) out.game = game
  if (level !== undefined) out.level = level
  if (prefab !== undefined) out.prefab = prefab
  if (selection !== undefined) out.selection = selection
  if (problems !== undefined) out.problems = problems
  return out
}

export const createAssistant = (opts: AssistantOptions): Assistant => {
  const now = opts.now ?? (() => Date.now())
  const budget: Budget = createBudget({ file: join(opts.stateDir, 'assistant-spend.json'), limit: opts.limitUsd ?? 1, now })
  const files: RepoFiles = createRepoFiles(opts.repoRoot)
  /** The sessions in use, from disk when first asked for; on disk they stay (ADR 0197). */
  const chats = new Map<string, Conversation>()
  const store = createSessionStore(join(opts.stateDir, 'assistant-chats'))
  const warnBytes = opts.sessionWarnBytes ?? SESSION_WARN_BYTES
  /** What all sessions take on disk, as the last sweep measured; swept now, so a restart knows. */
  let storedBytes = store.sweep(now()).bytes
  let sweptAt = now()
  let draftCount = 0

  let talk: Talk | null = opts.talk ?? null
  const talkNow = (): Talk | null => {
    if (talk !== null) return talk
    const key = readText(join(opts.stateDir, 'anthropic.key'))
    if (key !== null) talk = claudeTalk(key)
    return talk
  }

  let github: GitHub | null | undefined = opts.github
  const githubNow = (): GitHub | null => {
    if (github !== undefined && github !== null) return github
    if (opts.github === null) return null
    const token = readText(join(opts.stateDir, 'github.token'))
    if (token === null) return null
    let repo: string | null = null
    try {
      repo = repoOfRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: opts.repoRoot, encoding: 'utf8' }))
    } catch {
      repo = null
    }
    github = repo === null ? null : createGitHub({ token, repo })
    return github
  }

  const instructionsNow = (): string | null => readText(join(opts.repoRoot, INSTRUCTIONS_FILE))
  /** Whether this person may use the editing modes: their email in `assistant-editors`, read each time it is asked. */
  const mayEdit = (email: string): boolean =>
    (readText(join(opts.stateDir, 'assistant-editors')) ?? '')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .some((l) => l !== '' && !l.startsWith('#') && l === email)

  /** Each conversation's calls waiting on its tab, by call id: how each is answered. */
  const waiting = new Map<string, Map<string, (run: ToolRun) => void>>()
  const callsOf = (chatId: string): Map<string, (run: ToolRun) => void> => {
    let m = waiting.get(chatId)
    if (m === undefined) waiting.set(chatId, (m = new Map()))
    return m
  }
  /** Answer every call a conversation is waiting on: its tab stopped, or went. */
  const endCalls = (chatId: string, why: string): void => {
    for (const finish of [...(waiting.get(chatId)?.values() ?? [])]) finish({ result: why, isError: true, ends: true })
  }
  /** Hand an editor action to the tab, and wait for its answer. */
  const askTab = (chatId: string, name: string, input: unknown, emit: (e: AssistantEvent) => void): Promise<ToolRun> =>
    new Promise((resolve) => {
      const id = randomBytes(6).toString('hex')
      const calls = callsOf(chatId)
      let timer: ReturnType<typeof setTimeout> | undefined = undefined
      const finish = (run: ToolRun): void => {
        clearTimeout(timer)
        calls.delete(id)
        resolve(run)
      }
      timer = setTimeout(() => finish({ result: 'The editor tab did not answer.', isError: true, ends: true }), CALL_WAIT_MS)
      calls.set(id, finish)
      emit({ kind: 'call', call: { id, name, input } })
    })
  /** Why no turn can run now, or `null`: a key and the instructions are both needed. */
  const whyNot = (): string | null => (talkNow() === null ? NOT_SET_UP : instructionsNow() === null ? NO_INSTRUCTIONS : null)

  /** One of this person's sessions: in use, or from disk. Never another person's. */
  const chatOf = (id: string, user: User): Conversation | null => {
    const email = user.email.toLowerCase()
    const c = chats.get(id)
    if (c !== undefined) return c.email === email ? c : null
    const loaded = store.load(email, id)
    if (loaded !== null) chats.set(id, loaded)
    return loaded
  }
  /** Written to disk: after a turn, a filing, an opening. A session with nothing said yet is not written. */
  const keep = (c: Conversation): void => {
    if (c.messages.length > 0) store.save(c)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    if (url !== '/api/assistant' && !url.startsWith('/api/assistant/')) return false
    const email = user.email.toLowerCase()

    if (url === '/api/assistant' && req.method === 'GET') {
      const why = whyNot()
      const modes: readonly AssistantMode[] = mayEdit(email) ? ASSISTANT_MODES : ['assistant']
      // Who may edit is told when the sessions grow past the warning: Kodjo's to act on.
      const storage = mayEdit(email) && storedBytes >= warnBytes ? { storage: { bytes: storedBytes, warnAt: warnBytes } } : {}
      send(res, 200, { ready: why === null, ...(why === null ? {} : { why }), github: githubNow() !== null, spent: budget.spent(email), limit: budget.limit, modes, ...storage })
      return true
    }

    if (url === '/api/assistant/chats' && req.method === 'GET') {
      send(res, 200, { chats: store.list(email) })
      return true
    }

    if (url === '/api/assistant/chats' && req.method === 'POST') {
      const why = whyNot()
      if (why !== null) return send(res, 503, { error: why }), true
      const id = randomBytes(16).toString('hex')
      const t = now()
      chats.set(id, { id, email, name: user.name, title: '', mode: 'assistant', createdAt: t, messages: [], shown: [], drafts: new Map(), filed: new Map(), lastUsed: t, busy: false, stopping: false })
      send(res, 200, { id })
      return true
    }

    const m = /^\/api\/assistant\/chats\/([0-9a-f]{32})(?:\/(say|close|file|result|stop)(?:\/([\w-]+))?)?$/.exec(url)
    if (m === null) return send(res, 404, { error: 'no such assistant route' }), true
    const [, id, action, draftId] = m as unknown as [string, string, string | undefined, string | undefined]
    const chat = chatOf(id, user)

    if (action === 'close' && req.method === 'POST') {
      // The tab is going: what it was asked to run will not be answered. The session stays (ADR 0197).
      if (chat !== null) endCalls(chat.id, 'The chat’s tab was closed.')
      res.writeHead(204)
      res.end()
      return true
    }
    if (chat === null) return send(res, 404, { error: 'No such chat: it may have been deleted.' }), true

    if (action === undefined && req.method === 'DELETE') {
      endCalls(chat.id, 'The chat was deleted.')
      chats.delete(chat.id)
      waiting.delete(chat.id)
      store.remove(email, chat.id)
      res.writeHead(204)
      res.end()
      return true
    }

    if (action === 'stop' && req.method === 'POST') {
      chat.stopping = true
      endCalls(chat.id, 'Stopped by the person.')
      res.writeHead(204)
      res.end()
      return true
    }

    if (action === 'result' && req.method === 'POST' && draftId !== undefined) {
      const finish = waiting.get(chat.id)?.get(draftId)
      if (finish === undefined) return send(res, 404, { error: 'no such call waiting' }), true
      let body: unknown
      try {
        body = await readJson(req, MAX_RESULT_BODY)
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : String(e) }), true
      }
      finish(runOfAnswer(body))
      res.writeHead(204)
      res.end()
      return true
    }

    if (action === undefined && req.method === 'GET') {
      // Opening it is using it: its thirty days start again.
      chat.lastUsed = now()
      keep(chat)
      send(res, 200, { shown: chat.shown, filed: Object.fromEntries(chat.filed), busy: chat.busy, title: chat.title, mode: chat.mode })
      return true
    }

    if (action === 'say' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        const raw = await readJson(req)
        body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : String(e) }), true
      }
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 8000) : ''
      if (text === '') return send(res, 400, { error: 'nothing to say' }), true
      const mode: AssistantMode = body.mode === 'confirm' || body.mode === 'auto' ? body.mode : 'assistant'
      if (mode !== 'assistant' && !mayEdit(email)) return send(res, 403, { error: 'The editing modes are not open to you.' }), true
      const editorTools = mode === 'assistant' ? [] : editorToolsOf(body.tools)
      const editorNames = new Set(editorTools.map((t) => t.name))
      const model = talkNow()
      // Each mode its own system prompt: one that reads and reports, one that edits.
      const file = mode === 'assistant' ? INSTRUCTIONS_FILE : EDIT_INSTRUCTIONS_FILE
      const instructions = readText(join(opts.repoRoot, file))
      if (model === null || instructions === null) return send(res, 503, { error: model === null ? NOT_SET_UP : noInstructions(file) }), true
      res.writeHead(200, SSE_HEADERS)
      const keepalive = setInterval(() => res.write(SSE_KEEPALIVE), 15_000)
      const emit = (e: AssistantEvent): void => {
        if (!res.writableEnded) res.write(encodeSse(e.kind, e))
      }
      if (chat.title === '') chat.title = titleOf(text)
      chat.mode = mode
      const serverTools = createToolRunner({ files, github: githubNow(), nextDraftId: () => `d${++draftCount}` })
      const run = (name: string, input: Record<string, unknown>): Promise<ToolRun> => (editorNames.has(name) ? askTab(chat.id, name, input, emit) : serverTools(name, input))
      try {
        // Answered to the end whether or not the tab stays: a tab the conversation moved to reads the rest.
        await runTurn(
          chat,
          text,
          contextOf(body.context),
          { instructions, tools: [...TOOLS, ...editorTools], mode, maxRounds: mode === 'assistant' ? MAX_ROUNDS : EDIT_ROUNDS, silent: (n) => editorNames.has(n), talk: model, run, budget, now },
          emit,
        )
      } finally {
        clearInterval(keepalive)
        keep(chat)
        res.end()
      }
      return true
    }

    if (action === 'file' && req.method === 'POST' && draftId !== undefined) {
      const already = chat.filed.get(draftId)
      if (already !== undefined) return send(res, 200, { url: already }), true
      const draft = chat.drafts.get(draftId)
      if (draft === undefined) return send(res, 404, { error: 'no such draft' }), true
      const gh = githubNow()
      if (gh === null) return send(res, 503, { error: 'GitHub is not set up on this server.' }), true
      // Who raised it, written by the server rather than left to the model to remember.
      const footer = `\n\n---\nRaised by ${chat.name} in the editor.`
      try {
        const url2 = draft.kind === 'issue' ? (await gh.createIssue(draft.title, `${draft.body}${footer}`, draft.labels)).url : (await gh.comment(draft.number, `${draft.body}${footer}`)).url
        chat.filed.set(draftId, url2)
        keep(chat)
        send(res, 200, { url: url2 })
      } catch (e) {
        send(res, 502, { error: e instanceof Error ? e.message : String(e) })
      }
      return true
    }

    send(res, 405, { error: 'not that method' })
    return true
  }

  return {
    handle,
    sweep: () => {
      const t = now()
      // Out of memory after a long silence; on disk until its thirty days are up.
      for (const c of chats.values())
        if (!c.busy && t - c.lastUsed > IDLE_MS) {
          chats.delete(c.id)
          waiting.delete(c.id)
        }
      if (t - sweptAt < DISK_SWEEP_MS) return
      sweptAt = t
      storedBytes = store.sweep(t).bytes
      if (storedBytes >= warnBytes) console.warn(`assistant: saved chats take ${(storedBytes / 1024 ** 2).toFixed(0)} MB, past the ${(warnBytes / 1024 ** 2).toFixed(0)} MB warning`)
    },
  }
}
