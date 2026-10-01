import type Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { git } from '../git'
import type { Talk } from './agent'
import type { GitHub } from './github'
import { createAssistant } from './routes'

/**
 * The assistant's routes (ADR 0192), through a real server: a conversation is its owner's, a turn streams, a draft is
 * filed only when the person files it — with who raised it written by the server.
 */

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null })
const use = (id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } })

let repo = ''
let state = ''
let server: Server
let base = ''
const filed: { title: string; body: string; labels: readonly string[] }[] = []

const github: GitHub = {
  repo: 'o/r',
  searchIssues: async () => [],
  issue: async () => ({ number: 1, title: '', state: 'open', url: '', body: '', comments: [] }),
  createIssue: async (title, body, labels) => {
    filed.push({ title, body, labels })
    return { number: 12, url: 'https://github.com/o/r/issues/12' }
  },
  comment: async () => ({ url: '' }),
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'mp-assist-repo-'))
  state = mkdtempSync(join(tmpdir(), 'mp-assist-state-'))
  await git(repo, ['init', '--quiet'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  await git(repo, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'add', '-A'])
  await git(repo, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '--quiet', '-m', 'seed'])
  filed.length = 0
  let n = 0
  const talk: Talk = async (_request, onText) => {
    const replies: (readonly Anthropic.ContentBlock[])[] = [[use('t1', 'draft_issue', { title: 'Hazard misses riders', body: 'Steps…', labels: ['bug'] })], [text('Drafted.')]]
    const content = replies[n++] ?? [text('ok')]
    for (const b of content) if (b.type === 'text') onText(b.text)
    return { content, usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }
  }
  const assistant = createAssistant({ repoRoot: repo, stateDir: state, talk, github })
  const who = { ada: { name: 'Ada', email: 'ada@x.com' }, bob: { name: 'Bob', email: 'bob@x.com' } }
  server = createServer((req, res) => {
    const user = who[(req.headers['x-user'] as 'ada' | 'bob' | undefined) ?? 'ada']
    void assistant.handle(req, res, (req.url ?? '').split('?')[0]!, user).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(repo, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
})

const call = (path: string, init: { method?: string; body?: unknown; as?: 'ada' | 'bob' } = {}) =>
  fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'x-user': init.as ?? 'ada', 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })

describe('the assistant’s routes', () => {
  it('says it is ready, with the person’s day', async () => {
    expect(await (await call('/api/assistant')).json()).toEqual({ ready: true, github: true, spent: 0, limit: 1 })
  })

  it('streams a turn, keeps its draft, and files it only when asked — signed by the server', async () => {
    const { id } = (await (await call('/api/assistant/chats', { method: 'POST' })).json()) as { id: string }
    const stream = await (await call(`/api/assistant/chats/${id}/say`, { method: 'POST', body: { text: 'Hazards miss me', context: { game: 'keyboard' } } })).text()
    expect(stream).toContain('event: draft')
    expect(stream).toContain('event: done')
    expect(filed, 'nothing filed by the model').toEqual([])

    const shown = (await (await call(`/api/assistant/chats/${id}`)).json()) as { shown: { kind: string }[] }
    expect(shown.shown.map((s) => s.kind)).toEqual(['you', 'activity', 'draft', 'assistant'])

    const r = await call(`/api/assistant/chats/${id}/file/d1`, { method: 'POST' })
    expect(await r.json()).toEqual({ url: 'https://github.com/o/r/issues/12' })
    expect(filed).toEqual([{ title: 'Hazard misses riders', body: 'Steps…\n\n---\nRaised by Ada in the editor.', labels: ['bug'] }])
    await call(`/api/assistant/chats/${id}/file/d1`, { method: 'POST' })
    expect(filed, 'filed once, however often it is clicked').toHaveLength(1)
  })

  it('is its owner’s alone, and ends when its tab closes', async () => {
    const { id } = (await (await call('/api/assistant/chats', { method: 'POST' })).json()) as { id: string }
    expect((await call(`/api/assistant/chats/${id}`, { as: 'bob' })).status).toBe(404)
    expect((await call(`/api/assistant/chats/${id}/close`, { method: 'POST', as: 'bob' })).status).toBe(204)
    expect((await call(`/api/assistant/chats/${id}`)).status, 'another person cannot close it').toBe(200)
    await call(`/api/assistant/chats/${id}/close`, { method: 'POST' })
    expect((await call(`/api/assistant/chats/${id}`)).status).toBe(404)
  })

  it('is not ready without a key, and says so', async () => {
    const bare = createAssistant({ repoRoot: repo, stateDir: state, github: null })
    const server2 = createServer((req, res) => void bare.handle(req, res, req.url ?? '', { name: 'Ada', email: 'ada@x.com' }))
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', () => r()))
    const at = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`
    expect(await (await fetch(`${at}/api/assistant`)).json()).toMatchObject({ ready: false, github: false })
    expect((await fetch(`${at}/api/assistant/chats`, { method: 'POST' })).status).toBe(503)
    await new Promise<void>((r) => server2.close(() => r()))
  })
})
