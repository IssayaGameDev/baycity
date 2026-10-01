import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { User } from '../config'
import { encodeSse, SSE_HEADERS, SSE_KEEPALIVE } from '../sse'
import { IDLE_MS, MAX_TOKENS, MODEL, runTurn, type AssistantEvent, type Conversation, type EditorContext, type Talk } from './agent'
import { createBudget, type Budget } from './budget'
import { createGitHub, repoOfRemote, type GitHub } from './github'
import { createRepoFiles, type RepoFiles } from './repoFiles'
import { createToolRunner } from './tools'

/**
 * The assistant's routes (ADR 0192), under `/api/assistant`, for a signed-in editor user only:
 *
 * | | |
 * | --- | --- |
 * | `GET /api/assistant` | `{ ready, why?, spent, limit }` — whether it is set up, and the person's day |
 * | `POST /api/assistant/chats` | a new conversation → `{ id }` |
 * | `GET /api/assistant/chats/:id` | what it shows, for a tab it moves to → `{ shown, filed }` |
 * | `POST /api/assistant/chats/:id/say` | `{ text, context }` → the turn, as server-sent events |
 * | `POST /api/assistant/chats/:id/file/:draft` | the person files a draft → `{ url }` |
 * | `POST /api/assistant/chats/:id/close` | the tab is going (a beacon) → 204 |
 *
 * Keys: `anthropic.key` and `github.token` in the state directory, outside the checkout — read here and nowhere
 * else, never sent to the model or the browser. Looked for again while missing, so adding one needs no restart.
 *
 * Instructions: `ASSISTANT.md` at the checkout's root, the system prompt (ADR 0193) — read for every turn, so a deploy
 * that changes it needs nothing more. Missing, the assistant is not ready.
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
}

export interface Assistant {
  handle: (req: IncomingMessage, res: ServerResponse, url: string, user: User) => Promise<boolean>
  /** Drop the conversations nobody has spoken in for `IDLE_MS`. */
  sweep: () => void
}

/** Open conversations a person may hold at once: a tab each, and a few left behind. */
const MAX_OPEN = 6
const MAX_BODY = 64 * 1024

/** How the assistant behaves and where it looks, at the checkout's root (ADR 0193). */
export const INSTRUCTIONS_FILE = 'ASSISTANT.md'

const NOT_SET_UP = 'The assistant is not set up on this server yet.'
const NO_INSTRUCTIONS = `The assistant has no instructions: ${INSTRUCTIONS_FILE} is missing.`

/** A file's text, trimmed; `null` when it is missing or empty. */
const readText = (file: string): string | null => {
  if (!existsSync(file)) return null
  const v = readFileSync(file, 'utf8').trim()
  return v === '' ? null : v
}

/** The real model: Claude, streamed. */
export const claudeTalk =
  (client: Anthropic): Talk =>
  async (request, onText) => {
    const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system: request.system, tools: request.tools, messages: request.messages })
    stream.on('text', (delta) => onText(delta))
    const message = await stream.finalMessage()
    return { content: message.content, usage: message.usage, stop_reason: message.stop_reason }
  }

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
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
  const chats = new Map<string, Conversation>()
  let draftCount = 0

  let talk: Talk | null = opts.talk ?? null
  const talkNow = (): Talk | null => {
    if (talk !== null) return talk
    const key = readText(join(opts.stateDir, 'anthropic.key'))
    if (key !== null) talk = claudeTalk(new Anthropic({ apiKey: key }))
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
  /** Why no turn can run now, or `null`: a key and the instructions are both needed. */
  const whyNot = (): string | null => (talkNow() === null ? NOT_SET_UP : instructionsNow() === null ? NO_INSTRUCTIONS : null)

  const chatOf = (id: string, user: User): Conversation | null => {
    const c = chats.get(id)
    return c === undefined || c.email !== user.email.toLowerCase() ? null : c
  }

  const handle = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    if (url !== '/api/assistant' && !url.startsWith('/api/assistant/')) return false
    const email = user.email.toLowerCase()

    if (url === '/api/assistant' && req.method === 'GET') {
      const why = whyNot()
      send(res, 200, { ready: why === null, ...(why === null ? {} : { why }), github: githubNow() !== null, spent: budget.spent(email), limit: budget.limit })
      return true
    }

    if (url === '/api/assistant/chats' && req.method === 'POST') {
      const why = whyNot()
      if (why !== null) return send(res, 503, { error: why }), true
      const mine = [...chats.values()].filter((c) => c.email === email).sort((a, b) => a.lastUsed - b.lastUsed)
      for (const old of mine.slice(0, Math.max(0, mine.length - MAX_OPEN + 1))) chats.delete(old.id)
      const id = randomBytes(16).toString('hex')
      chats.set(id, { id, email, name: user.name, messages: [], shown: [], drafts: new Map(), filed: new Map(), lastUsed: now(), busy: false })
      send(res, 200, { id })
      return true
    }

    const m = /^\/api\/assistant\/chats\/([0-9a-f]{32})(?:\/(say|close|file)(?:\/([\w-]+))?)?$/.exec(url)
    if (m === null) return send(res, 404, { error: 'no such assistant route' }), true
    const [, id, action, draftId] = m as unknown as [string, string, string | undefined, string | undefined]
    const chat = chatOf(id, user)

    if (action === 'close' && req.method === 'POST') {
      if (chat !== null) chats.delete(chat.id)
      res.writeHead(204)
      res.end()
      return true
    }
    if (chat === null) return send(res, 404, { error: 'That conversation has ended.' }), true

    if (action === undefined && req.method === 'GET') {
      chat.lastUsed = now()
      send(res, 200, { shown: chat.shown, filed: Object.fromEntries(chat.filed), busy: chat.busy })
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
      const model = talkNow()
      const instructions = instructionsNow()
      if (model === null || instructions === null) return send(res, 503, { error: model === null ? NOT_SET_UP : NO_INSTRUCTIONS }), true
      res.writeHead(200, SSE_HEADERS)
      const keepalive = setInterval(() => res.write(SSE_KEEPALIVE), 15_000)
      const emit = (e: AssistantEvent): void => {
        if (!res.writableEnded) res.write(encodeSse(e.kind, e))
      }
      const run = createToolRunner({ files, github: githubNow(), nextDraftId: () => `d${++draftCount}` })
      try {
        // Answered to the end whether or not the tab stays: a tab the conversation moved to reads the rest.
        await runTurn(chat, text, contextOf(body.context), { instructions, talk: model, run, budget, now }, emit)
      } finally {
        clearInterval(keepalive)
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
      for (const c of chats.values()) if (!c.busy && t - c.lastUsed > IDLE_MS) chats.delete(c.id)
    },
  }
}
