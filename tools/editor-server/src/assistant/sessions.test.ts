import type Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { git } from '../git'
import type { Conversation, Talk } from './agent'
import { createAssistant } from './routes'
import { createSessionStore, titleOf } from './sessions'

/**
 * The assistant's sessions on disk (ADR 0197): kept across tabs and restarts, a person's own, gone when deleted or
 * thirty days unused, kept without pictures, and a warning to the people who edit once they all grow past a size.
 */

let repo = ''
let state = ''
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'mp-sess-repo-'))
  state = mkdtempSync(join(tmpdir(), 'mp-sess-state-'))
  await git(repo, ['init', '--quiet'])
  writeFileSync(join(repo, 'ASSISTANT.md'), 'Answer.')
  await git(repo, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'add', '-A'])
  await git(repo, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '--quiet', '-m', 'seed'])
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'a'.repeat(32),
  email: 'ada@x.com',
  name: 'Ada',
  title: 'Rename the box',
  mode: 'confirm',
  model: 'claude-sonnet-5-5',
  createdAt: 1,
  messages: [{ role: 'user', content: 'Rename the box' }],
  shown: [{ kind: 'you', text: 'Rename the box' }],
  drafts: new Map(),
  filed: new Map([['d1', 'https://github.com/o/r/issues/1']]),
  lastUsed: 2,
  busy: false,
  stopping: false,
  ...over,
})

describe('the session store', () => {
  it('keeps a conversation whole and hands it back, to its owner only', () => {
    const store = createSessionStore(join(state, 'chats'))
    store.save(conversation())
    const back = store.load('ada@x.com', 'a'.repeat(32))
    expect(back?.title).toBe('Rename the box')
    expect(back?.mode).toBe('confirm')
    expect(back?.model).toBe('claude-sonnet-5-5')
    expect(back?.filed.get('d1')).toBe('https://github.com/o/r/issues/1')
    expect(back?.busy).toBe(false)
    expect(store.load('bob@x.com', 'a'.repeat(32))).toBeNull()
    expect(store.list('ada@x.com')).toEqual([{ id: 'a'.repeat(32), title: 'Rename the box', mode: 'confirm', lastUsed: 2 }])
    expect(store.list('bob@x.com')).toEqual([])
  })

  it('lists the latest used first, and forgets one deleted', () => {
    const store = createSessionStore(join(state, 'chats'))
    store.save(conversation({ id: '1'.repeat(32), title: 'old', lastUsed: 5 }))
    store.save(conversation({ id: '2'.repeat(32), title: 'new', lastUsed: 9 }))
    expect(store.list('ada@x.com').map((s) => s.title)).toEqual(['new', 'old'])
    expect(store.remove('ada@x.com', '1'.repeat(32))).toBe(true)
    expect(store.list('ada@x.com').map((s) => s.title)).toEqual(['new'])
  })

  it('opens a session saved before models were picked, or with one no longer offered, on the default (ADR 0199)', () => {
    const dir = join(state, 'chats')
    const store = createSessionStore(dir)
    store.save(conversation())
    const person = readdirSync(dir)[0]!
    const file = join(dir, person, `${'a'.repeat(32)}.json`)
    const { model: _model, ...older } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify(older))
    expect(store.load('ada@x.com', 'a'.repeat(32))?.model).toBe('claude-haiku-4-5-20251001')
    writeFileSync(file, JSON.stringify({ ...older, model: 'claude-gone-1' }))
    expect(store.load('ada@x.com', 'a'.repeat(32))?.model).toBe('claude-haiku-4-5-20251001')
  })

  it('keeps no picture of the viewport', () => {
    const dir = join(state, 'chats')
    const store = createSessionStore(dir)
    const picture: Anthropic.MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(5000) } }, { type: 'text', text: '{"width":512}' }] }],
    }
    store.save(conversation({ messages: [{ role: 'user', content: 'look' }, picture] }))
    const person = readdirSync(dir)[0]!
    const text = readFileSync(join(dir, person, `${'a'.repeat(32)}.json`), 'utf8')
    expect(text).not.toContain('AAAA')
    expect(text).toContain('[a picture of the viewport, not kept]')
  })

  it('sweeps a session unused for thirty days, and measures what is left', () => {
    const dir = join(state, 'chats')
    const store = createSessionStore(dir)
    store.save(conversation({ id: '1'.repeat(32) }))
    store.save(conversation({ id: '2'.repeat(32) }))
    const person = readdirSync(dir)[0]!
    const now = Date.now()
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000)
    utimesSync(join(dir, person, `${'1'.repeat(32)}.json`), old, old)
    const swept = store.sweep(now)
    expect(swept.removed).toBe(1)
    expect(swept.bytes).toBeGreaterThan(0)
    expect(store.list('ada@x.com').map((s) => s.id)).toEqual(['2'.repeat(32)])
  })

  it('calls a session by the first words of its first message', () => {
    expect(titleOf('  Make the   box red  ')).toBe('Make the box red')
    expect(titleOf('x'.repeat(60))).toHaveLength(48)
  })
})

describe('sessions through the routes', () => {
  const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null })
  const talk: Talk = async (_request, onText) => {
    onText('Done.')
    return { content: [text('Done.')], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: 'end_turn' }
  }
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  })
  /** An assistant over the shared state directory — a fresh one is a restart. */
  const serve = async (warnBytes?: number) => {
    const a = createAssistant({ repoRoot: repo, stateDir: state, talk, github: null, ...(warnBytes === undefined ? {} : { sessionWarnBytes: warnBytes }) })
    const s = createServer((req, res) => void a.handle(req, res, (req.url ?? '').split('?')[0]!, { name: 'Ada', email: 'ada@x.com' }))
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    return (path: string, init: { method?: string; body?: unknown } = {}) =>
      fetch(`${at}${path}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
  }

  it('keeps a session through a restart, with its title and mode', async () => {
    const before = await serve()
    const { id } = (await (await before('/api/assistant/chats', { method: 'POST' })).json()) as { id: string }
    await (await before(`/api/assistant/chats/${id}/say`, { method: 'POST', body: { text: 'How do I add a Hazard?' } })).text()
    const after = await serve()
    expect(((await (await after('/api/assistant/chats')).json()) as { chats: { id: string; title: string }[] }).chats).toMatchObject([{ id, title: 'How do I add a Hazard?', mode: 'assistant' }])
    const so = (await (await after(`/api/assistant/chats/${id}`)).json()) as { shown: { kind: string }[]; title: string }
    expect(so.shown.map((s) => s.kind)).toEqual(['you', 'assistant'])
    expect(so.title).toBe('How do I add a Hazard?')
  })

  it('lists no session where nothing was said', async () => {
    const call = await serve()
    await call('/api/assistant/chats', { method: 'POST' })
    expect(await (await call('/api/assistant/chats')).json()).toEqual({ chats: [] })
  })

  it('warns the people who edit, and only them, once the sessions pass the size', async () => {
    const before = await serve()
    const { id } = (await (await before('/api/assistant/chats', { method: 'POST' })).json()) as { id: string }
    await (await before(`/api/assistant/chats/${id}/say`, { method: 'POST', body: { text: 'hello' } })).text()
    const tiny = await serve(1)
    expect(await (await tiny('/api/assistant')).json()).not.toHaveProperty('storage')
    writeFileSync(join(state, 'assistant-editors'), 'ada@x.com')
    expect(await (await tiny('/api/assistant')).json()).toMatchObject({ storage: { warnAt: 1 } })
  })
})
