import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'

import { runTurn, type AssistantEvent, type Conversation, type Talk } from './agent'
import { createBudget } from './budget'
import type { ToolRun } from './tools'

/**
 * The assistant's turn (ADR 0192): the model and its tools in a loop until it answers, streamed, counted against the
 * person's day — with a scripted model, so nothing here calls Claude.
 */

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null })
const use = (id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } })
const usage = { input_tokens: 1000, output_tokens: 100 }

/** A model that answers from a script, one reply a call, streaming each reply's text. */
const scripted = (replies: (readonly Anthropic.ContentBlock[])[]): { talk: Talk; seen: Anthropic.MessageParam[][]; systems: string[] } => {
  const seen: Anthropic.MessageParam[][] = []
  const systems: string[] = []
  let n = 0
  const talk: Talk = async (request, onText) => {
    seen.push(request.messages)
    systems.push(request.system.map((b) => b.text).join(''))
    const content = replies[n++] ?? [text('…')]
    for (const b of content) if (b.type === 'text') onText(b.text)
    return { content, usage, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }
  }
  return { talk, seen, systems }
}

const chat = (): Conversation => ({ id: 'c', email: 'ada@x.com', name: 'Ada', messages: [], shown: [], drafts: new Map(), filed: new Map(), lastUsed: 0, busy: false })

const turn = async (talk: Talk, run: (name: string, input: Record<string, unknown>) => Promise<ToolRun>, conv = chat(), limit = 1) => {
  const events: AssistantEvent[] = []
  const budget = createBudget({ file: null, limit })
  await runTurn(conv, 'Why does the hazard not kill?', { game: 'keyboard', level: 'World 1', selection: ['Lava (Collider, Hazard)'] }, { instructions: 'Answer from the docs.', talk, run, budget }, (e) => events.push(e))
  return { events, conv, budget }
}

describe('a turn', () => {
  it('searches, reads what it found, and answers — each step shown as it happens', async () => {
    const { talk, seen, systems } = scripted([[text('Let me look.'), use('t1', 'search_repo', { query: 'onContact' })], [text('It kills on contact.')]])
    const ran: string[] = []
    const { events, conv } = await turn(talk, async (name, input) => {
      ran.push(`${name}:${String(input.query)}`)
      return { result: 'src/hazard.ts:10:onContact kills' }
    })
    expect(ran).toEqual(['search_repo:onContact'])
    expect(events.filter((e) => e.kind === 'text').map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['Let me look.', 'It kills on contact.'])
    expect(events.find((e) => e.kind === 'activity')).toEqual({ kind: 'activity', text: 'Searching for “onContact”' })
    expect(events.at(-1)).toEqual({ kind: 'done' })
    // The instructions were the system prompt, every call.
    expect(systems).toEqual(['Answer from the docs.', 'Answer from the docs.'])
    // What the person was looking at went with the message.
    const first = seen[0]![0]!
    const firstText = typeof first.content === 'string' ? first.content : (first.content[0] as Anthropic.TextBlockParam).text
    expect(firstText).toContain('<editor>\ngame: keyboard\nlevel: World 1\nselected: Lava (Collider, Hazard)\n</editor>')
    // The tool's answer went back as the result of that call.
    expect(JSON.stringify(seen[1]!.at(-1))).toContain('"tool_use_id":"t1"')
    expect(conv.shown.map((s) => s.kind)).toEqual(['you', 'assistant', 'activity', 'assistant'])
  })

  it('shows a draft to the person and keeps it for filing', async () => {
    const { talk } = scripted([[use('t1', 'draft_issue', { title: 'Hazard misses', body: 'Steps…' })], [text('Drafted — file it if it looks right.')]])
    const draft = { id: 'd1', kind: 'issue', title: 'Hazard misses', body: 'Steps…', labels: [] } as const
    const { events, conv } = await turn(talk, async () => ({ result: 'Draft d1 is shown.', draft }))
    expect(events.find((e) => e.kind === 'draft')).toEqual({ kind: 'draft', draft })
    expect(conv.drafts.get('d1')).toEqual(draft)
  })

  it('stops for the day once the person’s budget is spent', async () => {
    const { talk } = scripted([[use('t1', 'search_repo', { query: 'x' })], [text('never said')]])
    // 1000 in + 100 out at Haiku's rates is $0.0015 a call: a limit under that ends the turn after one.
    const { events } = await turn(talk, async () => ({ result: 'r' }), chat(), 0.001)
    expect(events.at(-1)).toMatchObject({ kind: 'error' })
    expect(events.some((e) => e.kind === 'text' && e.text === 'never said')).toBe(false)
    const { events: next } = await turn(talk, async () => ({ result: 'r' }), chat(), 0)
    expect(next).toEqual([{ kind: 'error', message: "Today's $0.00 is used up. The assistant is back tomorrow (UTC)." }])
  })

  it('takes a failed turn back out, so the next one starts clean', async () => {
    const talk: Talk = async () => {
      throw new Error('overloaded')
    }
    const { events, conv } = await turn(talk, async () => ({ result: 'r' }))
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'The assistant failed: overloaded' })
    expect(conv.messages).toEqual([])
    expect(conv.busy).toBe(false)
  })
})
