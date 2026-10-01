// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sseParser } from './assistantApi'
import { createChatWindow } from './chatWindow'
import { escapeHtml } from './markdown'

/**
 * The assistant's chat in the editor (ADR 0192): the stream read as it comes, the model's text made safe, and a turn
 * drawn — its activity, its answer, a draft and the button that files it — against a fake server.
 */

describe('reading a turn as it streams', () => {
  it('hands each whole event on, however the bytes are split', () => {
    const got: [string, string][] = []
    const feed = sseParser((event, data) => got.push([event, data]))
    feed('event: text\ndata: {"kind":"te')
    feed('xt","text":"Hi"}\n\n:keepalive\n\nevent: done\ndata: {"kind":"done"}\n\n')
    expect(got).toEqual([
      ['text', '{"kind":"text","text":"Hi"}'],
      ['done', '{"kind":"done"}'],
    ])
  })
})

/**
 * The cleaning itself is DOMPurify's in a real browser, checked there (Chrome, headless, ADR 0192): this test's DOM
 * runs it and breaks it. Here, the fallback where it cannot run at all — text, never HTML.
 */
describe('the model’s text, made safe', () => {
  it('escapes every character that could open a tag or an entity', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;')
  })
})

describe('a turn in the chat', () => {
  const sse = (events: object[]): string => events.map((e) => `event: ${(e as { kind: string }).kind}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  let filed: string[] = []

  beforeEach(() => {
    filed = []
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (url === '/api/assistant') return new Response(JSON.stringify({ ready: true, github: true, spent: 0.1, limit: 1 }))
      if (url === '/api/assistant/chats' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'a'.repeat(32) }))
      if (url.endsWith('/say'))
        return new Response(
          sse([
            { kind: 'activity', text: 'Reading docs/INDEX.md' },
            { kind: 'text', text: 'The **hazard** ' },
            { kind: 'text', text: 'missed you.' },
            { kind: 'draft', draft: { id: 'd1', kind: 'issue', title: 'Hazard misses riders', body: 'Steps…', labels: ['bug'] } },
            { kind: 'spent', spent: 0.12, limit: 1 },
            { kind: 'done' },
          ]),
        )
      if (url.includes('/file/')) {
        filed.push(url)
        return new Response(JSON.stringify({ url: 'https://github.com/o/r/issues/12' }))
      }
      return new Response('{}', { status: 404 })
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('sends with Enter, draws the turn, and files the draft only on the click', async () => {
    const root = document.createElement('div')
    document.body.replaceChildren(root)
    createChatWindow({ root, context: async () => ({ game: 'keyboard' }) })
    await settle()
    expect(root.querySelector('.asst-spent')!.textContent).toBe('$0.10 of $1.00 today')

    const input = root.querySelector<HTMLTextAreaElement>('.asst-in')!
    input.value = 'Why did the hazard miss me?'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    await settle()

    expect(root.querySelector('.asst-you')!.textContent).toBe('Why did the hazard miss me?')
    expect(root.querySelector('.asst-act')!.textContent).toBe('Reading docs/INDEX.md')
    expect(root.querySelector('.asst-ai')!.textContent).toContain('hazard')
    expect(root.querySelector('.asst-draft-t')!.textContent).toBe('Hazard misses riders')
    expect(root.querySelector('.asst-spent')!.textContent).toBe('$0.12 of $1.00 today')
    expect(filed, 'nothing filed before the click').toEqual([])

    root.querySelector<HTMLButtonElement>('.asst-file')!.click()
    await settle()
    expect(filed).toEqual([`/api/assistant/chats/${'a'.repeat(32)}/file/d1`])
    expect(root.querySelector<HTMLAnchorElement>('.asst-filed')!.href).toBe('https://github.com/o/r/issues/12')
  })

  it('says so when the assistant is not set up, and takes nothing typed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ready: false, why: 'The assistant is not set up on this server yet.', github: false, spent: 0, limit: 1 })))
    const root = document.createElement('div')
    createChatWindow({ root, context: async () => ({}) })
    await settle()
    expect(root.querySelector('.asst-err')!.textContent).toBe('The assistant is not set up on this server yet.')
    expect(root.querySelector<HTMLTextAreaElement>('.asst-in')!.disabled).toBe(true)
  })
})
