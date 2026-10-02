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
import { createAssistant, DECLINED, editorToolsOf } from './routes'

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
  writeFileSync(join(repo, 'ASSISTANT.md'), 'Answer from the docs.\n')
  writeFileSync(join(repo, 'ASSISTANT-EDIT.md'), 'Edit the scene.\n')
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
    expect(await (await call('/api/assistant')).json()).toEqual({ ready: true, github: true, spent: 0, limit: 1, modes: ['assistant'] })
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

  it('is not ready without its instructions, and says which file', async () => {
    rmSync(join(repo, 'ASSISTANT.md'))
    expect(await (await call('/api/assistant')).json()).toMatchObject({ ready: false, why: 'The assistant has no instructions: ASSISTANT.md is missing.' })
    expect((await call('/api/assistant/chats', { method: 'POST' })).status).toBe(503)
  })
})

describe('the editing modes (ADR 0195)', () => {
  /** An assistant over its own server, with this model; `editors` written to the state directory when given. */
  const serve = async (talk: Talk, editors?: string) => {
    if (editors !== undefined) writeFileSync(join(state, 'assistant-editors'), editors)
    const a = createAssistant({ repoRoot: repo, stateDir: state, talk, github })
    const s = createServer((req, res) => void a.handle(req, res, (req.url ?? '').split('?')[0]!, { name: 'Ada', email: 'ada@x.com' }))
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    const post = (path: string, body?: unknown) =>
      fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { at, post, close: () => new Promise<void>((r) => s.close(() => r())) }
  }

  /** A turn's stream, read as it comes: `next(kind)` waits for an event of that kind. */
  const stream = (r: Response) => {
    const reader = r.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const events: { kind: string; [k: string]: unknown }[] = []
    const next = async (kind: string) => {
      for (;;) {
        const found = events.find((e) => e.kind === kind)
        if (found !== undefined) return found
        const { done, value } = await reader.read()
        if (done) throw new Error(`the stream ended before ${kind}`)
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, end).split('\n').find((l) => l.startsWith('data: '))
          buffer = buffer.slice(end + 2)
          if (data !== undefined) events.push(JSON.parse(data.slice(6)))
        }
      }
    }
    return { next, events }
  }

  const RENAME = { name: 'rename_object', description: 'Rename an object.', input_schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } }

  /** A model that renames, then says what it got back; every request kept. */
  const renamer = () => {
    const requests: Parameters<Talk>[0][] = []
    let n = 0
    const talk: Talk = async (request, onText) => {
      requests.push(request)
      const content: Anthropic.ContentBlock[] = n++ === 0 ? [use('t1', 'rename_object', { id: 'n:a', name: 'Crate' })] : [text('Renamed.')]
      for (const b of content) if (b.type === 'text') onText(b.text)
      return { content, usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: n === 1 ? 'tool_use' : 'end_turn' }
    }
    return { talk, requests }
  }

  it('are open only to the emails in assistant-editors, and refused to anyone else', async () => {
    const closed = await serve(renamer().talk)
    expect(((await (await fetch(`${closed.at}/api/assistant`)).json()) as { modes: string[] }).modes).toEqual(['assistant'])
    const { id } = (await (await closed.post('/api/assistant/chats')).json()) as { id: string }
    expect((await closed.post(`/api/assistant/chats/${id}/say`, { text: 'rename it', mode: 'auto', tools: [RENAME] })).status).toBe(403)
    await closed.close()
    const open = await serve(renamer().talk, '# who may edit\nADA@x.com\n')
    expect(((await (await fetch(`${open.at}/api/assistant`)).json()) as { modes: string[] }).modes).toEqual(['assistant', 'confirm', 'auto'])
    await open.close()
  })

  it('hands an editor action to the tab, and carries on with the tab’s answer', async () => {
    const { talk, requests } = renamer()
    const s = await serve(talk, 'ada@x.com')
    const { id } = (await (await s.post('/api/assistant/chats')).json()) as { id: string }
    const turn = stream(await s.post(`/api/assistant/chats/${id}/say`, { text: 'rename it', mode: 'auto', tools: [RENAME] }))
    const call = (await turn.next('call')).call as { id: string; name: string; input: unknown }
    expect(call.name).toBe('rename_object')
    expect(call.input).toEqual({ id: 'n:a', name: 'Crate' })
    expect((await s.post(`/api/assistant/chats/${id}/result/${call.id}`, { outcome: { ok: true, result: null } })).status).toBe(204)
    await turn.next('done')
    expect(requests).toHaveLength(2)
    expect(requests[0]!.tools.map((t) => t.name)).toContain('rename_object')
    expect(requests[0]!.system[0]!.text, 'an editing mode’s own instructions').toBe('Edit the scene.')
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('"tool_use_id":"t1"')
    await s.close()
  })

  it('ends the turn on the person’s no, without asking the model again', async () => {
    const { talk, requests } = renamer()
    const s = await serve(talk, 'ada@x.com')
    const { id } = (await (await s.post('/api/assistant/chats')).json()) as { id: string }
    const turn = stream(await s.post(`/api/assistant/chats/${id}/say`, { text: 'rename it', mode: 'confirm', tools: [RENAME] }))
    const call = (await turn.next('call')).call as { id: string }
    await s.post(`/api/assistant/chats/${id}/result/${call.id}`, { declined: true })
    await turn.next('done')
    expect(requests).toHaveLength(1)
    await s.close()
  })

  it('ends the turn on Stop while a call waits', async () => {
    const { talk, requests } = renamer()
    const s = await serve(talk, 'ada@x.com')
    const { id } = (await (await s.post('/api/assistant/chats')).json()) as { id: string }
    const turn = stream(await s.post(`/api/assistant/chats/${id}/say`, { text: 'rename it', mode: 'confirm', tools: [RENAME] }))
    await turn.next('call')
    expect((await s.post(`/api/assistant/chats/${id}/stop`)).status).toBe(204)
    await turn.next('done')
    expect(requests).toHaveLength(1)
    await s.close()
  })

  it('gives the model a picture of the viewport as an image', async () => {
    const shot = defineShot()
    const { talk, requests } = renamer()
    const s = await serve(talk, 'ada@x.com')
    const { id } = (await (await s.post('/api/assistant/chats')).json()) as { id: string }
    const turn = stream(await s.post(`/api/assistant/chats/${id}/say`, { text: 'look', mode: 'auto', tools: [RENAME] }))
    const call = (await turn.next('call')).call as { id: string }
    await s.post(`/api/assistant/chats/${id}/result/${call.id}`, { outcome: { ok: true, result: shot } })
    await turn.next('done')
    const results = requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(results[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: '{"width":512,"height":288}' },
    ])
    await s.close()
  })
})

const defineShot = () => ({ image: { mediaType: 'image/jpeg', data: 'AAAA' }, width: 512, height: 288 })

describe('the editor’s actions as tools', () => {
  it('keeps what is a tool, and drops a name the server’s own tools have or one that is not a name', () => {
    const tools = editorToolsOf([
      { name: 'rename_object', description: 'Rename.', input_schema: { type: 'object' } },
      { name: 'read_file', description: 'mine now', input_schema: { type: 'object' } },
      { name: 'Bad Name', description: 'x', input_schema: { type: 'object' } },
      { name: 'no_schema', description: 'x' },
    ])
    expect(tools.map((t) => t.name)).toEqual(['rename_object'])
  })

  it('tells the model a declined change ended the turn', () => {
    expect(DECLINED).toContain('turn ended')
  })
})
